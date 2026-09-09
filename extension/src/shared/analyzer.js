const FLAG_PATTERNS = [/feature/i, /flag/i, /experiment/i, /rollout/i, /beta/i, /dark[_-]?launch/i];

const THIRD_PARTY_SIGNATURES = {
  stripe: [/stripe\.com/i],
  paypal: [/paypal\.com/i],
  segment: [/segment\.(io|com)/i],
  googleAnalytics: [/google-analytics\.com/i, /googletagmanager\.com/i],
  intercom: [/intercom\.(io|com)/i],
  amplitude: [/amplitude\.com/i],
  sentry: [/sentry\.io/i],
  mixpanel: [/mixpanel\.com/i]
};

export function normalizeEndpoint(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export function inferSchema(value, depth = 0) {
  if (value === null) return { type: 'null' };
  if (depth > 5) return { type: 'max-depth' };

  if (Array.isArray(value)) {
    const sample = value.slice(0, 5).map((item) => inferSchema(item, depth + 1));
    const merged = mergeSchemas(sample);
    return { type: 'array', items: merged };
  }

  if (typeof value === 'object') {
    const properties = {};
    for (const [key, inner] of Object.entries(value)) {
      properties[key] = inferSchema(inner, depth + 1);
    }
    return { type: 'object', properties };
  }

  return { type: typeof value };
}

function mergeSchemas(schemas) {
  if (!schemas.length) return { type: 'unknown' };
  const uniqueTypes = [...new Set(schemas.map((schema) => schema.type))];
  if (uniqueTypes.length === 1) {
    return schemas[0];
  }
  return { type: 'union', anyOf: schemas };
}

export function detectFeatureFlags(inputs) {
  const matches = new Map();
  for (const [source, data] of Object.entries(inputs)) {
    if (!data || typeof data !== 'object') continue;

    for (const [key, value] of Object.entries(data)) {
      if (FLAG_PATTERNS.some((pattern) => pattern.test(key))) {
        matches.set(`${source}:${key}`, { source, key, value });
      }
    }
  }
  return [...matches.values()].sort((a, b) => `${a.source}:${a.key}`.localeCompare(`${b.source}:${b.key}`));
}

export function detectThirdPartyIntegrations(urls) {
  const findings = {};
  for (const [name, patterns] of Object.entries(THIRD_PARTY_SIGNATURES)) {
    findings[name] = [];
    for (const url of urls) {
      if (patterns.some((pattern) => pattern.test(url))) {
        findings[name].push(url);
      }
    }
    findings[name] = [...new Set(findings[name])].sort();
  }
  return findings;
}

export function extractInvisibleContent(snapshot) {
  return {
    hiddenElements: snapshot.hiddenElements ?? [],
    hiddenInputs: snapshot.hiddenInputs ?? [],
    metadata: snapshot.metadata ?? {},
    accessibilityOnly: snapshot.accessibilityOnly ?? []
  };
}

export function generateConnectors(report) {
  const endpoints = report.endpoints.map((endpoint) => endpoint.url);
  return {
    slack: {
      summaryTemplate: `Hidden API endpoints discovered: ${endpoints.join(', ') || 'none'}`
    },
    notion: {
      fields: ['url', 'method', 'status', 'schema']
    },
    sheets: {
      headers: ['url', 'method', 'status', 'contentType', 'schemaType']
    }
  };
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

export function hashString(input) {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

export function buildDeterministicArtifact(report) {
  const { discoveredAt: _ignoredDiscoveredAt, ...reportWithoutTimestamp } = report;
  const normalized = {
    ...reportWithoutTimestamp,
    endpoints: [...report.endpoints].sort((a, b) => a.url.localeCompare(b.url))
  };
  const canonical = stableStringify(normalized);
  return {
    artifactId: hashString(canonical),
    canonical,
    report: normalized
  };
}
