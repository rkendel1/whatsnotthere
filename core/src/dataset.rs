use crate::artifact::{hash_string, stable_stringify};
use crate::network::normalize_endpoint;
use crate::observation::ObservationEnvelope;
use crate::schema::infer_schema_from_values;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use url::Url;

#[derive(Default)]
struct CollectionAccumulator {
    name: String,
    method: String,
    url: String,
    items: Vec<Value>,
    pages: Vec<Value>,
    observation_ids: Vec<String>,
    pagination_samples: Vec<Value>,
    field_evidence: BTreeMap<String, Vec<Value>>,
}

fn collect_field_evidence(
    value: &Value,
    field_prefix: &str,
    json_path: &str,
    observation_id: &str,
    evidence: &mut BTreeMap<String, Vec<Value>>,
) {
    let Some(object) = value.as_object() else {
        return;
    };
    for (name, field_value) in object {
        let field = if field_prefix.is_empty() {
            name.clone()
        } else {
            format!("{field_prefix}.{name}")
        };
        let path = format!("{json_path}.{name}");
        evidence.entry(field.clone()).or_default().push(json!({
            "observationId": observation_id,
            "jsonPath": path,
            "value": field_value
        }));
        collect_field_evidence(field_value, &field, &path, observation_id, evidence);
    }
}

fn parse_body(observation: &ObservationEnvelope) -> Option<Value> {
    serde_json::from_str(observation.body.as_deref()?).ok()
}

fn find_collection(body: &Value) -> Option<(String, Vec<Value>)> {
    fn candidates(value: &Value, path: &str, output: &mut Vec<(String, Vec<Value>)>) {
        match value {
            Value::Array(items) => {
                let objects = items
                    .iter()
                    .filter(|item| item.is_object())
                    .cloned()
                    .collect::<Vec<_>>();
                if !objects.is_empty() {
                    output.push((
                        if path.is_empty() { "items" } else { path }.to_string(),
                        objects,
                    ));
                }
                for item in items.iter().take(5) {
                    candidates(item, path, output);
                }
            }
            Value::Object(object) => {
                for (key, child) in object {
                    let child_path = if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{path}.{key}")
                    };
                    candidates(child, &child_path, output);
                }
            }
            _ => {}
        }
    }

    let mut found = Vec::new();
    candidates(body, "", &mut found);
    found.into_iter().max_by_key(|(_, items)| {
        let fields = items
            .first()
            .and_then(Value::as_object)
            .map(Map::len)
            .unwrap_or(0);
        items.len() * fields.max(1)
    })
}

fn collection_name(key: &str, url: Option<&str>) -> String {
    if key != "items" {
        return key.rsplit('.').next().unwrap_or(key).to_string();
    }
    url.and_then(|raw| Url::parse(raw).ok())
        .and_then(|parsed| {
            parsed
                .path_segments()?
                .rfind(|part| !part.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "items".to_string())
}

fn identity_field(items: &[Value]) -> (Option<String>, f64) {
    let mut candidates: BTreeMap<String, (usize, BTreeSet<String>)> = BTreeMap::new();
    for item in items {
        let Some(object) = item.as_object() else {
            continue;
        };
        for (key, value) in object {
            if value.is_null() || value.is_object() || value.is_array() {
                continue;
            }
            let lower = key.to_lowercase();
            let looks_like_id = lower == "id"
                || lower.ends_with("_id")
                || lower.ends_with("id")
                || lower.contains("uuid")
                || lower.contains("slug");
            if looks_like_id {
                let entry = candidates.entry(key.clone()).or_default();
                entry.0 += 1;
                entry.1.insert(stable_stringify(value));
            }
        }
    }
    candidates
        .into_iter()
        .map(|(field, (present, unique))| {
            let coverage = present as f64 / items.len().max(1) as f64;
            let uniqueness = unique.len() as f64 / present.max(1) as f64;
            let name_bonus = if field.eq_ignore_ascii_case("id") {
                0.08
            } else {
                0.0
            };
            (
                field,
                (0.55 * coverage + 0.37 * uniqueness + name_bonus).min(1.0),
            )
        })
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .map(|(field, confidence)| (Some(field), (confidence * 100.0).round() / 100.0))
        .unwrap_or((None, 0.0))
}

fn cursor_value(body: &Value) -> Option<(&'static str, Value)> {
    ["nextCursor", "cursor", "nextPageToken", "endCursor"]
        .into_iter()
        .find_map(|key| {
            body.get(key)
                .filter(|value| !value.is_null())
                .cloned()
                .map(|value| (key, value))
        })
}

fn pagination(observation: &ObservationEnvelope, body: &Value) -> Value {
    let query_cursor = observation
        .url
        .as_deref()
        .and_then(|raw| Url::parse(raw).ok())
        .and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| {
                    matches!(
                        key.as_ref(),
                        "cursor" | "after" | "nextCursor" | "pageToken"
                    )
                })
                .map(|(key, value)| json!({"field": key, "value": value}))
        });
    let response_cursor = cursor_value(body);
    if query_cursor.is_some() || response_cursor.is_some() {
        let request_field = query_cursor
            .as_ref()
            .and_then(|cursor| cursor.get("field"))
            .and_then(Value::as_str)
            .unwrap_or("cursor");
        let next_request = response_cursor.as_ref().and_then(|(_, value)| {
            let raw_url = observation.url.as_deref()?;
            let mut url = Url::parse(raw_url).ok()?;
            let rendered = value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string());
            let existing = url
                .query_pairs()
                .filter(|(key, _)| key != request_field)
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect::<Vec<_>>();
            url.set_query(None);
            {
                let mut query = url.query_pairs_mut();
                for (key, value) in existing {
                    query.append_pair(&key, &value);
                }
                query.append_pair(request_field, &rendered);
            }
            Some(json!({"method": "GET", "url": url.as_str(), "cursorField": request_field, "cursor": value}))
        });
        return json!({
            "detected": true,
            "type": "cursor",
            "cursorField": response_cursor.as_ref().map(|(field, _)| *field).unwrap_or("cursor"),
            "requestCursor": query_cursor,
            "nextCursor": response_cursor.map(|(_, value)| value),
            "nextRequest": next_request,
            "confidence": if query_cursor.is_some() && cursor_value(body).is_some() { 0.97 } else { 0.86 }
        });
    }
    json!({"detected": false, "type": null, "cursorField": null, "confidence": 0.0})
}

fn deduplicate(items: &[Value], identity: Option<&str>) -> (Vec<Value>, usize) {
    let mut unique = BTreeMap::new();
    for item in items {
        let key = identity
            .and_then(|field| item.get(field))
            .filter(|value| !value.is_null())
            .map(stable_stringify)
            .unwrap_or_else(|| stable_stringify(item));
        unique
            .entry(key)
            .and_modify(|existing| merge_objects(existing, item))
            .or_insert_with(|| item.clone());
    }
    let duplicate_count = items.len().saturating_sub(unique.len());
    (unique.into_values().collect(), duplicate_count)
}

fn merge_objects(existing: &mut Value, newer: &Value) {
    let (Some(target), Some(source)) = (existing.as_object_mut(), newer.as_object()) else {
        return;
    };
    for (key, value) in source {
        if !value.is_null() {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn singular(name: &str) -> String {
    let lower = name.to_lowercase();
    if let Some(stem) = lower.strip_suffix("ies") {
        return format!("{stem}y");
    }
    lower.strip_suffix('s').unwrap_or(&lower).to_string()
}

fn resolve_detail_entities(items: &mut [Value], detail_entities: &BTreeMap<String, Vec<Value>>) {
    for item in items {
        let Some(fields) = item.as_object_mut() else {
            continue;
        };
        for (name, nested) in fields {
            let Some(nested_object) = nested.as_object() else {
                continue;
            };
            let Some((identity_field, identity)) = nested_object.iter().find(|(key, value)| {
                let lower = key.to_lowercase();
                !value.is_null()
                    && (lower == "id"
                        || lower.ends_with("_id")
                        || lower.contains("uuid")
                        || lower.contains("slug"))
            }) else {
                continue;
            };
            let Some((_, candidates)) = detail_entities
                .iter()
                .find(|(target, _)| singular(target) == singular(name))
            else {
                continue;
            };
            if let Some(detail) = candidates
                .iter()
                .find(|candidate| candidate.get(identity_field) == Some(identity))
            {
                merge_objects(nested, detail);
            }
        }
    }
}

fn relationships(
    schema: &Value,
    detail_entities: &BTreeMap<String, Vec<Value>>,
    observation_ids: &[String],
) -> Vec<Value> {
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return vec![];
    };
    properties
        .iter()
        .filter_map(|(name, field_schema)| {
            let inner = field_schema.get("properties").and_then(Value::as_object)?;
            let identity = inner.keys().find(|key| {
                let lower = key.to_lowercase();
                lower == "id"
                    || lower.ends_with("_id")
                    || lower.contains("uuid")
                    || lower.contains("slug")
            })?;
            let target = detail_entities.keys().find(|candidate| {
                candidate.eq_ignore_ascii_case(name)
                    || singular(candidate).eq_ignore_ascii_case(&singular(name))
            });
            Some(json!({
                "name": name,
                "kind": "object",
                "identityField": identity,
                "target": target,
                "confidence": if target.is_some() { 0.96 } else { 0.88 },
                "evidence": observation_ids
            }))
        })
        .collect()
}

fn detail_entities(observations: &[&ObservationEnvelope]) -> BTreeMap<String, Vec<Value>> {
    let mut entities: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for observation in observations {
        let Some(body) = parse_body(observation) else {
            continue;
        };
        if find_collection(&body).is_some() || !body.is_object() {
            continue;
        }
        let Some(url) = observation
            .url
            .as_deref()
            .and_then(|raw| Url::parse(raw).ok())
        else {
            continue;
        };
        let segments = url
            .path_segments()
            .map(|parts| parts.filter(|part| !part.is_empty()).collect::<Vec<_>>())
            .unwrap_or_default();
        if segments.len() >= 2 {
            entities
                .entry(segments[segments.len() - 2].to_string())
                .or_default()
                .push(body);
        }
    }
    entities
}

pub fn reconstruct_datasets(observations: &[&ObservationEnvelope]) -> Value {
    let entities = detail_entities(observations);
    let mut groups: BTreeMap<String, CollectionAccumulator> = BTreeMap::new();
    let mut evidence = Vec::new();

    for (index, observation) in observations.iter().enumerate() {
        let Some(body) = parse_body(observation) else {
            continue;
        };
        let Some((key, items)) = find_collection(&body) else {
            continue;
        };
        let name = collection_name(&key, observation.url.as_deref());
        let url = normalize_endpoint(observation.url.as_deref().unwrap_or_default());
        let method = observation
            .method
            .clone()
            .unwrap_or_else(|| "GET".to_string());
        let observation_id = format!(
            "obs-{}",
            hash_string(&format!(
                "{}:{}:{}:{}",
                index,
                method,
                observation.url.as_deref().unwrap_or_default(),
                observation.timestamp.unwrap_or_default()
            ))
        );
        let page = pagination(observation, &body);
        let group = groups.entry(format!("{method}:{url}:{name}")).or_default();
        group.name = name;
        group.method = method.clone();
        group.url = url.clone();
        group.items.extend(items.clone());
        group.observation_ids.push(observation_id.clone());
        group.pagination_samples.push(page.clone());
        for (item_index, item) in items.iter().enumerate() {
            collect_field_evidence(
                item,
                "",
                &format!("$.{key}[{item_index}]"),
                &observation_id,
                &mut group.field_evidence,
            );
        }
        group.pages.push(json!({
            "observationId": observation_id,
            "request": {"method": method, "url": observation.url},
            "response": {"status": observation.status},
            "itemCount": items.len(),
            "continuation": page
        }));
        evidence.push(json!({
            "id": observation_id,
            "kind": "network.response",
            "timestamp": observation.timestamp,
            "source": observation.source,
            "method": method,
            "url": observation.url,
            "normalizedUrl": url,
            "collectionPath": key,
            "itemCount": items.len()
        }));
    }

    let mut datasets = Vec::new();
    for (_, group) in groups {
        let (identity, identity_confidence) = identity_field(&group.items);
        let (mut items, duplicates) = deduplicate(&group.items, identity.as_deref());
        resolve_detail_entities(&mut items, &entities);
        let schema = infer_schema_from_values(&items);
        let fields = schema
            .get("properties")
            .and_then(Value::as_object)
            .map(Map::len)
            .unwrap_or(0);
        let relations = relationships(&schema, &entities, &group.observation_ids);
        let mut pagination_model = group
            .pagination_samples
            .iter()
            .find(|model| model["detected"] == true)
            .cloned()
            .unwrap_or_else(
                || json!({"detected": false, "type": null, "cursorField": null, "confidence": 0.0}),
            );
        if let Some(object) = pagination_model.as_object_mut() {
            let next_request = group
                .pagination_samples
                .last()
                .and_then(|model| model.get("nextRequest"))
                .cloned()
                .unwrap_or(Value::Null);
            object.insert("nextRequest".to_string(), next_request);
        }
        let relationship_confidence = if relations.is_empty() {
            0.0
        } else {
            relations
                .iter()
                .map(|item| item["confidence"].as_f64().unwrap_or(0.0))
                .sum::<f64>()
                / relations.len() as f64
        };
        let collection_confidence = (0.30
            + if identity.is_some() { 0.25 } else { 0.0 }
            + if pagination_model["detected"] == true {
                0.20
            } else {
                0.0
            }
            + if !relations.is_empty() { 0.10 } else { 0.0 }
            + if group.pages.len() > 1 { 0.10 } else { 0.0 }
            + if items.len() >= 10 { 0.05 } else { 0.0_f64 })
        .min(0.99_f64);
        let dataset_kind = if collection_confidence >= 0.60 {
            "entityCollection"
        } else {
            "structuredArray"
        };
        let dataset_confidence = json!({
            "collection": collection_confidence,
            "identity": identity_confidence,
            "pagination": pagination_model["confidence"],
            "relationships": relationship_confidence
        });
        let field_provenance = group
            .field_evidence
            .iter()
            .map(|(field, occurrences)| {
                let numeric_values = occurrences
                    .iter()
                    .filter_map(|item| item.get("value").and_then(Value::as_f64))
                    .collect::<Vec<_>>();
                let numeric_range = (!numeric_values.is_empty()).then(|| {
                    json!({
                        "min": numeric_values.iter().copied().fold(f64::INFINITY, f64::min),
                        "max": numeric_values.iter().copied().fold(f64::NEG_INFINITY, f64::max)
                    })
                });
                (
                    field.clone(),
                    json!({
                        "observed": occurrences.len(),
                        "numericRange": numeric_range,
                        "evidence": occurrences
                    }),
                )
            })
            .collect::<Map<String, Value>>();
        let dataset_id = format!(
            "dataset-{}",
            hash_string(&format!("{}:{}:{}", group.method, group.url, group.name))
        );
        let provenance = json!({"observations": group.observation_ids, "fields": field_provenance});
        let manifest = json!({"datasetId": dataset_id, "name": group.name, "items": items.len(), "pages": group.pages.len()});
        let dataset_evidence = evidence
            .iter()
            .filter(|item| {
                item["id"]
                    .as_str()
                    .map(|id| {
                        group
                            .observation_ids
                            .iter()
                            .any(|candidate| candidate == id)
                    })
                    .unwrap_or(false)
            })
            .cloned()
            .collect::<Vec<_>>();
        let dataset_jsonl = items
            .iter()
            .map(stable_stringify)
            .collect::<Vec<_>>()
            .join("\n");
        let observations_jsonl = dataset_evidence
            .iter()
            .map(stable_stringify)
            .collect::<Vec<_>>()
            .join("\n");
        let artifact_body = json!({
            "format": "xray.dataset.v1",
            "manifest": manifest,
            "dataset.jsonl": items,
            "schema.json": schema,
            "relationships.json": relations,
            "observations.jsonl": dataset_evidence,
            "provenance.json": provenance,
            "confidence.json": dataset_confidence,
            "files": {
                "manifest.json": stable_stringify(&manifest),
                "dataset.jsonl": dataset_jsonl,
                "schema.json": stable_stringify(&schema),
                "relationships.json": stable_stringify(&Value::Array(relations.clone())),
                "observations.jsonl": observations_jsonl,
                "provenance.json": stable_stringify(&provenance),
                "confidence.json": stable_stringify(&dataset_confidence)
            }
        });
        let artifact = json!({
            "artifactId": hash_string(&stable_stringify(&artifact_body)),
            "format": artifact_body["format"],
            "manifest": artifact_body["manifest"],
            "dataset.jsonl": artifact_body["dataset.jsonl"],
            "schema.json": artifact_body["schema.json"],
            "relationships.json": artifact_body["relationships.json"],
            "observations.jsonl": artifact_body["observations.jsonl"],
            "provenance.json": artifact_body["provenance.json"],
            "confidence.json": artifact_body["confidence.json"],
            "files": artifact_body["files"]
        });
        datasets.push(json!({
            "id": dataset_id,
            "name": group.name,
            "kind": dataset_kind,
            "source": {"method": group.method, "url": group.url},
            "observedItems": items.len(),
            "rawObservedItems": group.items.len(),
            "duplicateItems": duplicates,
            "pagesObserved": group.pages.len(),
            "pages": group.pages,
            "fields": fields,
            "schema": schema,
            "identity": {"field": identity, "confidence": identity_confidence, "evidence": group.observation_ids},
            "pagination": pagination_model,
            "relationships": relations,
            "items": items,
            "preview": items.iter().take(5).cloned().collect::<Vec<_>>(),
            "provenance": provenance,
            "reconstructionArtifact": artifact,
            "confidence": dataset_confidence
        }));
    }
    let total = datasets
        .iter()
        .filter_map(|dataset| dataset["observedItems"].as_u64())
        .sum::<u64>();
    json!({
        "datasets": datasets,
        "observations": evidence,
        "summary": {"collections": datasets.len(), "totalObservedItems": total}
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn observation(url: &str, timestamp: u64, body: Value) -> ObservationEnvelope {
        serde_json::from_value(json!({
            "kind": "network.response",
            "timestamp": timestamp,
            "method": "GET",
            "url": url,
            "status": 200,
            "headers": {"content-type": "application/json"},
            "body": serde_json::to_string(&body).unwrap()
        }))
        .unwrap()
    }

    #[test]
    fn merges_pages_deduplicates_entities_and_preserves_evidence() {
        let first = observation(
            "https://example.test/api/jobs?cursor=one",
            1,
            json!({"jobs": [
                {"id": "1", "title": "Engineer", "company": {"id": "c1", "name": "Acme"}},
                {"id": "2", "title": "Designer"}
            ], "nextCursor": "two"}),
        );
        let second = observation(
            "https://example.test/api/jobs?cursor=two",
            2,
            json!({"jobs": [
                {"id": "2", "title": "Senior Designer", "salary": 150000},
                {"id": "3", "title": "Writer"}
            ]}),
        );
        let company = observation(
            "https://example.test/api/companies/c1",
            3,
            json!({"id": "c1", "name": "Acme", "industry": "Software"}),
        );
        let observations = vec![&first, &second, &company];

        let result = reconstruct_datasets(&observations);
        let dataset = &result["datasets"][0];

        assert_eq!(dataset["rawObservedItems"], 4);
        assert_eq!(dataset["kind"], "entityCollection");
        assert!(dataset["confidence"]["collection"].as_f64().unwrap() > 0.9);
        assert_eq!(dataset["observedItems"], 3);
        assert_eq!(dataset["duplicateItems"], 1);
        assert_eq!(dataset["pagesObserved"], 2);
        assert_eq!(dataset["schema"]["properties"]["salary"]["observed"], 1);
        assert_eq!(dataset["schema"]["properties"]["salary"]["required"], false);
        assert_eq!(dataset["relationships"][0]["target"], "companies");
        assert_eq!(dataset["relationships"][0]["confidence"], 0.96);
        assert_eq!(dataset["items"][0]["company"]["industry"], "Software");
        assert_eq!(
            dataset["pages"][0]["continuation"]["nextRequest"]["url"],
            "https://example.test/api/jobs?cursor=two"
        );
        assert_eq!(
            dataset["reconstructionArtifact"]["format"],
            "xray.dataset.v1"
        );
        assert_eq!(
            dataset["reconstructionArtifact"]["dataset.jsonl"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            dataset["provenance"]["fields"]["title"]["evidence"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        assert_eq!(
            dataset["provenance"]["fields"]["salary"]["numericRange"]["min"],
            150000.0
        );
        assert_eq!(
            dataset["provenance"]["fields"]["salary"]["evidence"][0]["jsonPath"],
            "$.jobs[0].salary"
        );
    }

    #[test]
    fn discovers_collections_nested_inside_response_envelopes() {
        let response = observation(
            "https://example.test/graphql",
            1,
            json!({"data": {"search": {"jobs": [
                {"id": "1", "title": "Engineer"},
                {"id": "2", "title": "Designer"}
            ]}}}),
        );
        let observations = vec![&response];
        let result = reconstruct_datasets(&observations);

        assert_eq!(result["datasets"][0]["name"], "jobs");
        assert_eq!(result["datasets"][0]["observedItems"], 2);
        assert_eq!(
            result["datasets"][0]["provenance"]["fields"]["title"]["evidence"][0]["jsonPath"],
            "$.data.search.jobs[0].title"
        );
    }
}
