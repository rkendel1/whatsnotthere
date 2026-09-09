import initializeWasm, { analyze_observations as analyzeObservations } from './wasm/xray_wasm.js';
import { configureWasm } from './core-adapter.js';

configureWasm(
  () => initializeWasm({
      module_or_path: chrome.runtime.getURL('src/wasm/xray_wasm_bg.wasm'),
  }),
  analyzeObservations,
);

export { analyzeWithCore, initializeCore, setWasmAnalyzerForTests } from './core-adapter.js';
