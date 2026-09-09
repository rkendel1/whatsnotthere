export const CATALOG_KEY = 'xray-api-catalog-v1';
const MAX_HISTORY = 20;

function schemaFields(schema, prefix = '', result = {}) {
  if (!schema || typeof schema !== 'object') return result;
  if (schema.type && schema.type !== 'object') result[prefix || '$'] = schema.type;
  for (const [name, child] of Object.entries(schema.properties || {})) {
    schemaFields(child, prefix ? `${prefix}.${name}` : name, result);
  }
  if (schema.items) schemaFields(schema.items, `${prefix || '$'}[]`, result);
  return result;
}

function endpointChanges(previous, current) {
  const before = new Map((previous || []).map((endpoint) => [endpoint.identity, endpoint]));
  const after = new Map((current || []).map((endpoint) => [endpoint.identity, endpoint]));
  const added = [...after.keys()].filter((identity) => !before.has(identity));
  const notObserved = [...before.keys()].filter((identity) => !after.has(identity));
  const changed = [];
  for (const [identity, endpoint] of after) {
    if (!before.has(identity)) continue;
    const oldFields = schemaFields(before.get(identity).response?.schema);
    const newFields = schemaFields(endpoint.response?.schema);
    const fieldsAdded = Object.keys(newFields).filter((field) => !(field in oldFields));
    const fieldsRemoved = Object.keys(oldFields).filter((field) => !(field in newFields));
    const typesChanged = Object.keys(newFields)
      .filter((field) => field in oldFields && oldFields[field] !== newFields[field])
      .map((field) => ({ field, from: oldFields[field], to: newFields[field] }));
    if (fieldsAdded.length || fieldsRemoved.length || typesChanged.length) {
      changed.push({ identity, fieldsAdded, fieldsRemoved, typesChanged });
    }
  }
  return { added, notObserved, changed };
}

function scanFingerprint(guide) {
  return (guide.endpoints || [])
    .flatMap((endpoint) => endpoint.evidence || [])
    .map((item) => item.id)
    .sort()
    .join(':');
}

export function mergeApiGuide(catalog = { version: 1, sites: {} }, guide) {
  if (!guide?.site) return catalog;
  const sites = { ...(catalog.sites || {}) };
  const previous = sites[guide.site];
  const priorEndpoints = previous?.endpoints || [];
  const merged = new Map(priorEndpoints.map((endpoint) => [endpoint.identity, endpoint]));

  for (const endpoint of guide.endpoints || []) {
    const prior = merged.get(endpoint.identity);
    if (!prior) {
      merged.set(endpoint.identity, endpoint);
      continue;
    }
    const evidence = new Map((prior.evidence || []).map((item) => [item.id, item]));
    for (const item of endpoint.evidence || []) evidence.set(item.id, item);
    const combinedEvidence = [...evidence.values()]
      .sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0))
      .slice(-100);
    merged.set(endpoint.identity, {
      ...prior,
      ...endpoint,
      firstObserved: Math.min(prior.firstObserved || Infinity, endpoint.firstObserved || Infinity),
      lastObserved: Math.max(prior.lastObserved || 0, endpoint.lastObserved || 0),
      observedCount: combinedEvidence.length,
      evidence: combinedEvidence,
    });
  }

  const fingerprint = scanFingerprint(guide);
  const priorHistory = previous?.history || [];
  const duplicateScan = priorHistory.at(-1)?.fingerprint === fingerprint;
  const history = duplicateScan ? priorHistory : [...priorHistory, {
    observedAt: guide.generatedAt || Date.now(),
    fingerprint,
    endpointIdentities: (guide.endpoints || []).map((endpoint) => endpoint.identity),
    changes: endpointChanges(previous?.lastScanEndpoints, guide.endpoints),
  }].slice(-MAX_HISTORY);

  sites[guide.site] = {
    site: guide.site,
    terminology: guide.terminology,
    endpoints: [...merged.values()].sort((left, right) => left.identity.localeCompare(right.identity)),
    lastScanEndpoints: guide.endpoints || [],
    history,
    firstObserved: previous?.firstObserved || guide.generatedAt,
    lastObserved: guide.generatedAt,
  };
  return { version: 1, sites };
}

export async function persistApiGuide(guide) {
  if (!guide?.site) return null;
  const stored = await chrome.storage.local.get(CATALOG_KEY);
  const catalog = mergeApiGuide(stored[CATALOG_KEY], guide);
  await chrome.storage.local.set({ [CATALOG_KEY]: catalog });
  return catalog;
}

export async function loadApiCatalog() {
  const stored = await chrome.storage.local.get(CATALOG_KEY);
  return stored[CATALOG_KEY] || { version: 1, sites: {} };
}

export function guideAsOpenApi(site) {
  function openApiSchema(schema) {
    if (!schema || typeof schema !== 'object') return {};
    if (schema.type === 'object') {
      const entries = Object.entries(schema.properties || {});
      const required = entries.filter(([, child]) => child.required === true).map(([name]) => name);
      return {
        type: 'object',
        properties: Object.fromEntries(entries.map(([name, child]) => [name, openApiSchema(child)])),
        ...(required.length ? { required } : {}),
      };
    }
    if (schema.type === 'array') return { type: 'array', items: openApiSchema(schema.items) };
    if (schema.type === 'union') return { anyOf: (schema.anyOf || []).map(openApiSchema) };
    if (['string', 'number', 'boolean', 'null'].includes(schema.type)) return { type: schema.type };
    return {};
  }
  const paths = {};
  for (const endpoint of site.endpoints || []) {
    const operation = {
      summary: endpoint.purpose?.label === 'unknown' ? undefined : endpoint.purpose?.label,
      description: `Browser-observed endpoint. ${endpoint.purpose?.basis || ''}`,
      servers: [{ url: endpoint.origin }],
      parameters: (endpoint.parameters || []).map((parameter) => ({
        name: parameter.name,
        in: parameter.in,
        required: false,
        schema: { type: parameter.types?.[0] || 'string' },
        examples: Object.fromEntries((parameter.examples || []).map((value, index) => [`observed${index + 1}`, { value }])),
      })),
      responses: Object.fromEntries((endpoint.response?.statuses || [200]).map((status) => [String(status), {
        description: 'Browser-observed response',
        content: { 'application/json': { schema: openApiSchema(endpoint.response?.schema) } },
      }])),
      'x-xray-evidence': { observedCount: endpoint.observedCount, firstObserved: endpoint.firstObserved, lastObserved: endpoint.lastObserved },
    };
    paths[endpoint.path] ||= {};
    paths[endpoint.path][endpoint.method.toLowerCase()] = operation;
  }
  return { openapi: '3.1.0', info: { title: `${site.site} browser-observed APIs`, version: '1.0.0' }, servers: [{ url: site.site }], paths };
}

export function guideAsMarkdown(site) {
  const lines = [`# API Field Guide: ${site.site}`, '', '> Browser-observed APIs. Provider intent or public availability is not asserted.', ''];
  for (const endpoint of site.endpoints || []) {
    lines.push(`## ${endpoint.method} ${endpoint.path}`, '');
    lines.push(`- Purpose: ${endpoint.purpose?.label || 'unknown'} (${Math.round((endpoint.purpose?.confidence || 0) * 100)}% confidence)`);
    lines.push(`- Observed: ${endpoint.observedCount} time${endpoint.observedCount === 1 ? '' : 's'}`);
    lines.push(`- Session dependency: ${endpoint.sessionDependency?.indicator || 'not observed'}`);
    lines.push(`- First observed: ${new Date(endpoint.firstObserved).toISOString()}`);
    lines.push(`- Last observed: ${new Date(endpoint.lastObserved).toISOString()}`, '');
    if (endpoint.parameters?.length) lines.push(`Parameters: ${endpoint.parameters.map((item) => item.name).join(', ')}`, '');
  }
  return lines.join('\n');
}
