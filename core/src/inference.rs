use crate::artifact::build_deterministic_artifact;
use crate::capability::infer_capabilities;
use crate::confidence::confidence_score;
use crate::dom::extract_invisible_content;
use crate::integration::detect_integrations;
use crate::network::{endpoint_from_observation, Endpoint};
use crate::observation::{AnalyzeRequest, ObservationEnvelope};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const FLAG_PATTERNS: [&str; 6] = ["feature", "flag", "experiment", "rollout", "beta", "darklaunch"];

fn normalize_flag_key(key: &str) -> String {
    key.replace(['_', '-'], "").to_lowercase()
}

fn is_flag_key(key: &str) -> bool {
    let normalized = normalize_flag_key(key);
    FLAG_PATTERNS.iter().any(|pattern| normalized.contains(pattern))
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
    let confidence = confidence_score(endpoint_values.len(), feature_flags.len(), hidden_contracts.len());

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
