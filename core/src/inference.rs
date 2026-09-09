use crate::artifact::build_deterministic_artifact;
use crate::capability::infer_capabilities;
use crate::confidence::confidence_score;
use crate::dom::extract_invisible_content;
use crate::integration::detect_integrations;
use crate::network::{endpoint_from_observation, Endpoint};
use crate::observation::{AnalyzeRequest, ObservationEnvelope};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use url::Url;

const FLAG_PATTERNS: [&str; 6] = [
    "feature",
    "flag",
    "experiment",
    "rollout",
    "beta",
    "darklaunch",
];

fn normalize_flag_key(key: &str) -> String {
    key.replace(['_', '-'], "").to_lowercase()
}

fn is_flag_key(key: &str) -> bool {
    let normalized = normalize_flag_key(key);
    FLAG_PATTERNS
        .iter()
        .any(|pattern| normalized.contains(pattern))
}

fn detect_feature_flags(snapshot: &Value) -> Vec<Value> {
    let mut dedup: BTreeMap<String, Value> = BTreeMap::new();

    for (source_key, payload_key) in [
        ("localStorage", "localStorageData"),
        ("sessionStorage", "sessionStorageData"),
        ("globals", "globalCandidates"),
    ] {
        if let Some(payload) = snapshot.get(payload_key).and_then(Value::as_object) {
            for (key, value) in payload {
                if is_flag_key(key) {
                    let dedup_key = format!("{source_key}:{key}");
                    dedup.insert(
                        dedup_key,
                        json!({"source": source_key, "key": key, "value": value}),
                    );
                }
            }
        }
    }

    dedup.into_values().collect()
}

fn network_observations(observations: &[ObservationEnvelope]) -> Vec<&ObservationEnvelope> {
    observations
        .iter()
        .filter(|item| item.kind == "network.response")
        .collect()
}

fn infer_endpoints(observations: &[&ObservationEnvelope]) -> Vec<Endpoint> {
    let mut dedup = BTreeMap::new();
    for observation in observations {
        let endpoint = endpoint_from_observation(observation);
        let key = format!("{}:{}", endpoint.method, endpoint.url);
        dedup.entry(key).or_insert(endpoint);
    }
    dedup.into_values().collect()
}

fn parse_body(body: Option<&String>) -> Option<Value> {
    serde_json::from_str::<Value>(body?.as_str()).ok()
}

fn find_collection(body: &Value) -> Option<(String, Vec<Value>)> {
    if let Some(items) = body.as_array() {
        let objects: Vec<Value> = items
            .iter()
            .filter(|item| item.is_object())
            .cloned()
            .collect();
        if !objects.is_empty() {
            return Some(("items".to_string(), objects));
        }
    }

    let obj = body.as_object()?;
    for (key, value) in obj {
        if let Some(items) = value.as_array() {
            let objects: Vec<Value> = items
                .iter()
                .filter(|item| item.is_object())
                .cloned()
                .collect();
            if !objects.is_empty() {
                return Some((key.clone(), objects));
            }
        }
    }

    None
}

fn infer_identity(items: &[Value]) -> Value {
    let Some(first) = items.first().and_then(Value::as_object) else {
        return json!({"field": null, "confidence": 0.0});
    };

    for key in first.keys() {
        let lower = key.to_lowercase();
        if lower == "id"
            || lower.ends_with("_id")
            || lower.contains("uuid")
            || lower.contains("slug")
        {
            let present = items
                .iter()
                .filter(|item| item.get(key).map(|v| !v.is_null()).unwrap_or(false))
                .count();
            let confidence = (0.6 + (present as f64 / items.len() as f64) * 0.4f64).min(1.0);
            return json!({"field": key, "confidence": ((confidence * 100.0).round() / 100.0)});
        }
    }

    json!({"field": null, "confidence": 0.0})
}

fn infer_relationships(item_schema: &Value) -> Vec<Value> {
    let mut relationships = Vec::new();
    let Some(properties) = item_schema.get("properties").and_then(Value::as_object) else {
        return relationships;
    };

    for (name, schema) in properties {
        if schema.get("type").and_then(Value::as_str) == Some("object") {
            if let Some(inner) = schema.get("properties").and_then(Value::as_object) {
                if let Some(identity) = inner.keys().find(|key| {
                    let lower = key.to_lowercase();
                    lower == "id"
                        || lower.ends_with("_id")
                        || lower.contains("uuid")
                        || lower.contains("slug")
                }) {
                    relationships.push(json!({
                        "name": name,
                        "kind": "object",
                        "identityField": identity,
                        "confidence": 0.88
                    }));
                }
            }
        }
    }

    relationships
}

fn infer_pagination(observation: &ObservationEnvelope, body: &Value) -> Value {
    let parsed = observation
        .url
        .as_deref()
        .and_then(|url| Url::parse(url).ok());
    let query = parsed.as_ref().map(Url::query_pairs);

    let has_cursor_query = query
        .map(|pairs| {
            pairs.into_owned().any(|(key, _)| {
                matches!(
                    key.as_str(),
                    "cursor" | "after" | "nextCursor" | "pageToken"
                )
            })
        })
        .unwrap_or(false);

    let has_cursor_response = body
        .as_object()
        .map(|obj| {
            obj.contains_key("nextCursor")
                || obj.contains_key("cursor")
                || obj.contains_key("nextPageToken")
                || obj.contains_key("endCursor")
        })
        .unwrap_or(false);

    if has_cursor_query || has_cursor_response {
        let cursor_field = body
            .as_object()
            .and_then(|obj| {
                ["nextCursor", "cursor", "nextPageToken", "endCursor"]
                    .iter()
                    .find(|key| obj.contains_key(**key))
                    .copied()
            })
            .or_else(|| {
                if has_cursor_query {
                    Some("cursor")
                } else {
                    None
                }
            });
        return json!({
            "detected": true,
            "type": "cursor",
            "cursorField": cursor_field,
            "confidence": if has_cursor_query && has_cursor_response { 0.97 } else { 0.86 }
        });
    }

    json!({"detected": false, "type": null, "cursorField": null, "confidence": 0.0})
}

fn infer_collection_name(name: &str, url: Option<&str>) -> String {
    if name != "items" {
        return name.to_string();
    }
    let Some(parsed) = url.and_then(|raw| Url::parse(raw).ok()) else {
        return "items".to_string();
    };
    parsed
        .path_segments()
        .and_then(|segments| {
            segments
                .filter(|segment| !segment.is_empty())
                .last()
                .map(str::to_string)
        })
        .unwrap_or_else(|| "items".to_string())
}

fn reconstruct_datasets(observations: &[&ObservationEnvelope]) -> Value {
    let mut dedup: BTreeMap<String, Value> = BTreeMap::new();

    for observation in observations {
        let Some(parsed_body) = parse_body(observation.body.as_ref()) else {
            continue;
        };
        let Some((collection_key, items)) = find_collection(&parsed_body) else {
            continue;
        };
        if items.is_empty() {
            continue;
        }

        let dataset_name = infer_collection_name(&collection_key, observation.url.as_deref());
        let normalized_url =
            crate::network::normalize_endpoint(observation.url.as_deref().unwrap_or_default());
        let method = observation
            .method
            .clone()
            .unwrap_or_else(|| "GET".to_string());
        let dedup_key = format!("{method}:{normalized_url}:{dataset_name}");
        let schema = crate::schema::infer_schema(items.first().unwrap_or(&Value::Null), 0);
        let identity = infer_identity(&items);
        let pagination = infer_pagination(observation, &parsed_body);
        let relationships = infer_relationships(&schema);
        let fields = schema
            .get("properties")
            .and_then(Value::as_object)
            .map(|props| props.len())
            .unwrap_or(0);

        let entry = dedup.entry(dedup_key).or_insert_with(|| {
                json!({
                    "name": dataset_name,
                    "source": {"method": method, "url": normalized_url},
                    "observedItems": 0,
                    "fields": fields,
                    "schema": schema,
                    "identity": identity,
                    "pagination": pagination,
                    "relationships": relationships,
                    "preview": [],
                    "confidence": {
                        "collection": 0.99,
                        "pagination": pagination.get("confidence").cloned().unwrap_or_else(|| json!(0.0)),
                        "identity": identity.get("confidence").cloned().unwrap_or_else(|| json!(0.0)),
                        "relationships": if relationships.is_empty() { 0.0 } else { 0.88 }
                    }
                })
            });

        let current_count = entry
            .get("observedItems")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        entry["observedItems"] = json!(current_count + items.len() as u64);

        if let Some(preview) = entry.get_mut("preview").and_then(Value::as_array_mut) {
            for item in items.iter().take(5usize.saturating_sub(preview.len())) {
                preview.push(item.clone());
            }
        }
    }

    let datasets: Vec<Value> = dedup.into_values().collect();
    let total: usize = datasets
        .iter()
        .filter_map(|dataset| dataset.get("observedItems").and_then(Value::as_u64))
        .map(|count| count as usize)
        .sum();

    json!({
        "datasets": datasets,
        "summary": {
            "collections": datasets.len(),
            "totalObservedItems": total
        }
    })
}
pub fn analyze_request(request: AnalyzeRequest) -> Value {
    let network = network_observations(&request.observations);
    let endpoints = infer_endpoints(&network);
    let endpoint_values: Vec<Value> = endpoints
        .iter()
        .map(|endpoint| {
            json!({
                "method": endpoint.method,
                "url": endpoint.url,
                "status": endpoint.status,
                "contentType": endpoint.content_type,
                "schema": endpoint.schema
            })
        })
        .collect();

    let hidden_contracts: Vec<Value> = endpoint_values
        .iter()
        .filter(|endpoint| !endpoint.get("schema").unwrap_or(&Value::Null).is_null())
        .cloned()
        .collect();

    let network_urls: Vec<String> = network
        .iter()
        .filter_map(|item| item.url.clone())
        .filter(|url| !url.is_empty())
        .collect();

    let feature_flags = detect_feature_flags(&request.snapshot);
    let confidence = confidence_score(
        endpoint_values.len(),
        feature_flags.len(),
        hidden_contracts.len(),
    );

    let mut report = json!({
        "tabId": request.tab_id,
        "discoveredAt": request.discovered_at,
        "endpoints": endpoint_values,
        "hiddenDataContracts": hidden_contracts,
        "featureFlags": feature_flags,
        "invisibleContent": extract_invisible_content(&request.snapshot),
        "behavioralScripts": request
            .snapshot
            .get("behavioralScripts")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "integrations": detect_integrations(&network_urls),
        "confidence": confidence,
        "structuredExtraction": reconstruct_datasets(&network),
    });

    let capability_model = infer_capabilities(&report);
    report["capabilityModel"] = capability_model;

    let artifact = build_deterministic_artifact(&report);
    report["deterministicArtifact"] = artifact;

    let feature_flags_array = report
        .get("featureFlags")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let replay_flags: Vec<Value> = feature_flags_array
        .into_iter()
        .filter_map(|flag| {
            let key = flag.get("key")?.as_str()?.to_string();
            let value = flag.get("value").cloned().unwrap_or(Value::Null);
            let value_json = serde_json::to_string(&value).ok()?;
            Some(json!({
                "key": key,
                "command": format!("localStorage.setItem('{}', JSON.stringify({}));", key, value_json)
            }))
        })
        .collect();

    report["localReplay"] = json!({"featureFlags": replay_flags});
    report["connectors"] = json!({
        "slack": {
            "summaryTemplate": format!(
                "Hidden API endpoints discovered: {}",
                report
                    .get("endpoints")
                    .and_then(Value::as_array)
                    .map(|items| {
                        let urls: Vec<String> = items
                            .iter()
                            .filter_map(|endpoint| endpoint.get("url").and_then(Value::as_str).map(str::to_string))
                            .collect();
                        if urls.is_empty() { "none".to_string() } else { urls.join(", ") }
                    })
                    .unwrap_or_else(|| "none".to_string())
            )
        },
        "notion": {"fields": ["url", "method", "status", "schema"]},
        "sheets": {"headers": ["url", "method", "status", "contentType", "schemaType"]}
    });

    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observation::AnalyzeRequest;

    #[test]
    fn reconstructs_structured_collections_with_pagination_and_relationships() {
        let request: AnalyzeRequest = serde_json::from_value(json!({
            "tabId": 11,
            "discoveredAt": "2026-01-01T00:00:00.000Z",
            "observations": [{
                "kind": "network.response",
                "method": "GET",
                "url": "https://jobs.example.com/api/jobs?cursor=abc",
                "status": 200,
                "headers": {"content-type": "application/json"},
                "body": "{\"jobs\":[{\"id\":\"job-1\",\"title\":\"Senior Engineer\",\"company\":{\"id\":\"co-1\",\"name\":\"Acme\"},\"location\":\"Boston\"}],\"nextCursor\":\"def\"}"
            }],
            "snapshot": {}
        }))
        .expect("test observation payload should deserialize");

        let report = analyze_request(request);
        let extraction = &report["structuredExtraction"];
        let dataset = &extraction["datasets"][0];

        assert_eq!(extraction["summary"]["collections"], 1);
        assert_eq!(extraction["summary"]["totalObservedItems"], 1);
        assert_eq!(dataset["name"], "jobs");
        assert_eq!(dataset["identity"]["field"], "id");
        assert_eq!(dataset["pagination"]["type"], "cursor");
        assert_eq!(dataset["pagination"]["cursorField"], "nextCursor");
        assert_eq!(dataset["relationships"][0]["name"], "company");
        assert_eq!(dataset["fields"], 4);
    }
}
