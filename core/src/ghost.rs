use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

use crate::network::normalize_endpoint;
use crate::observation::ObservationEnvelope;

fn field_theme(path: &str) -> (&'static str, &'static str) {
    let lower = path.to_lowercase();
    if lower.contains("rank") || lower.contains("recommend") || lower.contains("score") {
        ("ranking", "ranking or recommendation")
    } else if lower.contains("experiment") || lower.contains("bucket") || lower.contains("variant")
    {
        ("experiment", "experiment or rollout state")
    } else if lower.contains("recruit") || lower.contains("internal") || lower.contains("priority")
    {
        ("internal-state", "internal workflow state")
    } else if lower.ends_with("id") || lower.ends_with(".id") || lower.ends_with("_id") {
        ("identity", "entity identity or linkage")
    } else if lower.contains("track") || lower.contains("session") || lower.contains("analytics") {
        ("tracking", "session or measurement data")
    } else {
        ("unrendered-field", "the surrounding dataset")
    }
}

pub fn analyze_ghost_data(
    extraction: &Value,
    observations: &[&ObservationEnvelope],
    endpoints: &[Value],
    feature_flags: &[Value],
    integrations: &Value,
    snapshot: &Value,
) -> Value {
    let rendered = snapshot
        .get("renderedText")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    let rendered_text_available = !rendered.trim().is_empty();
    let mut ghost_fields = Vec::new();
    let mut visible_fields = BTreeSet::new();
    let mut delivered_fields = BTreeSet::new();
    let mut dataset_endpoints = BTreeSet::new();
    let mut hidden_relationships = Vec::new();

    for dataset in extraction
        .get("datasets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let dataset_name = dataset
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("dataset");
        if let Some(url) = dataset.pointer("/source/url").and_then(Value::as_str) {
            dataset_endpoints.insert(url.to_string());
        }
        for field in dataset
            .pointer("/presentation/visibleFields")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            visible_fields.insert(format!("{dataset_name}.{field}"));
            delivered_fields.insert(format!("{dataset_name}.{field}"));
        }
        let provenance = dataset
            .pointer("/provenance/fields")
            .and_then(Value::as_object);
        for field in dataset
            .pointer("/presentation/machineOnlyFields")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let qualified = format!("{dataset_name}.{field}");
            delivered_fields.insert(qualified);
            let evidence = provenance.and_then(|fields| fields.get(field));
            let occurrences = evidence
                .and_then(|item| item.get("evidence"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            // Container objects are useful schema evidence, but the ghost list is
            // intentionally leaf-oriented so it does not double-count a.b and a.
            let scalar_occurrences = occurrences
                .iter()
                .filter(|item| {
                    item.get("value")
                        .map(|value| !value.is_object() && !value.is_array())
                        .unwrap_or(false)
                })
                .collect::<Vec<_>>();
            if scalar_occurrences.is_empty() {
                continue;
            }
            let observation_ids = scalar_occurrences
                .iter()
                .filter_map(|item| item.get("observationId").and_then(Value::as_str))
                .collect::<BTreeSet<_>>();
            let json_paths = scalar_occurrences
                .iter()
                .filter_map(|item| item.get("jsonPath").and_then(Value::as_str))
                .take(20)
                .collect::<Vec<_>>();
            let samples = scalar_occurrences
                .iter()
                .filter_map(|item| item.get("value"))
                .take(3)
                .cloned()
                .collect::<Vec<_>>();
            let (theme, related_to) = field_theme(field);
            ghost_fields.push(json!({
                "dataset": dataset_name,
                "path": field,
                "qualifiedPath": format!("{dataset_name}.{field}"),
                "theme": theme,
                "received": true,
                "rendered": false,
                "samples": samples,
                "appearsRelatedTo": related_to,
                "confidence": {
                    "received": 1.0,
                    "notRendered": if rendered_text_available { 0.92 } else { 0.55 }
                },
                "evidence": {
                    "occurrences": scalar_occurrences.len(),
                    "responses": observation_ids.len(),
                    "observationIds": observation_ids,
                    "jsonPaths": json_paths,
                    "source": dataset.get("source")
                },
                "caveat": "No matching observed value was found in rendered page text; this does not establish why the server included the field."
            }));
        }
        for relationship in dataset
            .get("relationships")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let name = relationship
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("relationship");
            let identity = relationship
                .get("identityField")
                .and_then(Value::as_str)
                .unwrap_or("id");
            let path = format!("{name}.{identity}");
            if !dataset
                .pointer("/presentation/visibleFields")
                .and_then(Value::as_array)
                .map(|fields| {
                    fields
                        .iter()
                        .any(|field| field.as_str() == Some(path.as_str()))
                })
                .unwrap_or(false)
            {
                hidden_relationships.push(json!({
                    "dataset": dataset_name,
                    "relationship": name,
                    "identityField": identity,
                    "target": relationship.get("target"),
                    "confidence": relationship.get("confidence"),
                    "evidence": relationship.get("evidence")
                }));
            }
        }
    }

    // A page can receive useful singleton/configuration objects without ever
    // receiving an array. Ghost Data must not depend on collection inference.
    {
        let mut response_fields: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        fn visit(value: &Value, path: &str, output: &mut Vec<(String, Value)>) {
            match value {
                Value::Object(object) => {
                    for (key, child) in object {
                        visit(child, &format!("{path}.{key}"), output);
                    }
                }
                Value::Array(items) => {
                    for (index, child) in items.iter().enumerate() {
                        visit(child, &format!("{path}[{index}]"), output);
                    }
                }
                _ => output.push((path.to_string(), value.clone())),
            }
        }
        fn generalized_path(path: &str) -> String {
            let mut result = String::with_capacity(path.len());
            let mut in_index = false;
            for character in path.chars() {
                match character {
                    '[' => {
                        in_index = true;
                        result.push_str("[*]");
                    }
                    ']' => in_index = false,
                    _ if !in_index => result.push(character),
                    _ => {}
                }
            }
            result
        }

        for (index, observation) in observations.iter().enumerate() {
            let Some(body) = observation
                .body
                .as_deref()
                .and_then(|body| serde_json::from_str::<Value>(body).ok())
            else {
                continue;
            };
            let url = normalize_endpoint(observation.url.as_deref().unwrap_or_default());
            if dataset_endpoints.contains(&url) {
                continue;
            }
            let observation_id = format!("response-{index}");
            let mut scalars = Vec::new();
            visit(&body, "$", &mut scalars);
            for (json_path, value) in scalars {
                let field_path = generalized_path(&json_path);
                response_fields
                    .entry(format!("{url}:{field_path}"))
                    .or_default()
                    .push(json!({
                        "observationId": observation_id,
                        "jsonPath": json_path,
                        "fieldPath": field_path,
                        "url": url,
                        "value": value
                    }));
            }
        }

        for (_, occurrences) in response_fields {
            let Some(first) = occurrences.first() else {
                continue;
            };
            let path = first
                .get("fieldPath")
                .and_then(Value::as_str)
                .unwrap_or("$");
            let url = first.get("url").and_then(Value::as_str).unwrap_or_default();
            let field_name = path.rsplit('.').next().unwrap_or(path);
            let identity_like = field_name.eq_ignore_ascii_case("id")
                || field_name.to_lowercase().ends_with("id")
                || field_name.to_lowercase().contains("tracking");
            let rendered_match = !identity_like
                && occurrences.iter().any(|item| match item.get("value") {
                    Some(Value::String(text)) if text.trim().len() >= 3 => {
                        rendered.contains(&text.trim().to_lowercase())
                    }
                    Some(Value::Number(number)) => rendered.contains(&number.to_string()),
                    _ => false,
                });
            let qualified = format!("{url}:{path}");
            delivered_fields.insert(qualified.clone());
            if rendered_match {
                visible_fields.insert(qualified);
                continue;
            }
            let observation_ids = occurrences
                .iter()
                .filter_map(|item| item.get("observationId").and_then(Value::as_str))
                .collect::<BTreeSet<_>>();
            let paths = occurrences
                .iter()
                .filter_map(|item| item.get("jsonPath").and_then(Value::as_str))
                .take(20)
                .collect::<Vec<_>>();
            let samples = occurrences
                .iter()
                .filter_map(|item| item.get("value"))
                .take(3)
                .cloned()
                .collect::<Vec<_>>();
            let (theme, related_to) = field_theme(field_name);
            ghost_fields.push(json!({
                "dataset": "response",
                "path": path.trim_start_matches("$.").to_string(),
                "qualifiedPath": qualified,
                "theme": theme,
                "received": true,
                "rendered": false,
                "samples": samples,
                "appearsRelatedTo": related_to,
                "confidence": {"received": 1.0, "notRendered": if rendered_text_available { 0.92 } else { 0.55 }},
                "evidence": {
                    "occurrences": occurrences.len(),
                    "responses": observation_ids.len(),
                    "observationIds": observation_ids,
                    "jsonPaths": paths,
                    "source": {"method": "GET", "url": url}
                },
                "caveat": "No matching observed value was found in rendered page text; this does not establish why the server included the field."
            }));
        }
    }

    ghost_fields.sort_by(|left, right| {
        left.get("qualifiedPath")
            .and_then(Value::as_str)
            .cmp(&right.get("qualifiedPath").and_then(Value::as_str))
    });

    let hidden_endpoints = endpoints
        .iter()
        .filter(|endpoint| {
            endpoint.get("schema").map(|schema| !schema.is_null()).unwrap_or(false)
                && endpoint
                    .get("url")
                    .and_then(Value::as_str)
                    .map(|url| !dataset_endpoints.contains(url))
                    .unwrap_or(false)
        })
        .map(|endpoint| json!({
            "method": endpoint.get("method"),
            "url": endpoint.get("url"),
            "confidence": 0.55,
            "basis": "Structured response observed, but no collection projection was associated with it."
        }))
        .collect::<Vec<_>>();

    let invisible_recipients = integrations
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, urls)| {
            let matches = urls.as_array()?;
            (!matches.is_empty()).then(|| {
                json!({
                    "integration": name,
                    "requests": matches,
                    "basis": "Browser traffic matched a known third-party integration domain."
                })
            })
        })
        .collect::<Vec<_>>();

    json!({
        "definition": "Data and machine interactions delivered to this browser session without a matching visible representation.",
        "scope": "Observed browser-session evidence only; no unobserved resources were probed.",
        "summary": {
            "visibleFields": visible_fields.len(),
            "deliveredFields": delivered_fields.len(),
            "ghostFields": ghost_fields.len(),
            "hiddenEndpoints": hidden_endpoints.len(),
            "hiddenRelationships": hidden_relationships.len(),
            "hiddenExperiments": feature_flags.len(),
            "invisibleRecipients": invisible_recipients.len()
        },
        "hiddenFields": ghost_fields,
        "hiddenEndpoints": hidden_endpoints,
        "hiddenRelationships": hidden_relationships,
        "hiddenExperiments": feature_flags,
        "deadFeatures": [],
        "invisibleRecipients": invisible_recipients,
        "limitations": [
            "Rendered status is inferred from value matches in captured page text and can miss transformed or graphical representations.",
            "A field being unrendered does not reveal whether omission was deliberate."
        ]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reports_unrendered_scalar_fields_with_provenance_without_claiming_intent() {
        let extraction = json!({"datasets": [{
            "name": "jobs",
            "source": {"method": "GET", "url": "https://example.test/api/jobs"},
            "presentation": {
                "visibleFields": ["title"],
                "machineOnlyFields": ["internal", "internal.rankingScore", "internal.recruiterOnly"]
            },
            "provenance": {"fields": {
                "internal": {"evidence": [{"value": {"rankingScore": 0.98}}]},
                "internal.rankingScore": {"evidence": [{"observationId": "obs-1", "jsonPath": "$.jobs[0].internal.rankingScore", "value": 0.98}]},
                "internal.recruiterOnly": {"evidence": [{"observationId": "obs-1", "jsonPath": "$.jobs[0].internal.recruiterOnly", "value": true}]}
            }},
            "relationships": []
        }]});

        let result = analyze_ghost_data(
            &extraction,
            &[],
            &[],
            &[],
            &json!({}),
            &json!({"renderedText": "Senior Engineer"}),
        );

        assert_eq!(result["summary"]["ghostFields"], 2);
        assert_eq!(result["hiddenFields"][0]["received"], true);
        assert_eq!(result["hiddenFields"][0]["rendered"], false);
        assert_eq!(
            result["hiddenFields"][0]["evidence"]["jsonPaths"][0],
            "$.jobs[0].internal.rankingScore"
        );
        assert!(result["hiddenFields"][0]["caveat"]
            .as_str()
            .unwrap()
            .contains("does not establish why"));
    }

    #[test]
    fn finds_ghost_fields_in_singleton_responses_without_a_dataset() {
        let observation: ObservationEnvelope = serde_json::from_value(json!({
            "kind": "network.response",
            "url": "https://example.test/api/profile",
            "body": "{\"name\":\"Randy\",\"internalPriority\":\"high\",\"recruiterOnly\":true}"
        }))
        .unwrap();
        let observations = vec![&observation];
        let result = analyze_ghost_data(
            &json!({"datasets": []}),
            &observations,
            &[],
            &[],
            &json!({}),
            &json!({"renderedText": "Randy"}),
        );

        assert_eq!(result["summary"]["visibleFields"], 1);
        assert_eq!(result["summary"]["ghostFields"], 2);
        assert_eq!(result["hiddenFields"][0]["received"], true);
    }
}
