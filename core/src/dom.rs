use serde_json::{json, Value};

pub fn extract_invisible_content(snapshot: &Value) -> Value {
    let invisible = snapshot.get("invisibleContent").unwrap_or(snapshot);
    json!({
        "hiddenElements": invisible.get("hiddenElements").cloned().unwrap_or_else(|| json!([])),
        "hiddenInputs": invisible.get("hiddenInputs").cloned().unwrap_or_else(|| json!([])),
        "metadata": invisible.get("metadata").cloned().unwrap_or_else(|| json!({})),
        "accessibilityOnly": invisible.get("accessibilityOnly").cloned().unwrap_or_else(|| json!([]))
    })
}
