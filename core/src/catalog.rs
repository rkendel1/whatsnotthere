use crate::artifact::{hash_string, stable_stringify};
use crate::network::normalize_endpoint;
use crate::observation::ObservationEnvelope;
use crate::schema::infer_schema_from_values;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use url::Url;

fn sensitive_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    [
        "authorization",
        "cookie",
        "password",
        "passwd",
        "secret",
        "token",
        "api_key",
        "apikey",
        "ssn",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
}

fn safe_request_headers(headers: &serde_json::Map<String, Value>) -> Value {
    let allowed = [
        "accept",
        "content-type",
        "x-requested-with",
        "graphql-operation-name",
    ];
    Value::Object(
        headers
            .iter()
            .filter(|(name, _)| allowed.contains(&name.to_lowercase().as_str()))
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect(),
    )
}

fn redacted_url(raw: &str) -> String {
    let Ok(mut url) = Url::parse(raw) else {
        return raw.to_string();
    };
    let query = url
        .query_pairs()
        .map(|(name, value)| {
            let value = if sensitive_name(&name) {
                "[redacted]".to_string()
            } else {
                value.into_owned()
            };
            (name.into_owned(), value)
        })
        .collect::<Vec<_>>();
    if query.is_empty() {
        return url.to_string();
    }
    url.set_query(None);
    url.query_pairs_mut().extend_pairs(query);
    url.to_string()
}

fn redact(value: &Value, depth: usize) -> Value {
    if depth > 6 {
        return json!("[truncated]");
    }
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        if sensitive_name(key) {
                            json!("[redacted]")
                        } else {
                            redact(value, depth + 1)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(3)
                .map(|item| redact(item, depth + 1))
                .collect(),
        ),
        Value::String(text) if text.chars().count() > 2_000 => {
            json!(format!("{}…", text.chars().take(2_000).collect::<String>()))
        }
        _ => value.clone(),
    }
}

fn inferred_purpose(path: &str) -> Value {
    let lower = path.to_lowercase();
    let (label, confidence, basis) = if lower.contains("session") || lower.ends_with("/me") {
        (
            "current-session lookup",
            0.86,
            "endpoint path references session or current user",
        )
    } else if lower.contains("airport") {
        (
            "airport discovery",
            0.88,
            "endpoint path references airports",
        )
    } else if lower.contains("flag") || lower.contains("gatekeeper") || lower.contains("experiment")
    {
        (
            "feature configuration",
            0.88,
            "endpoint path references flags, experiments, or gatekeeping",
        )
    } else if lower.contains("search") {
        ("search", 0.82, "endpoint path references search")
    } else if lower.contains("profile") || lower.contains("account") {
        (
            "account or profile data",
            0.76,
            "endpoint path references account or profile",
        )
    } else {
        ("unknown", 0.25, "insufficient semantic evidence")
    };
    json!({"label": label, "confidence": confidence, "basis": basis})
}

fn parameter_type(value: &str) -> &'static str {
    if value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("false") {
        "boolean"
    } else if value.parse::<f64>().is_ok() {
        "number"
    } else {
        "string"
    }
}

fn response_paths(value: &Value, path: &str, output: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                response_paths(child, &format!("{path}.{key}"), output);
            }
        }
        Value::Array(items) => {
            if let Some(first) = items.first() {
                response_paths(first, &format!("{path}[*]"), output);
            }
        }
        _ => output.push(path.to_string()),
    }
}

pub fn build_api_field_guide(observations: &[&ObservationEnvelope]) -> Value {
    let mut grouped: BTreeMap<String, Vec<&ObservationEnvelope>> = BTreeMap::new();
    for observation in observations {
        let method = observation
            .method
            .as_deref()
            .unwrap_or("GET")
            .to_uppercase();
        let normalized = normalize_endpoint(observation.url.as_deref().unwrap_or_default());
        grouped
            .entry(format!("{method}:{normalized}"))
            .or_default()
            .push(observation);
    }

    let site = observations
        .iter()
        .filter_map(|observation| observation.page_url.as_deref())
        .find_map(|page| {
            Url::parse(page)
                .ok()
                .map(|url| url.origin().ascii_serialization())
        });
    let mut endpoints = Vec::new();

    for (identity, group) in grouped {
        let first = group[0];
        let method = first.method.as_deref().unwrap_or("GET").to_uppercase();
        let normalized = normalize_endpoint(first.url.as_deref().unwrap_or_default());
        let parsed_url = Url::parse(first.url.as_deref().unwrap_or_default()).ok();
        let origin = parsed_url
            .as_ref()
            .map(|url| url.origin().ascii_serialization())
            .unwrap_or_default();
        let path = parsed_url.as_ref().map(Url::path).unwrap_or(&normalized);
        let response_values = group
            .iter()
            .filter_map(|observation| observation.body.as_deref())
            .filter_map(|body| serde_json::from_str::<Value>(body).ok())
            .collect::<Vec<_>>();
        let request_values = group
            .iter()
            .filter_map(|observation| observation.request_body.as_deref())
            .filter_map(|body| serde_json::from_str::<Value>(body).ok())
            .collect::<Vec<_>>();
        let mut parameters: BTreeMap<String, (BTreeSet<String>, BTreeSet<String>)> =
            BTreeMap::new();
        for observation in &group {
            if let Some(url) = observation
                .url
                .as_deref()
                .and_then(|url| Url::parse(url).ok())
            {
                for (name, value) in url.query_pairs() {
                    let name = name.into_owned();
                    let entry = parameters.entry(name.clone()).or_default();
                    entry.0.insert(parameter_type(&value).to_string());
                    if entry.1.len() < 3 {
                        entry.1.insert(if sensitive_name(&name) {
                            "[redacted]".to_string()
                        } else {
                            value.into_owned()
                        });
                    }
                }
            }
        }
        let parameter_inventory = parameters
            .into_iter()
            .map(|(name, (types, examples))| {
                json!({"name": name, "in": "query", "types": types, "examples": examples, "observed": true})
            })
            .collect::<Vec<_>>();
        let timestamps = group
            .iter()
            .filter_map(|item| item.timestamp)
            .collect::<Vec<_>>();
        let session_path = path.to_lowercase().contains("session") || path.ends_with("/me");
        let browser_credentials = group.iter().any(|item| {
            matches!(
                item.credentials.as_deref(),
                Some("include") | Some("same-origin")
            )
        });
        let evidence = group
            .iter()
            .enumerate()
            .map(|(index, observation)| {
                let response = observation
                    .body
                    .as_deref()
                    .and_then(|body| serde_json::from_str::<Value>(body).ok());
                let mut paths = Vec::new();
                if let Some(value) = &response {
                    response_paths(value, "$", &mut paths);
                }
                json!({
                    "id": format!("api-obs-{}", hash_string(&format!("{}:{}:{}", identity, observation.timestamp.unwrap_or_default(), index))),
                    "timestamp": observation.timestamp,
                    "page": observation.page_url.as_deref().map(redacted_url),
                    "interaction": observation.interaction,
                    "request": {
                        "method": observation.method,
                        "url": observation.url.as_deref().map(redacted_url),
                        "safeHeaders": safe_request_headers(&observation.request_headers),
                        "bodyExample": observation.request_body.as_deref().and_then(|body| serde_json::from_str::<Value>(body).ok()).map(|value| redact(&value, 0))
                    },
                    "response": {
                        "status": observation.status,
                        "contentType": observation.headers.get("content-type"),
                        "jsonPaths": paths
                    }
                })
            })
            .collect::<Vec<_>>();
        let response_example = response_values.first().map(|value| redact(value, 0));
        let request_example = request_values.first().map(|value| redact(value, 0));
        let canonical = stable_stringify(&json!({"method": method, "url": normalized}));
        endpoints.push(json!({
            "id": format!("endpoint-{}", hash_string(&canonical)),
            "identity": identity,
            "classification": "browser-observed-api",
            "method": method,
            "origin": origin,
            "path": path,
            "normalizedUrl": normalized,
            "purpose": inferred_purpose(path),
            "observedCount": group.len(),
            "firstObserved": timestamps.iter().min(),
            "lastObserved": timestamps.iter().max(),
            "parameters": parameter_inventory,
            "request": {
                "safeHeaders": safe_request_headers(&first.request_headers),
                "schema": if request_values.is_empty() { Value::Null } else { infer_schema_from_values(&request_values) },
                "example": request_example
            },
            "response": {
                "statuses": group.iter().filter_map(|item| item.status).collect::<BTreeSet<_>>(),
                "contentTypes": group.iter().filter_map(|item| item.headers.get("content-type").and_then(Value::as_str)).collect::<BTreeSet<_>>(),
                "schema": if response_values.is_empty() { Value::Null } else { infer_schema_from_values(&response_values) },
                "example": response_example
            },
            "sessionDependency": {
                "indicator": if session_path { "likely" } else if browser_credentials { "possible" } else { "not-observed" },
                "confidence": if session_path { 0.9 } else if browser_credentials { 0.58 } else { 0.3 },
                "basis": if session_path { "session semantics in endpoint path" } else if browser_credentials { "request used browser credential mode" } else { "no session indicator observed" }
            },
            "evidence": evidence,
            "confidence": if response_values.is_empty() { 0.65 } else { 0.92 }
        }));
    }

    json!({
        "format": "xray.api-field-guide.v1",
        "site": site,
        "generatedAt": observations.iter().filter_map(|item| item.timestamp).max(),
        "terminology": "Browser-observed APIs; availability or provider intent is not asserted.",
        "endpoints": endpoints,
        "summary": {"endpoints": endpoints.len()}
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogs_parameters_redacted_examples_and_evidence() {
        let observation: ObservationEnvelope = serde_json::from_value(json!({
            "kind": "network.response",
            "timestamp": 100,
            "method": "GET",
            "url": "https://api.example.test/airports?region=bos&token=secret",
            "status": 200,
            "headers": {"content-type": "application/json"},
            "requestHeaders": {"accept": "application/json"},
            "pageUrl": "https://example.test/",
            "interaction": {"kind": "click", "label": "From"},
            "body": "{\"airports\":[{\"code\":\"BOS\",\"accessToken\":\"private\"}]}"
        }))
        .unwrap();
        let observations = vec![&observation];
        let guide = build_api_field_guide(&observations);
        let endpoint = &guide["endpoints"][0];

        assert_eq!(guide["site"], "https://example.test");
        assert_eq!(endpoint["parameters"][1]["examples"][0], "[redacted]");
        assert!(endpoint["evidence"][0]["request"]["url"]
            .as_str()
            .unwrap()
            .contains("%5Bredacted%5D"));
        assert_eq!(
            endpoint["response"]["example"]["airports"][0]["accessToken"],
            "[redacted]"
        );
        assert_eq!(endpoint["evidence"][0]["interaction"]["label"], "From");
        assert_eq!(endpoint["classification"], "browser-observed-api");
    }
}
