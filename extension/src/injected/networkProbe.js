(function installNetworkProbe() {
  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  function emit(payload) {
    window.postMessage({ source: 'website-xray', payload }, '*');
  }

  window.fetch = async function patchedFetch(input, init = {}) {
    const method = init.method || 'GET';
    const url = typeof input === 'string' ? input : input.url;
    const started = Date.now();

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
      responseBody: bodyText.slice(0, 10000)
    });

    return response;
  };

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__xray = { method, url, started: Date.now() };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend() {
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
        responseBody: textBody.slice(0, 10000)
      });
    });

    return originalSend.apply(this, arguments);
  };
})();
