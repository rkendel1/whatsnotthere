import { analyzeWithCore } from './wasm-bridge.js';
import { followPagination } from './reconstruction.js';
import { loadApiCatalog, persistApiGuide } from './catalog-store.js';

const stateByTab = new Map();
const writesByTab = new Map();
const MAX_CAPTURE_BYTES = 8_000_000;
const MAX_OBSERVATIONS = 200;

function storageKey(tabId) {
  return `xray-tab-${tabId}`;
}

async function loadTabState(tabId) {
  if (stateByTab.has(tabId)) return stateByTab.get(tabId);
  const key = storageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const state = stored[key] || { observations: [], snapshot: null };
  stateByTab.set(tabId, state);
  return state;
}

function pruneTabState(state) {
  if (state.observations.length > MAX_OBSERVATIONS) {
    state.observations.splice(0, state.observations.length - MAX_OBSERVATIONS);
  }
  let bytes = state.observations.reduce((total, item) => total + (item.body?.length || 0), 0);
  while (bytes > MAX_CAPTURE_BYTES && state.observations.length > 1) {
    bytes -= state.observations.shift().body?.length || 0;
  }
}

async function saveTabState(tabId, state) {
  pruneTabState(state);
  await chrome.storage.session.set({ [storageKey(tabId)]: state });
}

function mutateTabState(tabId, mutate) {
  const previous = writesByTab.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const state = await loadTabState(tabId);
    mutate(state);
    await saveTabState(tabId, state);
    return state;
  });
  writesByTab.set(tabId, next);
  next.then(() => {
    if (writesByTab.get(tabId) === next) writesByTab.delete(tabId);
  }, () => {
    if (writesByTab.get(tabId) === next) writesByTab.delete(tabId);
  });
  return next;
}

async function settledTabState(tabId) {
  await writesByTab.get(tabId)?.catch(() => {});
  return loadTabState(tabId);
}

function toObservationEnvelope(event) {
  return {
    kind: 'network.response',
    timestamp: Date.now(),
    source: 'browser',
    transport: event?.transport || 'unknown',
    method: event?.method || 'GET',
    url: event?.url || '',
    status: event?.status ?? null,
    headers: {
      'content-type': event?.contentType || ''
    },
    body: typeof event?.responseBody === 'string' ? event.responseBody : '',
    requestHeaders: event?.requestHeaders || {},
    requestBody: typeof event?.requestBody === 'string' ? event.requestBody : null,
    pageUrl: event?.pageUrl || '',
    interaction: event?.interaction || null,
    credentials: event?.credentials || null,
  };
}

async function aggregate(tabId) {
  const state = await settledTabState(tabId);

  const report = await analyzeWithCore({
    tabId,
    discoveredAt: new Date().toISOString(),
    observations: state.observations,
    snapshot: state.snapshot ?? {}
  });
  report.captureSummary = {
    observations: state.observations.length,
    jsonResponses: state.observations.filter((item) => /json|graphql/.test(item.headers?.['content-type'] || '')).length,
    capturedBytes: state.observations.reduce((total, item) => total + (item.body?.length || 0), 0),
    persistedForTab: true,
  };
  return report;
}

function replayPage(tabId, request) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { kind: 'replay_page', request }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) return reject(new Error(runtimeError.message));
      if (!response?.ok) return reject(new Error(response?.error || 'Replay failed.'));
      resolve(response.event);
    });
  });
}

async function reconstruct(tabId, datasetId) {
  const state = await settledTabState(tabId);
  const initialReport = await aggregate(tabId);
  try {
    return await followPagination({
      report: initialReport,
      datasetId,
      replayPage: (request) => replayPage(tabId, request),
      recordObservation: (event) => state.observations.push(toObservationEnvelope(event)),
      analyze: () => aggregate(tabId),
    });
  } finally {
    await saveTabState(tabId, state);
  }
}

async function replayCatalogEndpoint(tabId, site, endpointId) {
  const state = await settledTabState(tabId);
  if (!state.pageUrl || new URL(state.pageUrl).origin !== site) {
    throw new Error('Open the cataloged site in the current tab before replaying this request.');
  }
  const catalog = await loadApiCatalog();
  const endpoint = catalog.sites?.[site]?.endpoints?.find((item) => item.id === endpointId);
  if (!endpoint || endpoint.method !== 'GET') {
    throw new Error('Only cataloged GET requests can be replayed.');
  }
  const url = endpoint.evidence?.at(-1)?.request?.url;
  if (!url) throw new Error('No observed request URL is available.');
  const event = await replayPage(tabId, { method: 'GET', url });
  state.observations.push(toObservationEnvelope(event));
  await saveTabState(tabId, state);
  const report = await aggregate(tabId);
  await persistApiGuide(report.apiFieldGuide);
  return { status: event.status, report };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind === 'page_started') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    mutateTabState(tabId, (state) => {
      state.observations = [];
      state.snapshot = null;
      state.pageUrl = message.url || '';
    }).then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.kind === 'network_event') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    mutateTabState(tabId, (state) => {
      state.observations.push(toObservationEnvelope(message.event));
    }).then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.kind === 'dom_snapshot') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    mutateTabState(tabId, (state) => {
      state.snapshot = message.snapshot;
    }).then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.kind === 'build_report') {
    const tabId = message.tabId;
    if (typeof tabId !== 'number') {
      sendResponse({ ok: false, error: 'Invalid tab id.' });
      return true;
    }

    chrome.tabs.sendMessage(tabId, { kind: 'collect_snapshot' }, () => {
      const response = chrome.runtime.lastError;
      if (response) {
        sendResponse({ ok: false, error: response.message });
        return;
      }

      aggregate(tabId)
        .then(async (report) => {
          await persistApiGuide(report.apiFieldGuide);
          sendResponse({ ok: true, report });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message }));
    });

    return true;
  }

  if (message?.kind === 'reconstruct_dataset') {
    const { tabId, datasetId } = message;
    if (typeof tabId !== 'number' || typeof datasetId !== 'string') {
      sendResponse({ ok: false, error: 'Invalid reconstruction request.' });
      return true;
    }
    reconstruct(tabId, datasetId)
      .then(async (result) => {
        await persistApiGuide(result.report.apiFieldGuide);
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.kind === 'get_api_catalog') {
    loadApiCatalog()
      .then((catalog) => sendResponse({ ok: true, catalog }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.kind === 'replay_catalog_endpoint') {
    const { tabId, site, endpointId } = message;
    if (typeof tabId !== 'number' || typeof site !== 'string' || typeof endpointId !== 'string') {
      sendResponse({ ok: false, error: 'Invalid catalog replay request.' });
      return true;
    }
    replayCatalogEndpoint(tabId, site, endpointId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stateByTab.delete(tabId);
  writesByTab.delete(tabId);
  chrome.storage.session.remove(storageKey(tabId));
});
