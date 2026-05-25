# Supermodel — Port Groundwork

**Status:** ⏳ PLACEHOLDER / pre-staging. Supermodel's server-side graph engine — the only part worth porting — is **not public**. This doc lays the groundwork so a port can happen fast *if and when* it is open-sourced, and defines what we can do in the meantime. Sections marked ⏳ are deliberately empty until source is available.
**Created:** 2026-05-21
**Companion:** [`docs/external-pulse/supermodel.md`](../external-pulse/supermodel.md) (rubric intake) · `reference_supermodel_*` memories
**Blocked on:** (1) the server graph engine being open-sourced; (2) the license it ships under.

---

## TL;DR

If Supermodel open-sources its **graph engine**, Interlinked could run Supermodel-grade code graphs **locally, with zero upload** — closing the exact gap Supermodel itself can't close (its whole product is a cloud round-trip). This doc is the placeholder for that port. The **empty slot is the engine**; everything around it — the licensing gate, the integration seam, the reference spec, the runbook — is scaffolded here now. The port is gated on one fact we don't yet have: **the license.** Permissive → port. Copyleft → port only if we accept relicensing all of interlinked-cli. Source-available (BSL/SSPL/FSL) → do not port, integrate only.

**Do-now, no source required:** §7(a) define a `GraphEngine` interface and make the existing `project-graph.ts` implement it — that turns the eventual port into "add one more implementation." §9(b) subprocess-spike the already-MIT `supermodel` binary to find out whether their engine is even worth porting.

---

## 1. The bet

Supermodel is a **cloud** code-graph engine. Interlinked is a **local-first** harness that already carries a graph substrate (`project-graph.ts`, `impact-analysis.ts`, `structural-checks.ts`, `trigram-index.ts`). The two are architectural opposites — and that is precisely the opening. Supermodel's structural weakness is the mandatory cloud round-trip (latency, the privacy story, the "do you store my code" hedge, the offline-never story). If Supermodel open-sources the engine, Interlinked can run that engine **in-process, offline, no exfiltration** — Supermodel's graph quality on Interlinked's delivery model.

The bet of this doc: pre-map the port so that the day the source drops, the work is "fill in the slot and run the checklist," not "start a project." The placeholder is the engine slot; the scaffold is everything else.

Reality check on "instant": a true port is not instant and not a file-copy — see §5 (language mismatch) and §2 (license gate). What *is* achievable is **fast**, because the license decision, the integration seam, the reference spec, and the runbook are all pinned here in advance.

## 2. The licensing gate — READ FIRST

**Hard rule: no Supermodel code enters `interlinked-cli` until the license is known and cleared against the matrix below.** "Open-sourced" is not one thing. This section is the gate; §8 (the runbook) cannot start until it passes.

### 2.1 Current license state (verified 2026-05-21)

| Component | License | Status for a port |
|---|---|---|
| `cli` (Go) | **MIT**, © 2026 Supermodel | Borrowable now, with attribution. But Go ≠ our stack — see §5. |
| `mcp` (TS) | **MIT** | Borrowable now, with attribution. |
| `audit` / dead-code-hunter (TS) | **MIT** | Borrowable now, with attribution. |
| `sdk` (TS) | **`UNLICENSED`** | **Not borrowable.** A public repo with no LICENSE file is *all rights reserved*. GitHub's ToS grants viewing and forking — **not** use, modification, or redistribution. Do not copy from it. |
| **server graph engine** (Java control plane + TS data plane) | **No public repo** | The port target. Its eventual license is the entire decision below. |

### 2.2 The decision matrix (apply when the engine drops)

| License class | Examples | Effect on a port into `interlinked-cli` | Verdict |
|---|---|---|---|
| Permissive | MIT, Apache-2.0, BSD, ISC | Port OK. Preserve the copyright notice in every ported file + a `NOTICE`. Apache-2.0 additionally grants patent rights (a plus). | **PORT** |
| Weak copyleft | MPL-2.0, LGPL-3.0 | Portable, but the ported files stay under their license. Manageable if isolated to a `supermodel/` subtree with headers intact. | **PORT, isolated** |
| Strong copyleft | GPL-3.0, GPL-2.0 | Linking it into interlinked-cli forces **the whole CLI to GPL**. Whole-project relicense. | **NO** (unless we choose to relicense) |
| Network copyleft | AGPL-3.0 | Worst case for us: interlinked-cli ships a **harness server** (Unix-socket daemon) and pairs with a cloud server. AGPL's "interact over a network" clause can reach that surface. | **NO** unless interlinked-cli itself goes AGPL |
| Source-available | BSL/BUSL, SSPL, Elastic v2, FSL | "Open" only loosely — these carry a **competing-use / field-of-use restriction**. Interlinked's code-graph + harness features are plausibly "competing." Likely **blocks the exact use we want**. | **NO port — integration only** |

One-line gate: **permissive → port; copyleft → port only if we accept the relicense; source-available → don't port, integrate.**

### 2.3 Notes that bite

- Even **MIT requires attribution** — the copyright notice must travel with every ported file, plus a `NOTICE` / attribution entry. This is not optional and not a formality.
- A **dual license** ("MIT for the CLI, BSL for the engine") is the most likely shape for a VC-less startup protecting its one moat. Read the *engine's* LICENSE, not the org's.
- "Open core" / "open-sourced soon" from a company whose entire revenue is the hosted engine usually means **source-available**, not permissive. Plan for the §2.2 bottom row; be pleasantly surprised if not.
- If the engine is permissive but **depends on** a copyleft library, the transitive license still bites. Audit the dep tree (§8 step 5).

## 3. Reference spec — what Supermodel is

This is the teardown to **diff their real source against** on open-source. If their architecture has drifted from this, that drift is the first thing to map.

### 3.1 Company

- **Entity:** "The Bounty App, Inc." (homepage JSON-LD). **Team:** ~3 — Grey Newell (CTO, ex-AWS; infra + benchmark posts), Jonathan Popham (founding engineer; most blog posts), Lance Robertson. Nearly every commit is co-authored with a Claude model.
- **Funding:** none disclosed. **Pricing:** Pro $19/mo (3M LOC/mo, 25 MB uploads), Growth $199/mo (30M LOC/mo, 50 MB), 14-day trial, no card. Pre-traction (`cli` 83★, `mcp` 15★, `sdk` 9★).
- **Runway risk:** a ~3-person, unfunded team that has already pivoted once and archived five repos. "Open-source the engine" is as plausibly a distress signal as a strategy. Track it (§9d).

### 3.2 Timeline & the pivot

- **Oct 2025** — org/docs created; API + site built first.
- **Dec 2025 – Mar 2026** — **MCP-server-first era.** The product was a TypeScript MCP server. Tool surface thrashed: 8 → 4 → 2 tools. They published their own SWE-bench result showing the MCP server made agents **~15% worse** at resolving tasks — the reason for the pivot.
- **Mar 31, 2026** — **`cli` repo created. The pivot:** static `.graph` files read via `cat`/`grep`, zero runtime dependency, survives context compaction.
- **Apr 2, 2026** — mass archival; satellite products folded into CLI subcommands (`bigiron`→`factory`, `Uncompact`→`restore`, `arch-docs`→`docs`).
- **May 2026** — CLI v0.6.x (primary product), MCP/SDK v1.1.9. Steady, low-volume cadence.

### 3.3 The API

`api.supermodeltools.com` — **9 endpoints**, two tiers (the deliberate "primitives make no decisions / analyses make the obvious ones" split):

- **5 graph primitives:** `POST /v1/graphs/{parse,dependency,call,domain,supermodel}`
- **4 analyses:** `POST /v1/analysis/{dead-code,impact,circular-dependencies,test-coverage-map}`

- **Auth:** `X-Api-Key` (keys prefixed `smsk_`).
- **Request:** `multipart/form-data`, `file` = repo zip; `impact` also accepts a `diff` field.
- **Async model:** POST zip → `202` + `Retry-After` → **re-POST the same `Idempotency-Key`** to poll → `200` with `result`. There is no `GET /jobs/{id}`: *"polling IS submission."* Idempotency enforced by a Postgres `UNIQUE(idempotency_key, user_id, api_key_id)` constraint.
- **Server architecture** (from their best blog post): **control plane = Java/Spring Boot**; **data plane = TypeScript/Node** (zero public ingress); **Postgres (Citus) as the only infrastructure** — job queue + state machine + result store, no Redis, no message broker; Azure Blob for zip storage. Workers claim jobs `FOR UPDATE SKIP LOCKED`, parse with **tree-sitter**, call LLMs (OpenRouter + Google AI) for domain naming, write JSONB. Source deleted in "seconds," worst case 60 min.

### 3.4 The CLI

Go 1.25, cobra, **4 deps, no parser** — a thin client. ~21 commands. Distributed via checksummed GitHub-release tarballs (`install.sh` does sha256 verification), a Homebrew tap, and an npm wrapper that just downloads the binary.

The **watcher daemon** (`internal/shards/daemon.go`) is the genuinely well-built part: loads a fingerprinted `.supermodel/` cache or does a full API generate; listens on **UDP `:7734`** (the Claude Code `PostToolUse` hook posts changed paths) or `--fs-watch`; on change zips only changed files, calls the API incrementally, and **merges** the partial graph into the cache (node-ID remapping keyed on `filePath:name`, relationship pruning for deleted files, re-rendering files that *lost* a reference). Domains are **not** re-classified on incremental updates — they drift staler until the next full generate.

### 3.5 The `.graph` shard format (verbatim, from `internal/shards/render.go`)

`src/login.go` → `src/login.graph.go`:

```go
//go:build ignore        // Go shards only — so they don't break compilation
package ignore
// @generated supermodel-shard — do not edit
// [deps]
// imports     internal/auth/handler.go
// imported-by main.go
// [calls]
// init → LoginWithToken    internal/auth/handler.go:109
// init ← main              cmd/root.go:42
// [impact]
// risk        MEDIUM
// domains     CoreConfig · SupermodelAPI
// direct      1
// transitive  1
// affects     main.go
```

Comment prefix is language-aware (`#` for Python/Ruby). Written atomically (temp + rename), path-traversal-guarded. **Risk is a crude 3-bucket heuristic, not a model:** `HIGH` if transitive>20 or domains>2; `MEDIUM` if transitive>5 or domains>1; else `LOW`. The format was once three files (`.calls`/`.deps`/`.impact`) and was consolidated to one `.graph.*` per source file — `render.go` still ships `removeStaleSplitShards` to clean the legacy files.

### 3.6 Graph data model (SIR)

The **Supermodel Intermediate Representation** = one bundle with shared node IDs across all layers. Nodes: `{id, labels[], properties{}}`. Labels seen: `File, Function, Class, Type, Domain, Subdomain, Directory, LocalDependency, ExternalDependency`. Relationships: `{type, startNode, endNode}` — `imports`, `calls`, `defines_function`, `belongsTo`, `EXTENDS`, `CONTAINS_FILE`… (casing is inconsistent; the client tolerates both `calls` and `IMPORTS`). Domains are C4-model-shaped (Domain → Subdomain → Code) with LLM-named clusters and semantically-labeled inter-domain edges.

### 3.7 Benchmarks — what holds up

Honest benchmarking culture (they publish results that hurt them). Real signal: dead-code detection 94% F1 vs 52% grep-baseline; ~40–62% read-token reduction on a Django task (≈n=1). The headline "156× cheaper" is real but dominated by the baseline agent melting down on huge repos — task-selection-sensitive. Their own MCP server scored **−15%** on 500 SWE-bench tasks; they published it.

## 4. Marketing vs. reality

| Claim | Reality (read from source) |
|---|---|
| "Supermodel maps every file… in your repo" | The CLI maps nothing — 100% server-side; `go.mod` carries no parser. |
| "Do you store my code? **No.**" | Code *is* uploaded to Azure Blob + extracted to worker disk — deleted "in seconds," **worst case 60 minutes**. "Don't store" means "delete fast." |
| "offline-first / incremental" | A cold repo *requires* the API; every incremental change *calls* it. Online-with-a-local-cache. |
| MCP server "brings the **full** code graph API into editors" | The production MCP server exposes exactly **one** tool (`symbol_context`). |
| OSS-funnel positioning | The **SDK is `UNLICENSED`** — not open source. CLI/MCP/Action are MIT; the SDK is not. |

These matter for the port: §4 row 1 is *why* the engine port is valuable (the value is server-side); §4 row 2 is the privacy story Interlinked can tell *better* by running the engine locally.

## 5. Port scope — what we take, what we leave

**TAKE — the data-plane graph engine (TypeScript):** tree-sitter parse pipeline, call-graph resolution, dependency-graph local/external split, dead-code ranker, impact reverse-BFS, Tarjan cycle detection, the SIR builder.

**LEAVE — the Java/Spring control plane:** job queue, API ingress, Stripe billing, the idempotency table. It exists *because* Supermodel is a SaaS. Interlinked is local-first and in-process — there is no cloud service to host. Delete it entirely.

**LEAVE — the cloud-upload model.** Antithetical to Interlinked (local-first, no exfiltration — the taint-tracker that fired during this very research is the principle in action). The whole point of the port is to *remove* the upload.

**LEAVE (or cloud-route) — LLM domain *naming*.** The determinism filter (`feedback_harness_deterministic_only.md`, INTAKE §"determinism") bars LLM-in-the-loop from the CLI. Keep the algorithmic clustering; drop the naming, or route it to a cloud surface (P2–5).

**Language reality — the "instant port" caveat.** Supermodel's CLI is **Go**, its control plane is **Java**, its data plane is **TypeScript**. Interlinked is **TypeScript**. Only the TS data plane is near-copyable. The Go CLI's shard renderer/daemon and anything in Java would be *transcription*, not copy-paste. The good news: **the part we want (the data-plane engine) is the part already in our language.** The port is "lift the TS engine, strip its cloud I/O" — not "rewrite a Go/Java service."

## 6. The integration seam — component → module map

The port is a **swap/merge into the existing harness graph layer**, not greenfield. Interlinked already has the substrate; Supermodel would supply a (possibly) better engine behind it.

| Supermodel component | Interlinked target | Port action |
|---|---|---|
| Parse graph (AST → symbols) | `src/harness/project-graph.ts` | Augment/replace the AST layer |
| Call graph (resolved call edges) | `src/harness/project-graph.ts` | Replace our call-edge resolution if recall is better (spike §9b) |
| Dependency graph (local/external split) | `project-graph.ts` + `structural-checks.ts` | The local/external split is a near-free code-derived SBOM win — see `reference_supermodel_api_surface.md` |
| Dead-code ranker | `src/harness/checks/` (new graph-driven check) + `recurrence` | New `dead_code` detector; framework-entry-point heuristics |
| Impact / blast-radius (reverse-BFS) | `src/harness/impact-analysis.ts` | Surface in the PreToolUse path ("editing a hub — confirm?") |
| Circular deps (Tarjan SCC) | `structural-checks.ts` (`circular_imports`) | Upgrade file-level check → full Tarjan |
| Domain graph — clustering | new module | Algorithmic only |
| Domain graph — naming | cloud surface (P2–5) | LLM leaf; determinism filter |
| SIR (shared-ID bundle) | `.interlinked/graph.json` | The unified artifact already proposed in `reference_supermodel_api_surface.md` §"Low-cost ratchet additions" |
| `.graph.*` sidecar emission | Interlinked graph-prediction work | Supermodel's `render.go` is a reference for the format |

## 7. The scaffold (the placeholder)

### 7(a) The highest-value groundwork — available NOW, no source, no license needed

Define a **`GraphEngine` interface** and make the *existing* `project-graph.ts` implement it. Then porting Supermodel becomes "add a second `GraphEngine` implementation behind the same interface." This is **harness-clean** — the existing code implements the interface, so nothing is dead — and it converts the port from "integrate a foreign codebase" into "implement an interface."

Proposed interface (design-level — not yet committed code):

```ts
// proposed — src/harness/graph/engine.ts
export interface GraphEngine {
  build(repoDir: string, opts: GraphBuildOpts): Promise<CodeGraph>;
  incremental(prev: CodeGraph, changed: string[]): Promise<CodeGraph>;
  readonly capabilities: {
    callGraph: boolean; domains: boolean; deadCode: boolean; impact: boolean;
  };
}
// project-graph.ts            → class LocalGraphEngine     implements GraphEngine
// ⏳ ENGINE SLOT (the placeholder):
//   src/harness/graph/supermodel-engine.ts
//                             → class SupermodelGraphEngine implements GraphEngine
```

Proposed directory layout once the port happens:

```
src/harness/graph/
  engine.ts             interface + CodeGraph type        ← buildable NOW
  local-engine.ts       wraps existing project-graph.ts   ← buildable NOW
  supermodel-engine.ts  ⏳ ENGINE SLOT — empty until open-source
  supermodel/           ⏳ ported TS data-plane engine (NOTICE-attributed)
```

### 7(b) Why there are no stub `.ts` files in this PR

A placeholder is documentation here, **not** empty code. Speculative stub modules in `src/` would be dead code that interlinked-cli's *own* harness flags (`dead_exports`, `default_export`, `lifecycle_cleanup`, the line-cap baseline). Creating dead stubs to scaffold a dead-code-detection tool would be self-defeating. The placeholder is this spec: the `⏳ ENGINE SLOT` markers above are where real files land once the source + license are in hand. Only `engine.ts` + `local-engine.ts` from 7(a) are real-and-buildable today, and only because the *existing* code gives them a body.

## 8. Day-it-drops runbook (the gated port sequence)

Ordered. Each step gates the next. **Step 1 is the §2 gate — do not skip it.**

1. **License check.** Read the *engine's* LICENSE. Apply the §2.2 matrix. Source-available or unacceptable copyleft → **STOP**; stay on integration (§9). Permissive → continue.
2. **Diff against §3.** Confirm the architecture matches this reference spec; record drift.
3. **Locate the data-plane graph builder** (TypeScript). Confirm it is separable from the Java control plane and from cloud I/O (Cosmos DB, Blob, the job table).
4. **Determinism audit.** Grep the engine for LLM calls — per INTAKE, marketing hides LLM calls at the leaves. Isolate the domain-naming leaf; everything else must be deterministic.
5. **Dependency audit.** Enumerate the engine's npm deps (tree-sitter + grammars, others). Weigh against the one-runtime-dep stance. Too heavy for the CLI → route to a cloud surface, or keep subprocess-invoke (§9b). Audit transitive licenses (a permissive engine with a copyleft dep still bites).
6. **Implement `SupermodelGraphEngine implements GraphEngine`** — fill the §7 slot.
7. **Strip cloud I/O** — remove upload/poll/blob; the engine runs in-process on local files.
8. **Strip or cloud-route the LLM domain-naming** (§5).
9. **Attribution** — `NOTICE` file; preserve copyright headers in every ported file.
10. **Benchmark** `SupermodelGraphEngine` vs `LocalGraphEngine` on this repo — recall, speed, dep weight. Ratchet-gate the swap; do not replace `project-graph.ts` unless it measurably wins.
11. **Update** the four `reference_supermodel_*` memories, this doc, and the external-pulse verdict.

## 9. What we can do now (before open-source)

- **(a) Build the `GraphEngine` interface + `LocalGraphEngine`** (§7a). Real, harness-clean, de-risks the port to "implement an interface." Highest-value now-item. *Not done in this PR — proposed; awaiting go-ahead.*
- **(b) Subprocess spike.** The MIT `supermodel` Go binary is public **today**. `supermodel analyze --no-shards -o json` → diff its call graph against `project-graph.ts`. Answers "is their engine actually worth porting?" with zero license/dep risk. INTAKE §7 smallest spike. **This is the gate on whether §8 is ever worth running.**
- **(c) Borrow from the already-MIT repos now** (with attribution): the `.graph` shard *format*, the daemon's UDP-trigger/debounce/incremental-merge pattern, `install.sh`'s sha256 checksum-verification (directly relevant to the supply-chain allowlist work), the dead-code-hunter Action's PR-comment shape.
- **(d) Watch the runway.** A ~3-person unfunded team open-sourcing its one moat is a signal worth tracking — see `reference_supermodel_company_gtm.md` (partner-dependency risk).

## 10. Open questions ⏳

- **Which license?** The everything-question (§2).
- Is the data-plane engine cleanly separable, or wired into Cosmos DB / Blob / the job table?
- tree-sitter + grammar dep weight — fits the CLI's one-dep budget, or forces a cloud surface / subprocess?
- Does Supermodel's call-graph recall actually beat `project-graph.ts`? — spike §9(b) answers this and gates everything else.
- Does "port" mean *replace* `project-graph.ts`, or run *alongside* it as an opt-in engine? (Lean: alongside, behind `GraphEngine`, ratchet-gated.)
- Could the Java control plane's "Postgres-as-the-only-infra / polling-IS-submission" pattern inform the paid cloud tier (`docs/design/three-tier-architecture-v2.md`) independent of any code port? (Pattern is free to reuse regardless of license.)
