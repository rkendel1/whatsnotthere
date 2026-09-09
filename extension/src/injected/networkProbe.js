(function installNetworkProbe() {
  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const requestTemplates = new Map();
  const SAFE_REQUEST_HEADERS = new Set(['accept', 'content-type', 'x-requested-with', 'graphql-operation-name']);
  let recentInteraction = null;

  document.addEventListener('click', (event) => {
    const target = event.target?.closest?.('button, a, input, select, [role="button"]');
    if (!target) return;
    recentInteraction = {
      kind: 'click',
      tag: target.tagName.toLowerCase(),
      label: (target.getAttribute('aria-label') || target.textContent || target.name || '').trim().slice(0, 80),
      at: Date.now(),
    };
  }, true);

  function activeInteraction() {
    return recentInteraction && Date.now() - recentInteraction.at < 5_000 ? recentInteraction : null;
  }

  function safeHeaders(headers) {
    const retained = {};
    for (const [name, value] of new Headers(headers || {}).entries()) {
      if (SAFE_REQUEST_HEADERS.has(name.toLowerCase())) retained[name.toLowerCase()] = value.slice(0, 500);
    }
    return retained;
  }

  function endpointKey(url) {
    const parsed = new URL(url, window.location.href);
    return `${parsed.origin}${parsed.pathname}`;
  }

  function emit(payload) {
    window.postMessage({ source: 'website-xray', payload }, '*');
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.source !== 'website-xray-content') return;
    if (event.data?.kind !== 'replay-request') return;

    const { requestId, request } = event.data;
    const started = Date.now();
    let result;
    try {
      const url = new URL(request.url, window.location.href);
      if (!['http:', 'https:'].includes(url.protocol) || request.method !== 'GET') {
        throw new Error('Replay is limited to observed HTTP GET requests.');
      }
      const template = requestTemplates.get(endpointKey(url));
      const response = await originalFetch(url.href, {
        method: 'GET',
        headers: template?.headers,
        credentials: template?.credentials || 'include',
        mode: template?.mode,
        redirect: template?.redirect,
        referrer: template?.referrer,
        referrerPolicy: template?.referrerPolicy,
        cache: 'no-store',
      });
      const contentType = response.headers.get('content-type') || '';
      const responseBody = /json|graphql|text/.test(contentType)
        ? (await response.text()).slice(0, 1_000_000)
        : '';
      result = {
        ok: response.ok,
        event: {
          transport: 'replay',
          method: 'GET',
          url: url.href,
          status: response.status,
          durationMs: Date.now() - started,
          contentType,
          responseBody,
          requestHeaders: safeHeaders(template?.headers),
          requestBody: '',
          credentials: template?.credentials || 'include',
          pageUrl: window.location.href,
          interaction: activeInteraction(),
        },
      };
    } catch (error) {
      result = { ok: false, error: error.message };
    }

    window.postMessage({
      source: 'website-xray-page',
      kind: 'replay-result',
      requestId,
      result,
    }, '*');
  });

  window.fetch = async function patchedFetch(input, init = {}) {
    let method = init.method || (typeof input === 'string' ? 'GET' : input.method) || 'GET';
    const url = typeof input === 'string' ? input : input.url;
    const started = Date.now();
    let requestTemplate = null;
    let requestBodyPromise = Promise.resolve('');

    try {
      requestTemplate = new Request(input, init);
      method = requestTemplate.method;
      if (requestTemplate.method === 'GET') requestTemplates.set(endpointKey(requestTemplate.url), requestTemplate);
      if (!['GET', 'HEAD'].includes(requestTemplate.method)) {
        requestBodyPromise = requestTemplate.clone().text().catch(() => '');
      }
    } catch {}

    const response = await originalFetch.apply(this, arguments);
    let bodyText = '';
    const contentType = response.headers.get('content-type') || '';
    if (/json|graphql|text/.test(contentType)) {
      try {
        bodyText = await response.clone().text();
      } catch {}
    }

    emit({
      transport: 'fetch',
      method,
      url,
      status: response.status,
      durationMs: Date.now() - started,
      contentType,
      responseBody: bodyText.slice(0, 1_000_000),
      requestHeaders: safeHeaders(requestTemplate?.headers),
      requestBody: (await requestBodyPromise).slice(0, 100_000),
      credentials: requestTemplate?.credentials || null,
      pageUrl: window.location.href,
      interaction: activeInteraction(),
    });

    return response;
  };

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__xray = { method, url, started: Date.now(), requestHeaders: {} };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
    if (this.__xray && SAFE_REQUEST_HEADERS.has(String(name).toLowerCase())) {
      this.__xray.requestHeaders[String(name).toLowerCase()] = String(value).slice(0, 500);
    }
    return originalSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    this.addEventListener('loadend', () => {
      const context = this.__xray || {};
      const contentType = this.getResponseHeader('content-type') || '';
      const textBody = typeof this.responseText === 'string' ? this.responseText : '';

      emit({
        transport: 'xhr',
        method: context.method || 'GET',
        url: context.url || this.responseURL,
        status: this.status,
        durationMs: Date.now() - (context.started || Date.now()),
        contentType,
        responseBody: textBody.slice(0, 1_000_000),
        requestHeaders: context.requestHeaders || {},
        requestBody: typeof body === 'string' ? body.slice(0, 100_000) : '',
        credentials: this.withCredentials ? 'include' : 'same-origin',
        pageUrl: window.location.href,
        interaction: activeInteraction(),
      });
    });

    return originalSend.apply(this, arguments);
  };
})();
