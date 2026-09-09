use wasm_bindgen::prelude::*;
use xray_core::{analyze_request, AnalyzeRequest};

#[wasm_bindgen]
pub fn analyze_observations(input_json: &str) -> Result<String, JsValue> {
    let request: AnalyzeRequest = serde_json::from_str(input_json)
        .map_err(|error| JsValue::from_str(&format!("Invalid observation payload: {error}")))?;

    let report = analyze_request(request);
    serde_json::to_string(&report)
        .map_err(|error| JsValue::from_str(&format!("Failed to serialize report: {error}")))
}
