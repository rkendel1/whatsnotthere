import { downloadOfflineReplay } from '../offline-replay.js';
import { guideAsMarkdown, guideAsOpenApi, loadApiCatalog } from '../catalog-store.js';

const output = document.getElementById('output');
const error = document.getElementById('error');
const button = document.getElementById('scan');
const xrayMode = document.getElementById('mode-xray');
const guideMode = document.getElementById('mode-guide');
let activeTabId = null;
let activeReport = null;
let currentMode = 'xray';

function appendText(parent, tag, value, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  parent.appendChild(element);
  return element;
}

function labelize(value) {
  return String(value || 'Untitled dataset')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function flattenRecord(record, prefix = '', result = {}) {
  for (const [key, value] of Object.entries(record || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenRecord(value, path, result);
    } else {
      result[path] = Array.isArray(value) ? value.map((item) => (
        typeof item === 'object' ? JSON.stringify(item) : item
      )).join(', ') : value;
    }
  }
  return result;
}

function datasetScore(dataset) {
  return Number(dataset.confidence?.collection || 0);
}

function downloadDataset(dataset, format) {
  const safeName = dataset.name.replace(/[^a-z0-9_-]+/gi, '-');
  const flatItems = dataset.items.map((item) => flattenRecord(item));
  let content;
  let type;
  let extension;
  if (format === 'csv') {
    const columns = [...new Set(flatItems.flatMap(Object.keys))];
    const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    content = [columns.map(escape).join(','), ...flatItems.map((item) => (
      columns.map((column) => escape(item[column])).join(',')
    ))].join('\n');
    type = 'text/csv';
    extension = 'csv';
  } else if (format === 'json') {
    content = JSON.stringify(dataset.items, null, 2);
    type = 'application/json';
    extension = 'json';
  } else {
    content = JSON.stringify(dataset.reconstructionArtifact, null, 2);
    type = 'application/vnd.xray.dataset+json';
    extension = 'xray';
  }
  const href = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `${safeName}.${extension}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 1_000);
}

function downloadText(content, filename, type) {
  const href = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 1_000);
}

function schemaTree(schema, prefix = '', lines = []) {
  if (!schema || typeof schema !== 'object') return lines;
  if (schema.type && prefix) lines.push(`${prefix}: ${schema.type}`);
  for (const [name, child] of Object.entries(schema.properties || {})) {
    schemaTree(child, prefix ? `${prefix}.${name}` : name, lines);
  }
  if (schema.items) schemaTree(schema.items, `${prefix || '$'}[]`, lines);
  return lines;
}

function renderApiGuide(catalog) {
  output.replaceChildren();
  const sites = Object.values(catalog?.sites || {}).sort((left, right) => (right.lastObserved || 0) - (left.lastObserved || 0));
  if (!sites.length) {
    appendText(output, 'div', 'No browser-observed APIs cataloged yet. Use X-Ray on a site first.', 'catalog-empty');
    return;
  }

  const header = document.createElement('div');
  header.className = 'guide-header';
  const sitePicker = document.createElement('select');
  sites.forEach((site, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = `${new URL(site.site).hostname} · ${site.endpoints.length} APIs`;
    sitePicker.appendChild(option);
  });
  header.appendChild(sitePicker);
  const exports = document.createElement('div');
  exports.className = 'guide-exports';
  header.appendChild(exports);
  output.appendChild(header);
  const content = document.createElement('div');
  output.appendChild(content);

  function renderSite() {
    content.replaceChildren();
    exports.replaceChildren();
    const site = sites[Number(sitePicker.value) || 0];
    const safeName = new URL(site.site).hostname.replace(/[^a-z0-9.-]/gi, '-');
    for (const [label, action] of [
      ['JSON', () => downloadText(JSON.stringify(site, null, 2), `${safeName}.xray-api.json`, 'application/json')],
      ['OpenAPI', () => downloadText(JSON.stringify(guideAsOpenApi(site), null, 2), `${safeName}.openapi.json`, 'application/json')],
      ['Markdown', () => downloadText(guideAsMarkdown(site), `${safeName}.api-guide.md`, 'text/markdown')],
    ]) {
      const exportButton = appendText(exports, 'button', label);
      exportButton.addEventListener('click', action);
    }
    const summary = document.createElement('div');
    summary.className = 'guide-summary';
    appendText(summary, 'strong', site.endpoints.length);
    appendText(summary, 'span', `browser-observed APIs · ${site.history.length} retained scan${site.history.length === 1 ? '' : 's'}`);
    content.appendChild(summary);

    const latest = site.history.at(-1)?.changes;
    if (latest && (latest.added.length || latest.notObserved.length || latest.changed.length)) {
      const changes = document.createElement('div');
      changes.className = 'changes';
      appendText(changes, 'strong', 'Since the previous distinct scan');
      appendText(changes, 'div', `+${latest.added.length} endpoints · ${latest.notObserved.length} not observed this scan · ${latest.changed.length} schema changes`);
      content.appendChild(changes);
    }

    for (const endpoint of site.endpoints) {
      const details = document.createElement('details');
      details.className = 'endpoint';
      const heading = document.createElement('summary');
      appendText(heading, 'span', endpoint.method, 'method');
      appendText(heading, 'span', endpoint.path, 'endpoint-path');
      appendText(heading, 'span', `${endpoint.observedCount}×`, 'endpoint-count');
      details.appendChild(heading);
      const body = document.createElement('div');
      body.className = 'endpoint-body';
      appendText(body, 'p', `${labelize(endpoint.purpose?.label || 'Unknown purpose')} · ${Math.round((endpoint.purpose?.confidence || 0) * 100)}% inference confidence`, 'endpoint-purpose');
      const meta = document.createElement('div');
      meta.className = 'endpoint-meta';
      appendText(meta, 'div', `Session dependency: ${endpoint.sessionDependency?.indicator || 'not observed'}`);
      appendText(meta, 'div', `Parameters: ${endpoint.parameters?.length || 0} observed`);
      appendText(meta, 'div', `First: ${endpoint.firstObserved ? new Date(endpoint.firstObserved).toLocaleString() : 'unknown'}`);
      appendText(meta, 'div', `Last: ${endpoint.lastObserved ? new Date(endpoint.lastObserved).toLocaleString() : 'unknown'}`);
      body.appendChild(meta);
      if (endpoint.parameters?.length) {
        appendText(body, 'strong', 'Parameters');
        appendText(body, 'div', endpoint.parameters.map((parameter) => `${parameter.name} (${parameter.types.join(' | ')})`).join(' · '), 'endpoint-purpose');
      }
      const schemaDetails = document.createElement('details');
      appendText(schemaDetails, 'summary', 'Response schema');
      appendText(schemaDetails, 'pre', schemaTree(endpoint.response?.schema).join('\n') || 'No structured response observed.', 'schema-tree');
      body.appendChild(schemaDetails);
      const evidenceDetails = document.createElement('details');
      appendText(evidenceDetails, 'summary', `Show evidence (${endpoint.evidence?.length || 0})`);
      for (const evidence of endpoint.evidence || []) {
        const block = document.createElement('pre');
        block.className = 'evidence-block';
        block.textContent = [
          new Date(evidence.timestamp).toLocaleString(),
          evidence.request?.url,
          `Page: ${evidence.page || 'unknown'}`,
          evidence.interaction ? `Interaction: ${evidence.interaction.label || evidence.interaction.kind}` : 'Interaction: not observed',
          `Response: ${evidence.response?.status || 'unknown'} ${evidence.response?.contentType || ''}`,
          ...(evidence.response?.jsonPaths || []).slice(0, 15),
        ].join('\n');
        evidenceDetails.appendChild(block);
      }
      body.appendChild(evidenceDetails);
      const actions = document.createElement('div');
      actions.className = 'endpoint-actions';
      const copy = appendText(actions, 'button', 'Copy request');
      copy.addEventListener('click', async () => {
        const request = endpoint.evidence?.at(-1)?.request;
        await navigator.clipboard.writeText(`fetch(${JSON.stringify(request?.url || endpoint.normalizedUrl)}, ${JSON.stringify({ method: endpoint.method, headers: request?.safeHeaders || {} }, null, 2)})`);
        copy.textContent = 'Copied';
      });
      const replayUrl = endpoint.evidence?.at(-1)?.request?.url || '';
      if (endpoint.method === 'GET' && !replayUrl.includes('%5Bredacted%5D')) {
        const replay = appendText(actions, 'button', 'Replay in current tab');
        replay.addEventListener('click', async () => {
          replay.disabled = true;
          replay.textContent = 'Replaying…';
          const response = await chrome.runtime.sendMessage({ kind: 'replay_catalog_endpoint', tabId: activeTabId, site: site.site, endpointId: endpoint.id });
          replay.textContent = response?.ok ? `Received ${response.status}` : 'Replay failed';
        });
      }
      body.appendChild(actions);
      details.appendChild(body);
      content.appendChild(details);
    }
  }
  sitePicker.addEventListener('change', renderSite);
  renderSite();
}

async function showGuide() {
  currentMode = 'guide';
  xrayMode.classList.remove('active');
  guideMode.classList.add('active');
  error.textContent = '';
  output.textContent = 'Loading API Field Guide…';
  renderApiGuide(await loadApiCatalog());
}

function renderTable(parent, dataset) {
  const rows = dataset.items.slice(0, 20).map((item) => flattenRecord(item));
  const scalarSchemaFields = Object.entries(dataset.schema?.properties || {})
    .filter(([, schema]) => schema.type !== 'object')
    .map(([name]) => name);
  const preferred = ['id', 'title', 'name', 'description', 'company', 'location', 'price', 'salary', 'status', 'createdAt', 'postedAt'];
  const columns = [...new Set([...scalarSchemaFields, ...rows.flatMap(Object.keys)])]
    .sort((left, right) => {
      const leftRoot = left.split('.')[0];
      const rightRoot = right.split('.')[0];
      const leftRank = left === dataset.identity?.field ? -2 : preferred.indexOf(leftRoot);
      const rightRank = right === dataset.identity?.field ? -2 : preferred.indexOf(rightRoot);
      const normalizedLeft = leftRank < 0 && left !== dataset.identity?.field ? 100 : leftRank;
      const normalizedRight = rightRank < 0 && right !== dataset.identity?.field ? 100 : rightRank;
      return normalizedLeft - normalizedRight || left.localeCompare(right);
    })
    .slice(0, 8);
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const column of columns) appendText(head, 'th', labelize(column));
  const body = table.createTBody();
  for (const row of rows) {
    const tableRow = body.insertRow();
    for (const column of columns) {
      const cell = tableRow.insertCell();
      const value = row[column];
      cell.textContent = value == null ? '—' : String(value);
      cell.title = cell.textContent;
      if (typeof value === 'number') cell.className = 'number';
    }
  }
  wrap.appendChild(table);
  parent.appendChild(wrap);
}

function renderDataset(dataset, openPreview = false) {
    const card = document.createElement('section');
    card.className = 'dataset';
    const heading = document.createElement('div');
    heading.className = 'dataset-title';
    appendText(heading, 'h2', labelize(dataset.name));
    const confidence = Math.round(datasetScore(dataset) * 100);
    appendText(heading, 'span', dataset.kind === 'entityCollection' ? `${confidence}% dataset` : 'Possible structure', `badge${dataset.kind === 'entityCollection' ? '' : ' low'}`);
    card.appendChild(heading);

    const metrics = document.createElement('div');
    metrics.className = 'metrics';
    for (const [value, label] of [
      [dataset.observedItems, 'records'],
      [dataset.fields, 'fields'],
      [dataset.relationships.length, 'relationships'],
      [dataset.pagesObserved, 'pages'],
    ]) {
      const metric = document.createElement('div');
      metric.className = 'metric';
      appendText(metric, 'strong', value);
      appendText(metric, 'span', label);
      metrics.appendChild(metric);
    }
    card.appendChild(metrics);
    appendText(card, 'div', `${dataset.identity.field ? `Identity: ${dataset.identity.field}` : 'No stable identity found'} · ${dataset.pagination.type ? `${labelize(dataset.pagination.type)} pagination` : 'No pagination observed'}`, 'meta');

    const fields = document.createElement('div');
    fields.className = 'fields';
    for (const field of Object.keys(dataset.schema?.properties || {}).slice(0, 12)) {
      appendText(fields, 'span', field, 'field');
    }
    card.appendChild(fields);
    const visibleCount = dataset.presentation?.visibleFields?.length || 0;
    const machineCount = dataset.presentation?.machineOnlyFields?.length || 0;
    if (visibleCount || machineCount) {
      appendText(card, 'div', `${visibleCount} fields matched the page · ${machineCount} observed but not rendered`, 'visibility-summary');
    }

    const details = document.createElement('details');
    details.open = openPreview;
    appendText(details, 'summary', `Preview · first ${Math.min(20, dataset.items.length)} records`);
    renderTable(details, dataset);
    card.appendChild(details);

    const actions = document.createElement('div');
    actions.className = 'actions';
    if (dataset.pagination?.nextRequest) {
      const reconstruct = appendText(actions, 'button', 'Fetch remaining pages', 'primary-action');
      reconstruct.addEventListener('click', async () => {
        reconstruct.disabled = true;
        reconstruct.textContent = 'Reconstructing…';
        error.textContent = '';
        try {
          const response = await chrome.runtime.sendMessage({
            kind: 'reconstruct_dataset',
            tabId: activeTabId,
            datasetId: dataset.id,
          });
          if (!response?.ok) throw new Error(response?.error || 'Reconstruction failed.');
          renderReport(response.report);
          if (response.stopReason === 'page-limit') {
            error.textContent = `Stopped safely after ${response.pagesFetched} additional pages.`;
          }
        } catch (replayError) {
          error.textContent = replayError.message;
          reconstruct.disabled = false;
          reconstruct.textContent = 'Fetch remaining pages';
        }
      });
    }
    const replayButton = appendText(actions, 'button', 'Offline Replay');
    replayButton.addEventListener('click', () => downloadOfflineReplay(activeReport));
    const format = document.createElement('select');
    for (const [value, label] of [['json', 'JSON'], ['csv', 'CSV'], ['xray', 'X-Ray bundle']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      format.appendChild(option);
    }
    actions.appendChild(format);
    const exportButton = appendText(actions, 'button', 'Export');
    exportButton.addEventListener('click', () => downloadDataset(dataset, format.value));
    card.appendChild(actions);
    return card;
}

function renderGhostData(ghost) {
  if (!ghost || !Object.values(ghost.summary || {}).some(Boolean)) return null;
  const panel = document.createElement('section');
  panel.className = 'ghost-panel';
  const title = document.createElement('div');
  title.className = 'ghost-title';
  appendText(title, 'h2', 'Ghost Data');
  appendText(title, 'span', `${ghost.summary.ghostFields || 0} unrendered fields`, 'ghost-count');
  panel.appendChild(title);
  appendText(panel, 'p', 'What this site delivered to your browser, but did not visibly represent.', 'ghost-definition');

  const comparison = document.createElement('div');
  comparison.className = 'ghost-comparison';
  for (const [value, label] of [
    [ghost.summary.visibleFields || 0, 'Visible to you'],
    [ghost.summary.deliveredFields || 0, 'Delivered to browser'],
  ]) {
    const metric = document.createElement('div');
    appendText(metric, 'strong', value);
    appendText(metric, 'span', label);
    comparison.appendChild(metric);
  }
  panel.appendChild(comparison);

  const categories = document.createElement('div');
  categories.className = 'ghost-categories';
  for (const [value, label] of [
    [ghost.summary.hiddenEndpoints, 'endpoints'],
    [ghost.summary.hiddenRelationships, 'relationships'],
    [ghost.summary.hiddenExperiments, 'experiments'],
    [ghost.summary.invisibleRecipients, 'recipients'],
  ]) {
    if (value) appendText(categories, 'span', `${value} ${label}`);
  }
  panel.appendChild(categories);

  const disclosure = document.createElement('details');
  disclosure.className = 'ghost-disclosure';
  appendText(disclosure, 'summary', 'SHOW ME EVERYTHING');
  for (const field of ghost.hiddenFields || []) {
    const item = document.createElement('div');
    item.className = 'ghost-item';
    const heading = document.createElement('div');
    appendText(heading, 'strong', field.path);
    appendText(heading, 'span', `${Math.round((field.confidence?.notRendered || 0) * 100)}% not rendered`, 'ghost-confidence');
    item.appendChild(heading);
    appendText(item, 'div', `${labelize(field.theme)} · observed ${field.evidence?.occurrences || 0} times in ${field.evidence?.responses || 0} responses`, 'ghost-evidence');
    if (field.samples?.length) {
      appendText(item, 'code', field.samples.map((sample) => JSON.stringify(sample)).join(' · '));
    }
    appendText(item, 'div', `Evidence: ${(field.evidence?.jsonPaths || []).slice(0, 2).join(', ')}`, 'ghost-path');
    disclosure.appendChild(item);
  }
  for (const endpoint of ghost.hiddenEndpoints || []) {
    const item = document.createElement('div');
    item.className = 'ghost-item';
    appendText(item, 'strong', `${endpoint.method || 'GET'} ${endpoint.url}`);
    appendText(item, 'div', endpoint.basis, 'ghost-evidence');
    disclosure.appendChild(item);
  }
  for (const relationship of ghost.hiddenRelationships || []) {
    const item = document.createElement('div');
    item.className = 'ghost-item';
    appendText(item, 'strong', `${relationship.dataset} → ${labelize(relationship.relationship)}`);
    appendText(item, 'div', `Linked by ${relationship.identityField}${relationship.target ? ` · observed target: ${relationship.target}` : ''}`, 'ghost-evidence');
    disclosure.appendChild(item);
  }
  for (const experiment of ghost.hiddenExperiments || []) {
    const item = document.createElement('div');
    item.className = 'ghost-item';
    appendText(item, 'strong', experiment.key || 'Experiment state');
    appendText(item, 'div', `Observed in ${experiment.source || 'browser state'}`, 'ghost-evidence');
    if ('value' in experiment) appendText(item, 'code', JSON.stringify(experiment.value));
    disclosure.appendChild(item);
  }
  for (const recipient of ghost.invisibleRecipients || []) {
    const item = document.createElement('div');
    item.className = 'ghost-item';
    appendText(item, 'strong', labelize(recipient.integration));
    appendText(item, 'div', `${recipient.requests.length} observed third-party request${recipient.requests.length === 1 ? '' : 's'}`, 'ghost-evidence');
    disclosure.appendChild(item);
  }
  appendText(disclosure, 'p', '“Not rendered” is based on matching delivered values against captured page text. It does not establish why a field was included.', 'ghost-caveat');
  panel.appendChild(disclosure);
  return panel;
}

function renderReport(report) {
  activeReport = report;
  output.replaceChildren();
  const ghostPanel = renderGhostData(report?.ghostData);
  if (ghostPanel) output.appendChild(ghostPanel);
  const ranked = [...(report?.structuredExtraction?.datasets || [])]
    .sort((left, right) => datasetScore(right) - datasetScore(left));
  if (!ranked.length) {
    const summary = report?.captureSummary || {};
    const empty = document.createElement('section');
    empty.className = 'empty-state';
    appendText(empty, 'h2', summary.observations ? 'No dataset in the captured traffic' : 'No traffic captured yet');
    appendText(
      empty,
      'p',
      summary.observations
        ? `X-Ray retained ${summary.observations} responses (${summary.jsonResponses || 0} JSON), but none contained a repeated object collection.`
        : 'X-Ray starts observing after it is installed or reloaded. This tab likely finished loading before capture began.',
    );
    appendText(empty, 'p', 'Reload once, then interact with search, filters, or pagination before extracting.', 'empty-hint');
    const reload = appendText(empty, 'button', 'Reload tab and start capture', 'primary-action');
    reload.addEventListener('click', async () => {
      reload.disabled = true;
      await chrome.tabs.reload(activeTabId);
      window.close();
    });
    output.appendChild(empty);
    return;
  }
  const likely = ranked.filter((dataset) => dataset.kind === 'entityCollection');
  const primary = likely.length ? likely : [ranked[0]];
  const secondary = ranked.filter((dataset) => !primary.includes(dataset));
  appendText(output, 'p', `${primary.length} likely dataset${primary.length === 1 ? '' : 's'} found${secondary.length ? ` · ${secondary.length} lower-confidence structure${secondary.length === 1 ? '' : 's'} hidden` : ''}`, 'report-summary');
  primary.forEach((dataset, index) => output.appendChild(renderDataset(dataset, index === 0)));
  if (secondary.length) {
    const group = document.createElement('details');
    group.className = 'secondary-group';
    appendText(group, 'summary', `Other observed structures (${secondary.length})`);
    for (const dataset of secondary) group.appendChild(renderDataset(dataset));
    output.appendChild(group);
  }
}

async function currentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  return tab.id;
}

async function scanActiveTab() {
  error.textContent = '';
  output.textContent = 'Reconstructing dataset from observed traffic...';
  button.disabled = true;

  try {
    activeTabId = await currentTabId();
    const response = await chrome.runtime.sendMessage({ kind: 'build_report', tabId: activeTabId });

    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to create report.');
    }

    activeReport = response.report;
    if (currentMode === 'xray') renderReport(response.report);
  } catch (scanError) {
    error.textContent = scanError.message;
    if (currentMode === 'xray') output.textContent = 'X-Ray could not analyze this tab.';
  } finally {
    button.disabled = false;
  }
}

button.addEventListener('click', scanActiveTab);
xrayMode.addEventListener('click', () => {
  currentMode = 'xray';
  xrayMode.classList.add('active');
  guideMode.classList.remove('active');
  if (activeReport) renderReport(activeReport);
  else scanActiveTab();
});
guideMode.addEventListener('click', () => showGuide().catch((guideError) => {
  error.textContent = guideError.message;
  output.replaceChildren();
  const failure = document.createElement('section');
  failure.className = 'empty-state';
  appendText(failure, 'h2', 'API Field Guide could not open');
  appendText(failure, 'p', 'The local catalog could not be read. Reload the extension and scan this page once to initialize it.');
  const retry = appendText(failure, 'button', 'Try again', 'primary-action');
  retry.addEventListener('click', () => showGuide());
  output.appendChild(failure);
}));
scanActiveTab();
