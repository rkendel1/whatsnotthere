let wasmAnalyzer = null;
let wasmInitializer = null;
let wasmInitialization = null;

export function configureWasm(initializer, analyzer) {
  wasmInitializer = initializer;
  wasmAnalyzer = analyzer;
  wasmInitialization = null;
}

export function setWasmAnalyzerForTests(analyzer) {
  wasmAnalyzer = analyzer;
  wasmInitializer = null;
  wasmInitialization = null;
}

export async function initializeCore() {
  if (typeof wasmAnalyzer !== 'function') {
    throw new Error('The X-Ray WASM analyzer has not been configured. Run npm run build.');
  }

  if (!wasmInitializer) return wasmAnalyzer;

  if (!wasmInitialization) {
    wasmInitialization = wasmInitializer()
      .then(() => wasmAnalyzer)
      .catch((error) => {
        wasmInitialization = null;
        throw error;
      });
  }

  return wasmInitialization;
}

export async function analyzeWithCore(payload) {
  const analyze = await initializeCore();
  return JSON.parse(analyze(JSON.stringify(payload)));
}
