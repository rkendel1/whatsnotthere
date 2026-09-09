(function installProbe() {
  const src = chrome.runtime.getURL('src/injected/networkProbe.js');
  const script = document.createElement('script');
  script.src = src;
  script.async = false;
  (document.documentElement || document.head).appendChild(script);
  script.remove();
})();

chrome.runtime.sendMessage({ kind: 'page_started', url: window.location.href });

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== 'website-xray') return;

  chrome.runtime.sendMessage({
    kind: 'network_event',
    event: event.data.payload
  });
});

function collectSnapshot() {
  const hiddenElements = [...document.querySelectorAll('[hidden], [aria-hidden="true"], [style*="display:none"], [style*="visibility:hidden"]')]
    .slice(0, 200)
    .map((el) => ({
      tag: el.tagName,
      id: el.id || null,
      classes: el.className || null
    }));

  const hiddenInputs = [...document.querySelectorAll('input[type="hidden"]')]
    .slice(0, 200)
    .map((el) => ({ name: el.name || null, value: el.value || null }));

  const metadata = {
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content || null,
    ogTitle: document.querySelector('meta[property="og:title"]')?.content || null,
    robots: document.querySelector('meta[name="robots"]')?.content || null
  };

  const accessibilityOnly = [...document.querySelectorAll('[aria-label], [role], [alt]')]
    .slice(0, 200)
    .filter((el) => el.offsetParent === null)
    .map((el) => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      alt: el.getAttribute('alt')
    }));

  const scripts = [...document.scripts].map((s) => s.src || s.textContent || '');
  const behavioralScripts = scripts
    .filter((script) => /analytics|tracking|click|scroll|session|heatmap|pixel/i.test(script))
    .slice(0, 100);

  const localStorageData = {};
  const sessionStorageData = {};

  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key) localStorageData[key] = localStorage.getItem(key);
    }
  } catch {}

  try {
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key) sessionStorageData[key] = sessionStorage.getItem(key);
    }
  } catch {}

  const globalCandidates = Object.keys(window)
    .filter((key) => /feature|flag|experiment|rollout|beta|dark/i.test(key))
    .slice(0, 200)
    .reduce((acc, key) => {
      try {
        acc[key] = window[key];
      } catch {}
      return acc;
    }, {});

  return {
    localStorageData,
    sessionStorageData,
    globalCandidates,
    invisibleContent: { hiddenElements, hiddenInputs, metadata, accessibilityOnly },
    behavioralScripts,
    renderedText: (document.body?.innerText || '').slice(0, 500_000)
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.kind === 'collect_snapshot') {
    const snapshot = collectSnapshot();
    chrome.runtime.sendMessage({ kind: 'dom_snapshot', snapshot }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.kind === 'replay_page') {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      window.removeEventListener('message', receiveResult);
      sendResponse({ ok: false, error: 'Replay request timed out.' });
    }, 30_000);
    function receiveResult(event) {
      if (event.source !== window || event.data?.source !== 'website-xray-page') return;
      if (event.data?.kind !== 'replay-result' || event.data.requestId !== requestId) return;
      clearTimeout(timeout);
      window.removeEventListener('message', receiveResult);
      sendResponse(event.data.result);
    }
    window.addEventListener('message', receiveResult);
    window.postMessage({
      source: 'website-xray-content',
      kind: 'replay-request',
      requestId,
      request: message.request,
    }, '*');
    return true;
  }

  return false;
});
