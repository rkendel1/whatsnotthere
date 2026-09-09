import { analyzeWithCore } from './wasm-bridge.js';

const stateByTab = new Map();

function getTabState(tabId) {
  if (!stateByTab.has(tabId)) {
    stateByTab.set(tabId, {
      observations: [],
      snapshot: null
    });
  }
  return stateByTab.get(tabId);
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
    body: typeof event?.responseBody === 'string' ? event.responseBody : ''
  };
}

async function aggregate(tabId) {
  const state = getTabState(tabId);

  return await analyzeWithCore({
    tabId,
    discoveredAt: new Date().toISOString(),
    observations: state.observations,
    snapshot: state.snapshot ?? {}
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind === 'network_event') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    const tabState = getTabState(tabId);
    tabState.observations.push(toObservationEnvelope(message.event));
    sendResponse({ ok: true });
    return true;
  }

  if (message?.kind === 'dom_snapshot') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    const tabState = getTabState(tabId);
    tabState.snapshot = message.snapshot;
    sendResponse({ ok: true });
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
        .then((report) => sendResponse({ ok: true, report }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
    });

    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stateByTab.delete(tabId);
});
