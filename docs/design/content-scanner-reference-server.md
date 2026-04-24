# Content scanner — reference HTTP server

## Context

The remote-hosting plan sketches a minimal FastAPI wrapper around `opf.OPF`. This doc turns that sketch into something teams can actually deploy: a directory in this repo, a Dockerfile with pre-baked weights, deploy recipes for four target platforms, and a hardening checklist.

**Non-goals:** model training, fine-tuning, multi-tenant auth. The reference server is single-tenant behind a static Bearer token; teams that need more should fork it.

## Layout

```
reference-servers/opf-http/
├── main.py              # FastAPI app, ~40 LOC
├── Dockerfile           # Python 3.12 + opf + uvicorn, pre-downloads the model
├── requirements.txt     # fastapi, uvicorn[standard], opf
├── .dockerignore
├── healthz.py           # Separate module so container healthchecks don't pay for model load
├── README.md            # Build + deploy recipes (per target below)
└── deploy/
    ├── flyio.toml       # Fly.io GPU machine config
    ├── modal.py         # Modal serverless definition
    ├── runpod.yaml      # RunPod template
    └── cloudflare.toml  # Cloudflare Container config (beta)
```

`reference-servers/` lives at the repo root, is **gitignored from npm publish** (not shipped to CLI consumers), but IS in git so teams can copy it.

## API contract

One endpoint, one healthcheck:

```
POST /scan
Authorization: Bearer <OPF_BEARER_TOKEN env var>
Content-Type: application/json

{ "inputs": "<text to scan>" }

200 → HF token-classification shape:
[
  { "entity_group": "private_email", "score": 1.0, "word": "a@b.com", "start": 0, "end": 7 }
]

401 → Missing / wrong token
413 → Input exceeds MAX_INPUT_BYTES (32_000 default)

GET /healthz
200 → {"ok": true, "model": "openai/privacy-filter", "loaded": true, "warm": true}
```

`score` is always `1.0` — OPF's Viterbi decode is a global-path optimization, not per-span confidence. Downstream clients that want a real confidence should use `gpt-oss-safeguard` with the same endpoint contract.

## Dockerfile strategy

Two-stage build, model baked in at build time so container cold starts don't pay the 2.6 GB HuggingFace download every time:

```dockerfile
FROM python:3.12-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM base AS weights
# Pre-download the checkpoint to the image. The `ensure_default_checkpoint`
# helper pulls to ~/.opf/privacy_filter; we redirect to a known location so
# the runtime stage can COPY it in.
ENV OPF_CHECKPOINT=/app/checkpoint
RUN mkdir -p /app/checkpoint && \
    python -c "import os; os.environ['OPF_CHECKPOINT']='/app/checkpoint'; \
               from opf._common.checkpoint_download import ensure_default_checkpoint; \
               ensure_default_checkpoint()"

FROM base AS runtime
COPY --from=weights /app/checkpoint /app/checkpoint
COPY main.py healthz.py /app/
ENV OPF_CHECKPOINT=/app/checkpoint
ENV OPF_BEARER_TOKEN=changeme
EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
```

Image size budget: ~5 GB (torch + CUDA libs + 2.6 GB model). CPU-only variant drops to ~3 GB by installing `torch` from the CPU wheel index.

## Deploy recipes

Each is a self-contained example in `deploy/`. CLI users pick one.

| Target | Best for | Cost rough order | GPU? |
|---|---|---|---|
| **Fly.io** | Teams that want a dedicated always-on endpoint, simple ops | ~$2–10/day idle, plus traffic | Yes (A10) |
| **Modal** | Variable traffic, pay-per-inference, cold-starts OK | ~$0.50/1000 scans | Yes (T4/A10/A100) |
| **RunPod** | Cheapest dedicated GPU, more DIY | ~$0.40–2/hr reserved | Yes (wide selection) |
| **Cloudflare Container** (beta) | Teams already on Cloudflare, Workers-adjacent | Beta pricing — check current docs | Depends on the tier |
| **Self-hosted k8s / Fly Machines CLI / EC2** | Full control, compliance-driven | — | Your choice |

Each deploy recipe has a one-command bootstrap:

```bash
# Fly.io
fly launch --image ghcr.io/<your-org>/opf-http:latest
fly secrets set OPF_BEARER_TOKEN=$(openssl rand -base64 32)

# Modal
modal deploy reference-servers/opf-http/deploy/modal.py

# RunPod (via CLI)
runpodctl deploy --template reference-servers/opf-http/deploy/runpod.yaml
```

After deploy, users flip CLI config to `runtime: "custom_http"` pointing at the deployed endpoint.

## Hardening checklist

Ship the checklist inline in the README so nobody deploys the reference server thinking it's production-ready out of the box:

- [ ] Generate a real `OPF_BEARER_TOKEN` (32+ bytes of randomness, rotate on schedule).
- [ ] Front with TLS — Fly.io and Modal give this for free; DIY deploys need a reverse proxy.
- [ ] Set `MAX_INPUT_BYTES` per your org's diff-size ceiling. Default 32 KB is reasonable.
- [ ] **Do not log the `inputs` field.** Reference server does stdlib-uvicorn access logging which only records method + path + status. If you add custom logging, assert no body capture.
- [ ] Add a rate limiter at the ingress (Fly.io `[services.concurrency]`, Cloudflare WAF rule, etc.) to prevent runaway scan loops from a compromised agent.
- [ ] Pin the `opf` package version in `requirements.txt`. Don't float to latest in prod.
- [ ] Monitor GPU memory via the platform's dashboard — OPF loads ~1.3 GB per worker; don't over-subscribe.
- [ ] Set `uvicorn --workers 1` — OPF is thread-unsafe; one worker per container, scale horizontally.

## Verification

- **Unit** (in the reference-server dir, optional): `pytest` against `main.py` with a test client, asserting the response shape and 401 behavior.
- **Integration** (CLI side): the existing CLI integration test works unchanged — it points at `custom_http` with a mocked endpoint. Swap the mock for a running local container in a compose file to smoke-test.
- **Load test**: `wrk -t2 -c10 -d30s -s inputs.lua http://localhost:8080/scan`. Target: warm p50 <200 ms for 1 KB input on CPU, <50 ms on GPU.

## Rollout

1. Land the directory. Publish one canonical image to `ghcr.io/quentincody/opf-http:<version>` tagged with the `opf` package version.
2. Add a row to `docs/harness.md`'s "Runtime backends" table pointing at the reference server + image.
3. Cut a blog post / README callout: "Deploy the scanner as a shared service in one command."
4. Optional: publish a Helm chart for k8s deploys once usage shape is clear.

## Open questions

- **Streaming vs batching**: should the server support a streaming endpoint for very long content (>100 KB)? Not needed for v1 given the 100 KB CLI cap.
- **Multi-model**: once `gpt-oss-safeguard` ships, the reference server should support multiple models behind the same endpoint with `model` in the request body. Wait until usage forces the question.
- **Image distribution**: ship to ghcr.io vs docker.io vs public ECR — pick one, not a decision to defer.
