import test from 'node:test';
import assert from 'node:assert/strict';

import {
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
