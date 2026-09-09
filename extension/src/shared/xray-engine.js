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

const IDENTITY_PATTERNS = [/^id$/i, /_id$/i, /Id$/, /uuid/i, /slug/i];
const CURSOR_REQUEST_KEYS = ['cursor', 'after', 'nextCursor', 'pageToken'];
const CURSOR_RESPONSE_KEYS = ['nextCursor', 'cursor', 'nextPageToken', 'endCursor'];
const PAGE_REQUEST_KEYS = ['page', 'offset', 'start'];
const PAGINATION_HINT_KEYS = ['hasMore', 'total', 'totalCount', 'pageSize', 'limit'];

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

function parseBodyMaybe(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText.trim()) return null;
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

function asEndpoint(observation) {
  const parsed = parseBodyMaybe(observation.body ?? observation.responseBody);
  const contentType = observation.headers?.['content-type'] ?? observation.contentType ?? null;
  return {
    method: observation.method || 'GET',
    url: normalizeEndpoint(observation.url),
    status: observation.status ?? null,
    contentType,
    schema: parsed ? inferSchema(parsed) : null
  };
}

function parseUrlMaybe(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function findArrayCollectionCandidate(parsedBody) {
  if (Array.isArray(parsedBody)) return { name: 'items', items: parsedBody };
  if (!parsedBody || typeof parsedBody !== 'object') return null;

  for (const [key, value] of Object.entries(parsedBody)) {
    if (Array.isArray(value) && value.some((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
      return { name: key, items: value };
    }
  }
  return null;
}

function inferIdentityFieldFromItems(items = []) {
  const objectItems = items.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  if (!objectItems.length) return { field: null, confidence: 0 };

  const first = objectItems[0];
  const keys = Object.keys(first);
  if (!keys.length) return { field: null, confidence: 0 };

  for (const key of keys) {
    if (IDENTITY_PATTERNS.some((pattern) => pattern.test(key))) {
      const nonNullCount = objectItems.filter((item) => item[key] !== undefined && item[key] !== null).length;
      const confidence = Number((0.6 + (nonNullCount / objectItems.length) * 0.4).toFixed(2));
      return { field: key, confidence };
    }
  }

  return { field: null, confidence: 0 };
}

function inferRelationshipsFromItemSchema(itemSchema) {
  if (!itemSchema || itemSchema.type !== 'object') return [];

  const relationships = [];
  for (const [name, schema] of Object.entries(itemSchema.properties ?? {})) {
    if (!schema) continue;

    if (schema.type === 'object') {
      const identityField = Object.keys(schema.properties ?? {}).find((key) =>
        IDENTITY_PATTERNS.some((pattern) => pattern.test(key))
      );
      if (identityField) {
        relationships.push({ name, kind: 'object', identityField, confidence: 0.88 });
      }
      continue;
    }

    if (schema.type === 'array' && schema.items?.type === 'object') {
      const identityField = Object.keys(schema.items.properties ?? {}).find((key) =>
        IDENTITY_PATTERNS.some((pattern) => pattern.test(key))
      );
      if (identityField) {
        relationships.push({ name, kind: 'array', identityField, confidence: 0.82 });
      }
    }
  }

  return relationships;
}

function inferPagination(observation, parsedBody) {
  const url = parseUrlMaybe(observation.url);
  const query = url?.searchParams;
  const bodyObject = parsedBody && typeof parsedBody === 'object' ? parsedBody : null;

  const cursorRequestKey = CURSOR_REQUEST_KEYS.find((key) => query?.has(key));
  const cursorResponseKey = CURSOR_RESPONSE_KEYS.find((key) => bodyObject && key in bodyObject);
  if (cursorRequestKey || cursorResponseKey) {
    return {
      detected: true,
      type: 'cursor',
      cursorField: cursorResponseKey || cursorRequestKey || null,
      confidence: cursorRequestKey && cursorResponseKey ? 0.97 : 0.86
    };
  }

  const pageRequestKey = PAGE_REQUEST_KEYS.find((key) => query?.has(key));
  const pageHintKey = PAGINATION_HINT_KEYS.find((key) => bodyObject && key in bodyObject);
  if (pageRequestKey || pageHintKey) {
    return {
      detected: true,
      type: 'page',
      cursorField: null,
      confidence: pageRequestKey && pageHintKey ? 0.9 : 0.78
    };
  }

  return { detected: false, type: null, cursorField: null, confidence: 0 };
}

function inferCollectionName(defaultName, url) {
  if (defaultName && defaultName !== 'items') return defaultName;
  const parsed = parseUrlMaybe(url);
  if (!parsed) return defaultName || 'items';
  const segment = parsed.pathname.split('/').filter(Boolean).pop();
  return segment || defaultName || 'items';
}

function reconstructDatasets(networkObservations) {
  const datasets = [];
  const dedup = new Map();

  for (const observation of networkObservations) {
    const parsedBody = parseBodyMaybe(observation.body ?? observation.responseBody);
    const collectionCandidate = findArrayCollectionCandidate(parsedBody);
    if (!collectionCandidate) continue;

    const datasetName = inferCollectionName(collectionCandidate.name, observation.url);
    const normalizedUrl = normalizeEndpoint(observation.url ?? '');
    const key = `${observation.method || 'GET'}:${normalizedUrl}:${datasetName}`;
    const items = collectionCandidate.items.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
    if (!items.length) continue;

    const itemSchema = inferSchema(items[0]);
    const identity = inferIdentityFieldFromItems(items);
    const pagination = inferPagination(observation, parsedBody);
    const relationships = inferRelationshipsFromItemSchema(itemSchema);

    const existing = dedup.get(key);
    if (!existing) {
      dedup.set(key, {
        name: datasetName,
        source: { method: observation.method || 'GET', url: normalizedUrl },
        observedItems: items.length,
        fields: Object.keys(itemSchema.properties ?? {}).length,
        schema: itemSchema,
        identity,
        pagination,
        relationships,
        preview: items.slice(0, 5),
        confidence: {
          collection: 0.99,
          pagination: pagination.confidence,
          identity: identity.confidence,
          relationships: relationships.length ? 0.88 : 0
        }
      });
      continue;
    }

    existing.observedItems += items.length;
    if (existing.preview.length < 5) {
      existing.preview = [...existing.preview, ...items.slice(0, 5 - existing.preview.length)];
    }
    existing.pagination = existing.pagination.confidence >= pagination.confidence ? existing.pagination : pagination;
    existing.identity = existing.identity.confidence >= identity.confidence ? existing.identity : identity;
    if (relationships.length > existing.relationships.length) {
      existing.relationships = relationships;
    }
    existing.confidence.pagination = existing.pagination.confidence;
    existing.confidence.identity = existing.identity.confidence;
    existing.confidence.relationships = existing.relationships.length ? 0.88 : 0;
  }

  datasets.push(...dedup.values());
  datasets.sort((a, b) => b.observedItems - a.observedItems || a.name.localeCompare(b.name));

  return {
    datasets,
    summary: {
      collections: datasets.length,
      totalObservedItems: datasets.reduce((sum, dataset) => sum + dataset.observedItems, 0)
    }
  };
}

export function analyzeObservationSession({ tabId, discoveredAt, observations = [], snapshot = {} }) {
  const networkObservations = observations.filter((item) => item?.kind === 'network.response');
  const endpointsMap = new Map();

  for (const observation of networkObservations) {
    const endpoint = asEndpoint(observation);
    const key = `${endpoint.method}:${endpoint.url}`;
    if (!endpointsMap.has(key)) {
      endpointsMap.set(key, endpoint);
    }
  }

  const endpoints = [...endpointsMap.values()];
  const allUrls = networkObservations.map((item) => item.url).filter(Boolean);
  const integrations = detectThirdPartyIntegrations(allUrls);

  const featureFlags = detectFeatureFlags({
    localStorage: snapshot.localStorageData,
    sessionStorage: snapshot.sessionStorageData,
    globals: snapshot.globalCandidates
  });

  const report = {
    tabId,
    discoveredAt: discoveredAt ?? new Date().toISOString(),
    endpoints,
    hiddenDataContracts: endpoints.filter((endpoint) => endpoint.schema),
    featureFlags,
    invisibleContent: extractInvisibleContent(snapshot.invisibleContent ?? snapshot),
    behavioralScripts: snapshot.behavioralScripts ?? [],
    integrations,
    confidence: {
      score: Math.min(1, Number(((endpoints.length * 0.1) + (featureFlags.length * 0.05)).toFixed(2))),
      basis: {
        endpoints: endpoints.length,
        featureFlags: featureFlags.length,
        hiddenContracts: endpoints.filter((endpoint) => endpoint.schema).length
      }
    },
    structuredExtraction: reconstructDatasets(networkObservations)
  };

  const artifact = buildDeterministicArtifact(report);

  return {
    ...report,
    deterministicArtifact: artifact,
    connectors: generateConnectors(report),
    localReplay: {
      featureFlags: featureFlags.map((flag) => ({
        key: flag.key,
        command: `localStorage.setItem('${flag.key}', JSON.stringify(${JSON.stringify(flag.value)}));`
      }))
    }
  };
}
