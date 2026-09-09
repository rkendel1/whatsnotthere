use serde_json::{Map, Value};

pub fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::String(v) => serde_json::to_string(v).unwrap_or_default(),
        Value::Array(items) => {
            let rendered: Vec<String> = items.iter().map(stable_stringify).collect();
            format!("[{}]", rendered.join(","))
        }
        Value::Object(obj) => {
            let mut keys: Vec<&String> = obj.keys().collect();
            keys.sort();
            let rendered: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    let key_json = serde_json::to_string(key).unwrap_or_default();
                    let value_json = stable_stringify(obj.get(key).unwrap_or(&Value::Null));
                    format!("{key_json}:{value_json}")
                })
                .collect();
            format!("{{{}}}", rendered.join(","))
        }
    }
}

pub fn hash_string(input: &str) -> String {
    let mut hash: u32 = 5381;
    for byte in input.bytes() {
        hash = hash.wrapping_mul(33) ^ byte as u32;
    }
    format!("{hash:x}")
}

pub fn build_deterministic_artifact(report: &Value) -> Value {
    let mut normalized = report.as_object().cloned().unwrap_or_default();
    normalized.remove("discoveredAt");

    let mut endpoints: Vec<Value> = normalized
        .get("endpoints")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    endpoints.sort_by(|left, right| {
        left.get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(right.get("url").and_then(Value::as_str).unwrap_or_default())
    });
    normalized.insert("endpoints".to_string(), Value::Array(endpoints));

    let normalized_value = Value::Object(normalized);
    let canonical = stable_stringify(&normalized_value);

    let mut artifact = Map::new();
    artifact.insert("artifactId".to_string(), Value::String(hash_string(&canonical)));
    artifact.insert("canonical".to_string(), Value::String(canonical));
    artifact.insert("report".to_string(), normalized_value);
    Value::Object(artifact)
}
