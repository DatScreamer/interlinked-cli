# Local Semantic Function Index

Interlinked's semantic index is an experimental, optional, local-only way to
find code by meaning or by similarity to an existing function. It does not
participate in edit blocking and does not require the Interlinked MCP Server.

## Quick start

The runtime requires compatible local llama.cpp `llama-embedding` and
`llama-tokenize` executables. Interlinked does not install those binaries.

```bash
interlinked semantic models
interlinked semantic install --model nomic-embed-text-v1.5-q4
interlinked semantic index
interlinked semantic search "validate a signed webhook"
interlinked semantic similar src/webhooks.ts --line 84
interlinked semantic status
```

Only `semantic install` downloads anything. It displays the pinned model
revision, Apache-2.0 license, size, source, and cache destination before the
download; then it bounds the stream, verifies the exact byte count and SHA-256,
and atomically promotes the artifact. `enable`, `adopt`, `doctor`, metrics,
hooks, status, indexing, and search never acquire a missing model.

The initial experimental model is
`nomic-embed-text-v1.5-q4@0188c9bf409793f810680a5a431e7b899c46104c`
(Nomic Embed Text v1.5, GGUF Q4_K_M, 768 dimensions). The full model/runtime
fingerprint, rather than its alias or vector dimension, identifies compatible
index generations.

## Canonical tokens versus model tokens

These are separate measurements:

| Measurement | Purpose | Stability | Long-input behavior |
|---|---|---|---|
| Canonical tokens (`interlinked-code-v1`) | The hard `max_function_tokens` quality cap | Versioned by Interlinked; independent of ML models | 500 passes, 501 is over; no truncation or model fallback |
| Model tokens | Embedding input fit and retrieval metadata | Bound to the selected model, tokenizer, runtime, and fingerprint | Full input is syntax-chunked with overlap and aggregated; never silently truncated |

Changing embedding models cannot loosen, tighten, redefine, or suppress the
500-token gate. Unsupported hard-gate languages are visibly not measured; no
heuristic or embedding tokenizer is allowed to make a blocking decision.

## Commands

```text
interlinked semantic models [--json]
interlinked semantic install --model <alias> [--json]
interlinked semantic index [--rebuild] [--include-tests] [--cwd <path>] [--json]
interlinked semantic status [--cwd <path>] [--json]
interlinked semantic search <query> [--top <n>] [--language <id>] [--path <glob>] [--cwd <path>] [--json]
interlinked semantic similar <file> --line <n> [--top <n>] [--cwd <path>] [--json]
```

`index` reuses vectors whose complete deterministic embedding input and active
fingerprint are unchanged. `--rebuild` disables reuse. Product source is the
default; `--include-tests` temporarily includes eligible test/spec functions.
Unsupported exact adapters and individual unindexable functions are counted
in the completion census rather than silently disappearing.

`search` embeds a query locally and exact-scans cosine similarity. Filters are
applied to already-confined repository-relative index rows. `similar` selects
the innermost indexed implementation containing the requested line, uses its
stored vector, and excludes that function from the results. Result order is
score descending, then file, line, and symbol; every human and JSON result
names the fingerprint and staleness.

## Configuration

Committed `.interlinked/semantic.json` is team policy:

```json
{
  "version": 1,
  "enabled": false,
  "model": "nomic-embed-text-v1.5-q4@0188c9bf409793f810680a5a431e7b899c46104c",
  "include_tests": false,
  "include": ["src/**"],
  "exclude": []
}
```

Gitignored `.interlinked/semantic.local.json` contains only machine topology:

```json
{
  "version": 1,
  "device": "auto",
  "threads": 0,
  "batch_size": 0,
  "idle_unload_ms": 300000,
  "incremental_indexing": true
}
```

Zero values request runtime auto-tuning. Optional
`llama_embedding_command`/`llama_tokenize_command` values can name local
executables. Unknown fields—including remote URLs, API credentials, and cloud
fallbacks—are rejected. The `enabled` field is reserved for automatic
idle/incremental scheduling; current manual commands remain explicit operator
actions.

Weights live in the platform user cache, optionally relocated with
`INTERLINKED_MODEL_CACHE`. Project metadata/vectors live in the gitignored
`.interlinked/index/functions/` tree. Neither vectors nor query text are
committed, persisted as history, or synchronized.

## Index integrity and states

Each build writes a new temporary generation containing JSONL function rows,
little-endian float32 vectors, and metadata with exact lengths and SHA-256
hashes. Interlinked validates the complete generation before atomically
updating `CURRENT`; a crash cannot partially overwrite the prior generation.

`semantic status` reports:

- `absent` — verified model available, no generation built;
- `building` — an unpublished build generation exists;
- `current` — active fingerprint and source census match;
- `stale` — source changed; the last complete generation remains queryable
  with a warning;
- `model-missing` or `runtime-missing` — local prerequisite unavailable;
- `model-mismatch` — active runtime/model fingerprint differs from `CURRENT`;
- `corrupt` — generation shape, length, hash, offset, or vector validation
  failed.

Corrupt and mismatched indexes fail closed for semantic queries but fail open
for code editing. Restore the exact local model/runtime and run
`interlinked semantic index --rebuild`; do not hand-edit vectors, metadata,
fingerprints, or `CURRENT`.

## Experimental boundary

The current release deliberately uses pure vector retrieval. It does not run a
remote backend, LLM reranker, or hybrid lexical/vector fusion, and it does not
schedule embedding work in a blocking hook response. Automatic daemon idle
indexing and promotion from experimental status wait for the held-out retrieval
quality and local hardware/resource-isolation gates in plan 29.
