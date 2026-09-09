import {
  buildDeterministicArtifact,
  detectThirdPartyIntegrations,
  generateConnectors,
  inferSchema,
  normalizeEndpoint
} from './shared/analyzer.js';

const stateByTab = new Map();

function getTabState(tabId) {
  if (!stateByTab.has(tabId)) {
    stateByTab.set(tabId, {
      network: [],
      snapshot: null
    });
  }
  return stateByTab.get(tabId);
}

function parseBodyMaybe(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText.trim()) return null;
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

function asEndpoint(event) {
  const parsed = parseBodyMaybe(event.responseBody);
  return {
    method: event.method || 'GET',
    url: normalizeEndpoint(event.url),
    status: event.status ?? null,
    contentType: event.contentType || null,
    schema: parsed ? inferSchema(parsed) : null
  };
}

function aggregate(tabId) {
  const state = getTabState(tabId);
  const endpointsMap = new Map();
  for (const event of state.network) {
    const endpoint = asEndpoint(event);
    const key = `${endpoint.method}:${endpoint.url}`;
    if (!endpointsMap.has(key)) {
      endpointsMap.set(key, endpoint);
    }
  }

  const endpoints = [...endpointsMap.values()];
  const allUrls = state.network.map((item) => item.url).filter(Boolean);
  const integrations = detectThirdPartyIntegrations(allUrls);
  const flags = state.snapshot?.featureFlags ?? [];

  const report = {
    tabId,
    discoveredAt: new Date().toISOString(),
    endpoints,
    hiddenDataContracts: endpoints.filter((endpoint) => endpoint.schema),
    featureFlags: flags,
    invisibleContent: state.snapshot?.invisibleContent ?? {
      hiddenElements: [],
      hiddenInputs: [],
      metadata: {},
      accessibilityOnly: []
    },
    behavioralScripts: state.snapshot?.behavioralScripts ?? [],
    integrations
  };

  const artifact = buildDeterministicArtifact(report);

  return {
    ...report,
    deterministicArtifact: artifact,
    connectors: generateConnectors(report),
    localReplay: {
      featureFlags: flags.map((flag) => ({
        key: flag.key,
        command: `localStorage.setItem('${flag.key}', JSON.stringify(${JSON.stringify(flag.value)}));`
      }))
    }
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind === 'network_event') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    const tabState = getTabState(tabId);
    tabState.network.push(message.event);
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

      sendResponse({ ok: true, report: aggregate(tabId) });
    });

    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stateByTab.delete(tabId);
});
