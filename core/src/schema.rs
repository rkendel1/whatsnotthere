use serde_json::{json, Map, Value};

pub fn infer_schema(value: &Value, depth: usize) -> Value {
    if value.is_null() {
        return json!({"type":"null"});
    }
    if depth > 5 {
        return json!({"type":"max-depth"});
    }

    match value {
        Value::Null => json!({"type":"null"}),
        Value::Array(items) => {
            let sample: Vec<Value> = items.iter().take(5).map(|item| infer_schema(item, depth + 1)).collect();
            json!({"type":"array","items":merge_schemas(sample)})
        }
        Value::Object(obj) => {
            let mut properties = Map::new();
            for (key, inner) in obj {
                properties.insert(key.clone(), infer_schema(inner, depth + 1));
            }
            json!({"type":"object","properties":properties})
        }
        Value::Bool(_) => json!({"type":"boolean"}),
        Value::Number(_) => json!({"type":"number"}),
        Value::String(_) => json!({"type":"string"}),
    }
}

fn merge_schemas(schemas: Vec<Value>) -> Value {
    if schemas.is_empty() {
        return json!({"type":"unknown"});
    }

    let mut types: Vec<String> = schemas
        .iter()
        .filter_map(|schema| schema.get("type").and_then(Value::as_str).map(str::to_string))
        .collect();
    types.sort();
    types.dedup();

    if types.len() == 1 {
        return schemas.into_iter().next().unwrap_or_else(|| json!({"type":"unknown"}));
    }

    json!({"type":"union","anyOf":schemas})
}
