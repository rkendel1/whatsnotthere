use serde_json::json;

pub fn confidence_score(endpoint_count: usize, flag_count: usize, hidden_contract_count: usize) -> serde_json::Value {
    let raw = (endpoint_count as f64 * 0.1) + (flag_count as f64 * 0.05);
    let score = (raw.min(1.0) * 100.0).round() / 100.0;

    json!({
        "score": score,
        "basis": {
            "endpoints": endpoint_count,
            "featureFlags": flag_count,
            "hiddenContracts": hidden_contract_count
        }
    })
}
