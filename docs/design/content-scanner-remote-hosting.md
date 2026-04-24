# Content scanner — remote-hosting plan

## Why move off the local sidecar

The local Python sidecar works as a proof of capability but has five operational costs that make it a poor default for a team:

1. **Python + torch prereq** on every developer machine (~2 GB install).
2. **Per-developer model download** (~2.6 GB to `~/.opf/privacy_filter`) on first use.
3. **Cold-load cost** on every harness restart (multi-second for the 1.5B-param MoE; ~1.3 GB resident after warmup).
4. **CPU-only on Apple Silicon** — upstream OPF supports `cpu` / `cuda` only, no MPS. Every scan on a Mac laptop is CPU-bound and serialized behind the queue.
5. **No observability** — errors surface as `[interlinked:opf-local]` lines on one developer's stderr; a team can't see aggregate detection rates, FP rates, or latency.

Moving the inference to a single remotely-hosted service amortizes (1)–(3) to one deploy, fixes (4) with a GPU, and makes (5) trivial.

## The three shapes of remote hosting

In increasing order of integration depth:

### Shape A — Bring-your-own endpoint (ready today)

The existing `opf-http.ts` backend posts `{"inputs": "<text>"}` and parses HuggingFace token-classification responses. Any endpoint that matches that contract works. Users switch by editing `guard-rules.local.json`:

```jsonc
{
  "content_scanner": {
    "enabled": true,
    "runtime": "custom_http",
    "custom_http": {
      "endpoint": "https://opf.example.com/scan",
      "api_key_env": "OPF_API_KEY",
      "timeout_ms": 4000
    }
  }
}
```

**Expected response shape** (one object per detected span):

```json
[
  { "entity_group": "private_email", "score": 0.99, "word": "alice@example.com", "start": 12, "end": 29 },
  { "entity_group": "secret",        "score": 0.97, "word": "sk_live_abc",       "start": 40, "end": 51 }
]
```

A minimal FastAPI wrapper around `opf.OPF` is ~30 lines; see "Reference server" below.

### Shape B — Interlinked-hosted endpoint (recommended v2)

The Interlinked MCP server (`QuentinCody/mcp-agent-chat`) adds an inference endpoint, CLI points at it automatically when the workspace is registered. This gives:

- Zero per-developer setup (no `pip install`, no model download).
- Shared model instance → lower cost, warm cache across developers.
- Centralized telemetry: detection counts, FP reports, category distribution.
- Token-level auth reuses existing workspace OAuth.

**Proposed CLI config additions**:

```ts
// ContentScannerConfig — new fields
runtime: "server_hosted";            // NEW
server_hosted: {
  // Optional — defaults to the active server's base URL.
  endpoint_path: string;              // default: "/api/content-scanner/scan"
  timeout_ms: number;                 // default: 3000
};
```

When `runtime === "server_hosted"`, the scanner:
- Reads `server_url` from `.interlinked/config.local.json` (same field `mcp-agent-chat` registration writes).
- Reads the existing access token via `resolveAuthToken()` from `src/lib/auth.ts`.
- POSTs to `{server_url}{endpoint_path}` with `Authorization: Bearer <token>` + `{"text": "<content>"}`.
- Expects the same HF-compatible span-array response shape as Shape A.

No new auth plumbing needed — the token resolver is already used by `api-client.ts` for MCP tool proxying.

**Server-side deploy options** (user's choice):
- **Cloudflare Container** (in beta) running the reference server — matches the existing server stack.
- **Modal / RunPod / Replicate** with a published image — managed GPU, pay-per-inference.
- **Paid HuggingFace Inference Endpoint** — one-click deploy, closest to zero-ops.
- **Self-hosted Fly.io / k8s pod** — full control, run on your own infra.

### Shape C — Federated / Multi-model (future)

Once Shape B lands, a natural extension is routing by content type / tool class:

```jsonc
{
  "content_scanner": {
    "routes": [
      { "when": { "tool": "Bash" },        "model": "openai/privacy-filter" },
      { "when": { "hook": "pre_external_egress" }, "model": "openai/gpt-oss-safeguard-20b" },
      { "default": true,                    "model": "openai/privacy-filter" }
    ]
  }
}
```

This lets gpt-oss-safeguard handle policy-heavy egress evaluation while privacy-filter handles routine PII scanning. Both go through the same `ContentScanner` interface.

## Reference server (Shape A)

A minimal HTTP wrapper around the OPF package. Ships a single process serving the same JSON shape the scanner already parses. Copy into a project as `reference-servers/opf-http/main.py`:

```python
# Apache-2.0. Minimal reference server for the Interlinked content scanner.
# Usage: uvicorn main:app --host 0.0.0.0 --port 8080
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from opf import OPF

app = FastAPI()
opf = OPF(device="cuda")  # use "cpu" if no GPU

class ScanReq(BaseModel):
    inputs: str

@app.post("/scan")
def scan(req: ScanReq):
    result = opf.redact(req.inputs)
    return [
        {
            "entity_group": span.label,
            "score": 1.0,               # OPF viterbi decode is global-path; no per-span score
            "word": span.text,
            "start": int(span.start),
            "end": int(span.end),
        }
        for span in result.detected_spans
    ]

@app.get("/healthz")
def healthz():
    return {"ok": True, "model": "openai/privacy-filter"}
```

Dockerfile (same directory):

```dockerfile
FROM python:3.12-slim
RUN pip install --no-cache-dir fastapi uvicorn[standard] opf
# Pre-download the model at build time so container cold-starts don't pay the 2.6 GB download cost.
RUN python -c "from opf._common.checkpoint_download import ensure_default_checkpoint; ensure_default_checkpoint()"
COPY main.py /app/main.py
WORKDIR /app
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
```

## Migration path for existing users

Users who have the local sidecar running today migrate with one config change; no code change, no CLI update.

```diff
 {
   "content_scanner": {
     "enabled": true,
-    "runtime": "local"
+    "runtime": "custom_http",
+    "custom_http": {
+      "endpoint": "https://opf.yourteam.example.com/scan",
+      "api_key_env": "OPF_API_KEY",
+      "timeout_ms": 4000
+    }
   }
 }
```

`interlinked harness restart` picks up the new config; the next scan hits the remote endpoint; the local Python process never spawns again.

## Security considerations

- **Text sent to the remote endpoint is the exact content being scanned** — diffs, command bodies, URLs, MCP payloads. Any org moving to a remote service must confirm the inference provider's data-retention policy matches their compliance posture. For a privacy filter, a provider that logs inputs is self-defeating.
- **Prefer TLS + mutual auth** (short-lived tokens over Bearer headers, or mTLS) for any endpoint not colocated with the developer machines.
- **Log only category + count**, never the matched span text, on the server side. The CLI already enforces this on the reason line; the server's telemetry should follow the same rule.
- **Allowlist egress on the harness** if you want to prevent operators from pointing the scanner at an adversarial endpoint. A compromised `guard-rules.local.json` with `custom_http.endpoint` set to an attacker URL would exfiltrate the very content the scanner was built to protect.

## Open questions for v2

- **Batch API** — scanning a 15 KB diff as one request vs splitting by function. Latency / accuracy tradeoff to measure.
- **Streaming responses** — for very long content, stream span findings as they're decoded so the CLI can early-block.
- **Caching** — identical content → identical findings. A content-hash → findings cache cuts repeated-edit cost to zero. Cache key should be `sha256(text)`; TTL short (~5 min) to avoid reused taint decisions if the model is retrained.
- **Routing policy** — ship a sensible default for Shape C that privacy-filter users get automatically (`privacy-filter` for PII scanning, `gpt-oss-safeguard` for policy evaluation of external-egress calls).
