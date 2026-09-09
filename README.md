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
2. Run focused tests:
   ```bash
   npm test
   ```
3. Load extension in Chromium:
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
- `deterministicArtifact`: canonical representation + stable artifact hash
- `connectors`: templates for Slack/Notion/Sheets integration
- `localReplay.featureFlags`: localStorage commands for replaying hidden flags
