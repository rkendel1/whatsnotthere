use serde_json::{json, Value};

pub fn infer_capabilities(report: &Value) -> Value {
    let operations = report
        .get("endpoints")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);

    json!({
        "operations": operations,
        "hasFeatureFlagSystem": report
            .get("featureFlags")
            .and_then(Value::as_array)
            .map(|items| !items.is_empty())
            .unwrap_or(false)
    })
}
