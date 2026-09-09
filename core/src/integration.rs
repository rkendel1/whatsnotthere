use serde_json::{json, Map, Value};

const SIGNATURES: &[(&str, &[&str])] = &[
    ("stripe", &["stripe.com"]),
    ("paypal", &["paypal.com"]),
    ("segment", &["segment.io", "segment.com"]),
    ("googleAnalytics", &["google-analytics.com", "googletagmanager.com"]),
    ("intercom", &["intercom.io", "intercom.com"]),
    ("amplitude", &["amplitude.com"]),
    ("sentry", &["sentry.io"]),
    ("mixpanel", &["mixpanel.com"]),
];

pub fn detect_integrations(urls: &[String]) -> Value {
    let mut integrations = Map::new();

    for (name, signatures) in SIGNATURES {
        let mut matches: Vec<String> = urls
            .iter()
            .filter(|url| signatures.iter().any(|pattern| url.to_lowercase().contains(pattern)))
            .cloned()
            .collect();
        matches.sort();
        matches.dedup();
        integrations.insert((*name).to_string(), json!(matches));
    }

    Value::Object(integrations)
}
