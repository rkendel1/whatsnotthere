import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { analyzeWithCore, setWasmAnalyzerForTests } from '../src/core-adapter.js';
import { followPagination } from '../src/reconstruction.js';
import { buildOfflineReplay } from '../src/offline-replay.js';
import { guideAsOpenApi, mergeApiGuide } from '../src/catalog-store.js';

test('analyzeWithCore serializes observations to the WASM analyzer and parses its report', async () => {
  let receivedInput = null;
  setWasmAnalyzerForTests((input) => {
    receivedInput = JSON.parse(input);
    return JSON.stringify({ endpoints: [{ url: 'https://api.example.com/users' }] });
  });

  const payload = { tabId: 9, observations: [] };
  const report = await analyzeWithCore(payload);

  assert.deepEqual(receivedInput, payload);
  assert.deepEqual(report, { endpoints: [{ url: 'https://api.example.com/users' }] });
});

test('the service worker bridge does not use dynamic import', async () => {
  const source = await readFile(new URL('../src/wasm-bridge.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.match(source, /^import initializeWasm,/);
});

test('the service worker persists tab observations across worker restarts', async () => {
  const source = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');

  assert.match(source, /chrome\.storage\.session\.get/);
  assert.match(source, /chrome\.storage\.session\.set/);
  assert.match(source, /MAX_CAPTURE_BYTES/);
});

test('followPagination replays continuations until the reconstructed dataset is complete', async () => {
  const reports = [
    { structuredExtraction: { datasets: [{ id: 'jobs', pagination: { nextRequest: { method: 'GET', url: 'https://example.test/jobs?cursor=b' } } }] } },
    { structuredExtraction: { datasets: [{ id: 'jobs', pagination: { nextRequest: { method: 'GET', url: 'https://example.test/jobs?cursor=c' } } }] } },
    { structuredExtraction: { datasets: [{ id: 'jobs', pagination: { nextRequest: null } }] } },
  ];
  const replayed = [];
  const observations = [];
  let analysis = 1;

  const result = await followPagination({
    report: reports[0],
    datasetId: 'jobs',
    replayPage: async (request) => {
      replayed.push(request.url);
      return { status: 200, responseBody: '{}' };
    },
    recordObservation: (event) => observations.push(event),
    analyze: async () => reports[analysis++],
  });

  assert.equal(result.pagesFetched, 2);
  assert.equal(result.stopReason, 'complete');
  assert.equal(observations.length, 2);
  assert.deepEqual(replayed, [
    'https://example.test/jobs?cursor=b',
    'https://example.test/jobs?cursor=c',
  ]);
});

test('followPagination stops continuation loops', async () => {
  const report = { structuredExtraction: { datasets: [{ id: 'jobs', pagination: { nextRequest: { method: 'GET', url: 'https://example.test/jobs?cursor=same' } } }] } };
  const result = await followPagination({
    report,
    datasetId: 'jobs',
    replayPage: async () => ({ status: 200 }),
    recordObservation: () => {},
    analyze: async () => report,
  });

  assert.equal(result.pagesFetched, 1);
  assert.equal(result.stopReason, 'continuation-loop');
});

test('buildOfflineReplay embeds a network-independent searchable application view', () => {
  const html = buildOfflineReplay({
    pageProjection: { name: 'jobs' },
    structuredExtraction: {
      datasets: [{
        name: 'jobs',
        observedItems: 1,
        items: [{ id: '1', title: '</script><script>unsafe()</script>' }],
        presentation: { visibleFields: ['title'], machineOnlyFields: ['id'] },
      }],
    },
  });

  assert.match(html, /X-Ray Offline Reconstruction/);
  assert.match(html, /Search reconstructed records/);
  assert.match(html, /Show what wasn’t rendered/);
  assert.doesNotMatch(html, /<script>unsafe\(\)<\/script>/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('mergeApiGuide retains evidence and records longitudinal schema changes', () => {
  const first = {
    site: 'https://example.test', generatedAt: 1, endpoints: [{
      id: 'one', identity: 'GET:https://api.example.test/items', method: 'GET', origin: 'https://api.example.test', path: '/items',
      firstObserved: 1, lastObserved: 1, evidence: [{ id: 'a', timestamp: 1 }],
      response: { statuses: [200], schema: { type: 'object', properties: { id: { type: 'string', required: true } } } },
    }],
  };
  const second = structuredClone(first);
  second.generatedAt = 2;
  second.endpoints[0].lastObserved = 2;
  second.endpoints[0].evidence = [{ id: 'b', timestamp: 2 }];
  second.endpoints[0].response.schema.properties.name = { type: 'string' };

  let catalog = mergeApiGuide(undefined, first);
  catalog = mergeApiGuide(catalog, second);
  const site = catalog.sites['https://example.test'];

  assert.equal(site.endpoints[0].observedCount, 2);
  assert.equal(site.history.length, 2);
  assert.deepEqual(site.history[1].changes.changed[0].fieldsAdded, ['name']);
  const openapi = guideAsOpenApi(site);
  assert.deepEqual(openapi.paths['/items'].get.responses['200'].content['application/json'].schema.required, ['id']);
});
