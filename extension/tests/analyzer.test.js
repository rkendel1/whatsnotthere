import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeWithCore, setWasmAnalyzerForTests } from '../src/wasm-bridge.js';

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
