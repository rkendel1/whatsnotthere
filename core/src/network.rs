use crate::observation::ObservationEnvelope;
use crate::schema::infer_schema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Endpoint {
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub content_type: Option<String>,
    pub schema: Option<Value>,
}

pub fn normalize_endpoint(url: &str) -> String {
    Url::parse(url)
        .map(|parsed| format!("{}{}", parsed.origin().ascii_serialization(), parsed.path()))
        .unwrap_or_else(|_| url.to_string())
}

pub fn endpoint_from_observation(observation: &ObservationEnvelope) -> Endpoint {
    let body = observation.body.as_deref().unwrap_or_default();
    let parsed_body = serde_json::from_str::<Value>(body).ok();
    let content_type = observation
        .headers
        .get("content-type")
        .and_then(Value::as_str)
        .map(str::to_string);

    Endpoint {
        method: observation.method.clone().unwrap_or_else(|| "GET".to_string()),
        url: normalize_endpoint(observation.url.as_deref().unwrap_or_default()),
        status: observation.status,
        content_type,
        schema: parsed_body.as_ref().map(|value| infer_schema(value, 0)),
    }
}
