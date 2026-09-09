use crate::artifact::build_deterministic_artifact;
use crate::capability::infer_capabilities;
use crate::catalog::build_api_field_guide;
use crate::confidence::confidence_score;
use crate::dataset::reconstruct_datasets;
use crate::dom::extract_invisible_content;
use crate::ghost::analyze_ghost_data;
use crate::integration::detect_integrations;
use crate::network::{endpoint_from_observation, Endpoint};
use crate::observation::{AnalyzeRequest, ObservationEnvelope};
use serde_json::{json, Value};
use std::collections::BTreeMap;

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

fn annotate_rendered_fields(extraction: &mut Value, snapshot: &Value) {
    let rendered = snapshot
        .get("renderedText")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    let Some(datasets) = extraction.get_mut("datasets").and_then(Value::as_array_mut) else {
        return;
    };

    for dataset in datasets {
        let fields = dataset
            .pointer("/provenance/fields")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut visible = Vec::new();
        let mut machine_only = Vec::new();
        let mut matches = serde_json::Map::new();
        for (field, provenance) in fields {
            let lower_field = field.to_lowercase();
            let identity_like = lower_field == "id"
                || lower_field.ends_with(".id")
                || lower_field.ends_with("_id")
                || lower_field.contains("tracking");
            let matched_values = provenance
                .get("evidence")
                .and_then(Value::as_array)
                .map(|evidence| {
                    evidence
                        .iter()
                        .filter_map(|item| item.get("value"))
                        .filter_map(|value| match value {
                            Value::String(text) if text.trim().len() >= 3 => {
                                Some(text.trim().to_lowercase())
                            }
                            Value::Number(number) if !identity_like => Some(number.to_string()),
                            _ => None,
                        })
                        .filter(|value| rendered.contains(value))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if !identity_like && !matched_values.is_empty() {
                visible.push(Value::String(field.clone()));
                matches.insert(
                    field,
                    json!({"method": "rendered-value-match", "values": matched_values}),
                );
            } else {
                machine_only.push(Value::String(field));
            }
        }
        dataset["presentation"] = json!({
            "visibleFields": visible,
            "machineOnlyFields": machine_only,
            "matches": matches,
            "method": "observed values matched against rendered page text"
        });
    }
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

    let mut structured_extraction = reconstruct_datasets(&network);
    annotate_rendered_fields(&mut structured_extraction, &request.snapshot);
    let page_projection = structured_extraction
        .get("datasets")
        .and_then(Value::as_array)
        .and_then(|datasets| datasets.iter().max_by_key(|dataset| {
            dataset.get("observedItems").and_then(Value::as_u64).unwrap_or(0)
        }))
        .map(|dataset| json!({
            "kind": "collection",
            "datasetId": dataset.get("id"),
            "name": dataset.get("name"),
            "entities": dataset.get("observedItems"),
            "observedAttributes": dataset.get("fields"),
            "relationships": dataset.get("relationships").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
            "description": format!(
                "This page is a projection of a {} collection.",
                dataset.get("name").and_then(Value::as_str).unwrap_or("structured")
            )
        }));

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
        "structuredExtraction": structured_extraction,
        "pageProjection": page_projection,
        "apiFieldGuide": build_api_field_guide(&network),
    });

    let endpoint_snapshot = report
        .get("endpoints")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let flag_snapshot = report
        .get("featureFlags")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    report["ghostData"] = analyze_ghost_data(
        &structured_extraction,
        &network,
        &endpoint_snapshot,
        &flag_snapshot,
        report.get("integrations").unwrap_or(&Value::Null),
        &request.snapshot,
    );

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
            "snapshot": {"renderedText": "Senior Engineer at Acme — Boston"}
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
        assert!(dataset["presentation"]["visibleFields"]
            .as_array()
            .unwrap()
            .contains(&json!("title")));
        assert!(dataset["presentation"]["machineOnlyFields"]
            .as_array()
            .unwrap()
            .contains(&json!("id")));
    }
}
