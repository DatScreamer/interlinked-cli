# Content scanner — `server_hosted` runtime

## Context

The remote-hosting plan (`content-scanner-remote-hosting.md`) describes three shapes of remote inference. Shape A (`custom_http`) works today. Shape B — the Interlinked MCP server hosting the inference endpoint — is the recommended v2 default because it amortizes all five operational costs of the local sidecar without asking teams to run their own infra. This doc fills in the concrete implementation plan.

**Goal:** Developers enable the scanner, nothing else. No `pip install`, no model download, no `HF_TOKEN`. The CLI discovers the endpoint from the active workspace's server registration and scans over the same authenticated channel the rest of the CLI already uses.

## Design

### New runtime value

Add `"server_hosted"` to `ContentScannerRuntime` in `src/harness/content-scanner/types.ts`:

```ts
export type ContentScannerRuntime = "local" | "huggingface" | "custom_http" | "server_hosted";
```

### New config shape

Add to `ContentScannerConfig`:

```ts
/** Server-hosted inference. Endpoint comes from the active workspace's server_url;
 *  auth reuses the existing CLI access token resolver. */
server_hosted: {
  /** Path appended to the active server_url. Default: "/api/content-scanner/scan". */
  endpoint_path: string;
  /** Default: 3000. Tighter than HTTP default because server-proxied hops are colocated. */
  timeout_ms: number;
};
```

Defaults ship in `src/harness/rules/default-config.ts`.

### New scanner backend

`src/harness/content-scanner/opf-server.ts` — thin wrapper that at scan time:

1. Reads `server_url` from `.interlinked/config.local.json` via `resolveConfig()`.
2. Reads the access token via `resolveAuthToken()` (src/lib/auth.ts) — same path `api-client.ts` uses for MCP tool proxying. Dev-mode localhost bypass already handled there.
3. POSTs `{text, source}` to `{server_url}{endpoint_path}` with `Authorization: Bearer <token>`.
4. Parses the HF token-classification response shape (reuses `parseHfResponse` from `opf-http.ts` — factor it into a shared helper).

Shape parity: same response schema as Shape A so the server implementation is free to proxy to HuggingFace, run its own OPF instance, or federate across models.

### Registry wiring

`src/harness/content-scanner/registry.ts` gets a new case:

```ts
case "server_hosted":
  return new OpfServerScanner(config);
```

### Server contract

The Interlinked MCP server (repo TBD — see CLAUDE.md for current terminology) exposes:

```
POST /api/content-scanner/scan
Authorization: Bearer <workspace-token>
Content-Type: application/json

{ "text": "<scan target>", "source": "Write.content" }

200 OK
[
  { "entity_group": "private_email", "score": 0.99, "word": "a@b.com", "start": 0, "end": 7 }
]

401 Unauthorized  — token missing/invalid
429 Too Many Requests — per-workspace rate limit
503 Service Unavailable — inference backend down (CLI fails open)
```

Server-side telemetry stores category counts + latency per workspace. Matched span text is NEVER persisted server-side (same rule the CLI enforces on the reason line).

## Files touched

| Path | Change |
|---|---|
| `src/harness/content-scanner/types.ts` | Add `"server_hosted"` to `ContentScannerRuntime` union; add `server_hosted` field to `ContentScannerConfig`. |
| `src/harness/content-scanner/opf-server.ts` | **New.** `OpfServerScanner` class. |
| `src/harness/content-scanner/opf-http.ts` | Factor `parseHfResponse` into an exported helper so both HTTP backends share it. |
| `src/harness/content-scanner/registry.ts` | New `case "server_hosted":`. |
| `src/harness/rules/default-config.ts` | Add `server_hosted` defaults to `DEFAULT_CONFIG.content_scanner`. |
| `src/harness/content-scanner/__tests__/opf-server.test.ts` | **New.** Mocks fetch + config loading; asserts auth header, endpoint resolution, fail-open on 503. |
| `docs/harness.md` | Runtime table gains `server_hosted` row. |

Estimate: ~80 LOC new code, ~30 LOC test, ~20 LOC config/doc changes. One afternoon.

## Migration for existing users

```diff
 {
   "content_scanner": {
     "enabled": true,
-    "runtime": "local"
+    "runtime": "server_hosted"
   }
 }
```

No `custom_http` block required because the endpoint + auth come from the workspace registration. First scan hits the remote server; the local Python sidecar (if spawned) drains via idle-shutdown.

## Rollout

1. **Server-side:** stand up the endpoint behind a feature flag. Log requests.
2. **CLI-side:** ship the `server_hosted` runtime behind the same env flag (e.g., `INTERLINKED_CONTENT_SCANNER_SERVER_HOSTED=1`) for opt-in testing.
3. **Dogfood:** switch internal workspaces to `runtime: "server_hosted"`. Compare latency + FP rate against local sidecar baselines.
4. **Default flip:** change `DEFAULT_CONFIG.content_scanner.runtime` from `"local"` to `"server_hosted"` for newly-enabled workspaces. Existing configs unchanged.

## Verification

- Unit: `opf-server.test.ts` mocks `fetch` + `resolveAuthToken`, asserts request URL = `{server_url}/api/content-scanner/scan`, Bearer header present, fail-open on 401/503/network error.
- Integration: the existing `integration.test.ts` gets a new describe block using a stub `OpfServerScanner`; reuses the round-trip inbound→outbound chain.
- Manual smoke: stand up a local mock server, point CLI at it, run a Write with a fake email, verify the scan fires and the server logs the request.

## Open questions

- **Batching**: split a 15 KB diff across many small requests, or one big one? Bigger request = higher tail latency; smaller = more server RTTs. Measure.
- **Request-id correlation**: the CLI could attach a scan request-id that flows into server telemetry for cross-system debugging. Low priority.
- **Failure budget**: if the server is down for >N consecutive calls per session, should the CLI auto-fallback to local sidecar? Probably yes, but the fallback path is new complexity that deserves its own design.
