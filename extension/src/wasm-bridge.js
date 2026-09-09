import { analyzeObservationSession } from './shared/xray-engine.js';

let wasmAnalyze = null;

export function setWasmAnalyzerForTests(analyzer) {
  wasmAnalyze = analyzer;
}

export function analyzeWithCore(payload) {
  if (typeof wasmAnalyze === 'function') {
    return wasmAnalyze(payload);
  }

  return analyzeObservationSession(payload);
}
