use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

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
            let sample: Vec<Value> = items
                .iter()
                .take(5)
                .map(|item| infer_schema(item, depth + 1))
                .collect();
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

/// Infer a schema from every observed value rather than treating the first row as
/// representative. Object properties are unioned and carry an observation count,
/// which makes optional/sparse fields visible in the reconstruction artifact.
pub fn infer_schema_from_values(values: &[Value]) -> Value {
    merge_schemas_at_depth(
        values.iter().map(|value| infer_schema(value, 0)).collect(),
        0,
    )
}

fn merge_schemas(schemas: Vec<Value>) -> Value {
    merge_schemas_at_depth(schemas, 0)
}

fn merge_schemas_at_depth(schemas: Vec<Value>, depth: usize) -> Value {
    if schemas.is_empty() {
        return json!({"type":"unknown"});
    }

    if depth > 6 {
        return json!({"type":"max-depth"});
    }

    let mut types: Vec<String> = schemas
        .iter()
        .filter_map(|schema| {
            schema
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    types.sort();
    types.dedup();

    if types.len() == 1 && types.first().map(String::as_str) == Some("object") {
        let total = schemas.len();
        let mut properties: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for schema in &schemas {
            if let Some(fields) = schema.get("properties").and_then(Value::as_object) {
                for (name, field_schema) in fields {
                    properties
                        .entry(name.clone())
                        .or_default()
                        .push(field_schema.clone());
                }
            }
        }

        let merged = properties
            .into_iter()
            .map(|(name, field_schemas)| {
                let observed = field_schemas.len();
                let mut schema = merge_schemas_at_depth(field_schemas, depth + 1);
                if let Some(object) = schema.as_object_mut() {
                    object.insert("observed".to_string(), json!(observed));
                    object.insert("required".to_string(), json!(observed == total));
                }
                (name, schema)
            })
            .collect::<Map<String, Value>>();
        return json!({"type":"object", "observed": total, "properties": merged});
    }

    if types.len() == 1 && types.first().map(String::as_str) == Some("array") {
        let item_schemas = schemas
            .iter()
            .filter_map(|schema| schema.get("items").cloned())
            .collect();
        return json!({
            "type": "array",
            "items": merge_schemas_at_depth(item_schemas, depth + 1)
        });
    }

    if types.len() == 1 {
        return schemas
            .into_iter()
            .next()
            .unwrap_or_else(|| json!({"type":"unknown"}));
    }

    let mut alternatives = schemas;
    alternatives.sort_by_key(crate::artifact::stable_stringify);
    alternatives.dedup_by(|left, right| left == right);
    json!({"type":"union","anyOf":alternatives})
}
