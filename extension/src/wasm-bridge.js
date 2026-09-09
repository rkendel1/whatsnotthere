let wasmAnalyzer = null;
let wasmInitialization = null;

export function setWasmAnalyzerForTests(analyzer) {
  wasmAnalyzer = analyzer;
  wasmInitialization = null;
}

export async function initializeCore() {
  if (typeof wasmAnalyzer === 'function') return wasmAnalyzer;

  if (!wasmInitialization) {
    wasmInitialization = import('./wasm/xray_wasm.js').then(async ({ default: initialize, analyze_observations }) => {
      await initialize(chrome.runtime.getURL('src/wasm/xray_wasm_bg.wasm'));
      wasmAnalyzer = analyze_observations;
      return wasmAnalyzer;
    });
  }

  return wasmInitialization;
}

export async function analyzeWithCore(payload) {
  const analyze = await initializeCore();
  return JSON.parse(analyze(JSON.stringify(payload)));
}
