# whatsnotthere

Website X-Ray MVP browser extension for discovering hidden layers of websites:
- undocumented/shadow APIs captured from fetch + XHR traffic
- inferred hidden data contracts (JSON schema-style shape inference)
- feature flags and dark launches surfaced from storage/globals
- invisible content (hidden DOM, metadata, accessibility-only nodes)
- third-party integrations and behavioral scripts
- deterministic local artifacts and connector templates (Slack/Notion/Sheets)

## Run locally

1. Install dependencies (none beyond Node runtime required):
   ```bash
   npm install
   ```
2. Build the Rust analyzer into the loadable extension directory:
   ```bash
   npm run build
   ```
3. Run focused tests:
   ```bash
   npm test
   ```
4. Load extension in Chromium:
   - Open `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked**
   - Select `/home/runner/work/whatsnotthere/whatsnotthere/extension`
4. Open any site, interact with it, then click **Website X-Ray** extension icon and run scan.

## MVP output

The extension popup produces a report containing:
- `endpoints`: normalized methods/URLs and inferred schemas from captured JSON responses
- `featureFlags`: detected flags from storage and globals
- `invisibleContent`: hidden fields/elements and metadata
- `behavioralScripts`: script references with behavior-tracking signatures
- `integrations`: detected third-party services
- `structuredExtraction`: reconstructed dataset collections with schema, identities, pagination, and relationships
- `deterministicArtifact`: canonical representation + stable artifact hash
- `connectors`: templates for Slack/Notion/Sheets integration
- `localReplay.featureFlags`: localStorage commands for replaying hidden flags

## Architecture direction

The extension now acts as a browser sensor + transport shell:
- content/injected scripts emit observation envelopes (`network.response`) and raw snapshot metadata
- background forwards observations to a core analysis boundary (`extension/src/wasm-bridge.js`)

A Rust engine boundary is scaffolded for deterministic analysis portability:
- `core/` contains `xray-core` modules for observation normalization, inference, integrations, confidence, and artifact generation
- `wasm/` exposes `analyze_observations(input_json)` so the same core can be consumed from WASM

The loaded extension invokes the Rust analyzer through `extension/src/wasm/xray_wasm.js`; JavaScript only captures browser observations, initializes WASM, and renders the returned report. The extension itself serves the generated WASM asset from its `chrome-extension://` origin, so no separate HTTP development server is required.
