use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObservationEnvelope {
    pub kind: String,
    #[serde(default)]
    pub timestamp: Option<u64>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub headers: Map<String, Value>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeRequest {
    pub tab_id: i64,
    pub discovered_at: String,
    #[serde(default)]
    pub observations: Vec<ObservationEnvelope>,
    #[serde(default)]
    pub snapshot: Value,
}
