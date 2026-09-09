import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeObservationSession,
  buildDeterministicArtifact,
  detectFeatureFlags,
  detectThirdPartyIntegrations,
  inferSchema
} from '../src/shared/analyzer.js';

test('inferSchema infers nested object/array contracts', () => {
  const schema = inferSchema({
    id: 1,
    tags: ['a', 'b'],
    profile: { enabled: true }
  });

  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.id.type, 'number');
  assert.equal(schema.properties.tags.type, 'array');
  assert.equal(schema.properties.profile.properties.enabled.type, 'boolean');
});

test('detectFeatureFlags identifies likely flags across sources', () => {
  const flags = detectFeatureFlags({
    localStorage: { feature_checkout: 'true', random: 'x' },
    globals: { darkLaunchBeta: false }
  });

  assert.equal(flags.length, 2);
  assert.deepEqual(
    flags.map((flag) => flag.key),
    ['darkLaunchBeta', 'feature_checkout']
  );
});

test('detectThirdPartyIntegrations groups known third-party signatures', () => {
  const integrations = detectThirdPartyIntegrations([
    'https://js.stripe.com/v3',
    'https://www.google-analytics.com/g/collect',
    'https://api.example.com/v1/users'
  ]);

  assert.equal(integrations.stripe.length, 1);
  assert.equal(integrations.googleAnalytics.length, 1);
  assert.equal(integrations.paypal.length, 0);
});

test('buildDeterministicArtifact yields stable artifact id', () => {
  const report = {
    discoveredAt: 'time-a',
    endpoints: [
      { url: 'https://z.example.com', method: 'GET' },
      { url: 'https://a.example.com', method: 'POST' }
    ]
  };

  const first = buildDeterministicArtifact(report);
  const second = buildDeterministicArtifact({ ...report, discoveredAt: 'time-b' });
  const canonicalReport = JSON.parse(first.canonical);

  assert.equal(first.artifactId, second.artifactId);
  assert.equal(canonicalReport.endpoints[0].url, 'https://a.example.com');
});

test('analyzeObservationSession uses observation envelopes and raw snapshot inputs', () => {
  const report = analyzeObservationSession({
    tabId: 9,
    discoveredAt: '2026-01-01T00:00:00.000Z',
    observations: [
      {
        kind: 'network.response',
        method: 'GET',
        url: 'https://api.example.com/users?limit=10',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ users: [{ id: 1 }] })
      }
    ],
    snapshot: {
      localStorageData: { feature_checkout: 'true' },
      sessionStorageData: {},
      globalCandidates: { darkLaunchBeta: false },
      invisibleContent: { hiddenElements: [], hiddenInputs: [], metadata: {}, accessibilityOnly: [] },
      behavioralScripts: []
    }
  });

  assert.equal(report.endpoints[0].url, 'https://api.example.com/users');
  assert.equal(report.featureFlags.length, 2);
  assert.equal(report.confidence.score, 0.2);
});

test('analyzeObservationSession reconstructs structured collections with pagination and relationships', () => {
  const report = analyzeObservationSession({
    tabId: 11,
    discoveredAt: '2026-01-01T00:00:00.000Z',
    observations: [
      {
        kind: 'network.response',
        method: 'GET',
        url: 'https://jobs.example.com/api/jobs?cursor=abc',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobs: [
            {
              id: 'job-1',
              title: 'Senior Engineer',
              company: { id: 'co-1', name: 'Acme' },
              location: 'Boston'
            }
          ],
          nextCursor: 'def'
        })
      }
    ],
    snapshot: {}
  });

  const extraction = report.structuredExtraction;
  assert.equal(extraction.summary.collections, 1);
  assert.equal(extraction.summary.totalObservedItems, 1);

  const [dataset] = extraction.datasets;
  assert.equal(dataset.name, 'jobs');
  assert.equal(dataset.identity.field, 'id');
  assert.equal(dataset.pagination.type, 'cursor');
  assert.equal(dataset.pagination.cursorField, 'nextCursor');
  assert.equal(dataset.relationships[0].name, 'company');
  assert.equal(dataset.fields, 4);
});
