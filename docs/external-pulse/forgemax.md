# Forgemax

- **Source:** https://github.com/postrv/forgemax (cloned to `reference-repos/forgemax`, FSL-1.1-ALv2, v0.6.0 at `2d7f6f7`, 10 Rust crates, ~14K LoC, ~790 tests). Author: Laurence Avent ([[reference-arbitersec-competitor]]).
- **Encountered:** 2026-05-26, follow-up to `arbitersec.md` — the one genuinely transferable design in Avent's portfolio.
- **Verdict:** memory note + Lane 4 pattern (Code Mode tool-collapse, AST-gated V8 sandbox). Lane 5 latent for Agent CI / future Interlinked-MCP-Server surface. **License blocks code-borrow** (lane 3) until the per-release ALv2 conversion (~2028 for v0.6.0). Parked for the first few phases — Interlinked is not an MCP gateway.

## 1. Core idea (one sentence, your words)

An MCP gateway that collapses N downstream servers × M tools into exactly **two MCP tools** (`search` + `execute`), both taking a JavaScript async arrow function as their sole argument; the agent writes JS, the gateway runs it in an oxc-AST-validated, deno_core V8 isolate with opaque proxy bindings, and the per-turn schema cost stays a constant ~1,100 tokens regardless of how many tools are connected.

## 2. Anatomy (concrete walkthrough)

10-crate Cargo workspace, FSL-1.1-ALv2, panic=abort + LTO:

```
crates/
  forge-cli/             clap entrypoint — `forgemax / serve / doctor / manifest / run / init`
  forge-server/          MCP server: search + execute via rmcp 1.2; lib.rs (~880 LoC)
  forge-sandbox/         V8 sandbox — 14 src files:
    ast_validator.rs       1727 LoC — oxc-based static validator + AliasChecker (load-bearing #1)
    executor.rs/host.rs    JsRuntime per execution, opaque ToolDispatcher trait
    pool.rs                Worker pool (warm + reaped + health-checked)
    ipc.rs / ops.rs        Length-delimited JSON over stdin/stdout, parent↔worker messages
    redact.rs              URL/IP/path/Bearer/sk-/pk-/api_/key_ + stack-trace stripping
    groups.rs              GroupEnforcingDispatcher + SharedGroupLock per-execution
    stash.rs               Session KV with TTL, group isolation, size cap
    audit.rs / metrics.rs  Prometheus + audit envelope
  forge-sandbox-worker/  Child binary spawned with env_clear() + kill_on_drop
  forge-manifest/        LiveManifest (arc-swap), 4-layer progressive discovery
    forge.d.ts             136 LoC TS exposed to the LLM via MCP instructions field
    live.rs                SIGHUP-triggered refresh, background re-discovery
  forge-client/          Downstream MCP clients (stdio + HTTP/SSE), RouterDispatcher
    circuit_breaker.rs     Closed/Open/HalfOpen state machine per server
    timeout.rs             Per-server timeout wrapping
    reconnect.rs           ReconnectingClient with exponential backoff
    router.rs              Levenshtein typo suggestions via `strsim`
  forge-config/          TOML + ${ENV_VAR} expansion + notify-based watcher
  forge-error/           Typed DispatchError enum (replaces anyhow)
  forge-audit/           Structured audit events, code-hash redaction
  forge-test-server/     Mock MCP server for integration tests
forge.toml.example       11 pre-configured downstream servers
```

**Five load-bearing files, in my words (read in source):**

1. **`forge-sandbox/src/ast_validator.rs` (1727 LoC) — the security crown jewel.** Parses LLM-generated JS into an oxc AST and walks it before V8 ever sees it. The `AstWalker` rejects: bare-identifier calls `eval()` / `Function()` / `AsyncFunction()` / `GeneratorFunction()` / `Proxy()` / `require()`; `new Function()` and the rest of the constructor family; `Reflect.construct`, `String.fromCharCode`, `String.raw` (tagged template); static-member `Deno.*`, `process.{env,exit,argv,stdin,stdout,stderr,kill,binding}`, `Symbol.{toPrimitive,hasInstance}`, `__proto__`, `constructor.constructor`; computed `obj["constructor"]` / `obj["__proto__"]` / `obj["eval"]` / `obj[Symbol.toPrimitive]`; `globalThis[...]` (any computed access); `import.meta`; dynamic `import()`; `with` statement; `WebAssembly`; nesting > 256. Then the `AliasChecker` runs a separate pass tracking dangerous aliases through up to 10 fixed-point iterations — catches `const e = eval; e('x')`, multi-hop `const a = eval; const b = a; b('x')`, destructured `const { eval: e } = globalThis; e('x')`, and member-call `const D = Deno; D.readFile(...)`. 28+ named bypass tests (`ast_01_*` through `ast12_12_*`) plus a roughly equal number of negative-case tests (template literals containing the word "eval", `obj.constructor.name`, function parameter named `eval`, etc.).
2. **`forge-server/src/lib.rs` (~880 LoC) — the two-tool MCP surface.** `ForgeServer::search` and `ForgeServer::execute` are the only public MCP tools. Both take a `code: String` parameter (a JS async arrow function). `get_info()` returns an MCP `ServerInfo` whose `instructions` field embeds the full `forge.d.ts` plus a server/tool count, manifest shape hints, and a sandbox-constraints reminder. Results over 100 KB get wrapped in a `{_truncated: true, _data_is_fragment: true, _original_chars, _shown_chars, data}` envelope cut at a newline or comma boundary (UTF-8 safe). Errors return `Ok` with a JSON error field (not `Err`) so sibling tool calls don't cascade-fail.
3. **`forge-manifest/src/lib.rs` + `live.rs` + `forge.d.ts`** — the progressive-discovery manifest. Layer 0 = server names (~50 tokens), Layer 1 = categories, Layer 2 = tool lists, Layer 3 = full schemas. `LiveManifest` is an `ArcSwap<Manifest>` — lock-free reads, atomic writes on background re-discovery or SIGHUP. The 136-line `forge.d.ts` is compiled into the binary as a `const &str` (`forge_manifest::FORGE_DTS`) and surfaced via the MCP `instructions` field — the LLM sees `interface Forge`, `interface ForgeStash`, `interface Manifest`, etc. as inline TS.
4. **`forge-sandbox/src/pool.rs` + `ipc.rs` + `forge-sandbox-worker/src/main.rs`** — the dual-mode executor. `execution_mode = "in_process"` (tests) keeps V8 in-process on a dedicated tokio runtime. `"child_process"` (production) spawns `forgemax-worker` with `.env_clear()` + `kill_on_drop(true)` + no inherited file descriptors. The IPC is a 4-byte big-endian length prefix + JSON payload (`ParentMessage` / `ChildMessage` enums: `Execute`, `ToolCallRequest/Result`, `ResourceReadRequest/Result`, `StashRequest/Result`, `Log`, `ExecutionComplete`, `Reset`). The worker pool maintains 2–8 warm processes, recycles after 50 uses, reaps idle after 60 s, 500 ms health check.
5. **`forge-client/src/{circuit_breaker,timeout,reconnect,router}.rs`** — the resilience stack `CircuitBreaker(Timeout(McpClient))` plus `ReconnectingClient` (broken-pipe / channel-overflow detection with CAS-guarded concurrent-reconnect prevention) plus `RouterDispatcher` with `strsim`-based Levenshtein typo suggestions returning `TOOL_NOT_FOUND` with `{suggested_fix: "Did you mean 'find_symbols'?"}` before ever hitting the upstream.

**End-to-end session (the README's running example, ~5 lines):**

```
LLM emits: execute({code: "async () => {
  const symbols = await forge.callTool('narsil', 'symbols.find', {pattern: 'handle_*'});
  const refs = await forge.callTool('narsil', 'symbols.references', {symbol: symbols[0].name});
  return { symbols, refs };
}"})
forge-server → AST validator → V8 isolate (or IPC to worker) → forge.callTool binding →
  RouterDispatcher → narsil-mcp stdio client → upstream call → response → V8 promise resolves →
  next callTool → resolve → JSON.stringify result → format_sandbox_result → MCP response.
```

Single MCP round trip; the LLM never sees narsil's 90 tool schemas; the host process never lets the LLM near a credential or a file descriptor.

## 3. Deterministic or agentic?

**Substrate fully deterministic; consumer is the agentic part — by design.** The substrate (AST validator, V8 boot/teardown, IPC framing, worker pool, manifest layer, group enforcement, error redaction, circuit breakers) is deterministic Rust. The *content* the substrate runs — the LLM-written JS — is opaque to Forgemax, just as our harness treats `Bash` command text as opaque (`feedback_harness_deterministic_only.md`). The agentic part is upstream of the gateway, not inside it.

**License: FSL-1.1-ALv2** — Functional Source License with a 2-year Apache-2.0 future grant. Free for any use **except a competing commercial product/service**. **Blocks lane 3 (code-borrow)** today; v0.6.0 converts to ALv2 in ~2028. Lane 4 (pattern reuse) and lane 5 (invoke-as-subprocess from a separately-licensed product) are both fine — the FSL only restricts derivative *products*, not patterns or runtime composition.

**Marketing-vs-reality check.** README claims 96% token savings at 76 tools and 99% at 267 — the constant comes from a real benchmark at `crates/forge-manifest/examples/token_savings.rs`. README cites `deno_core 0.391`; workspace `Cargo.toml` pins `0.400`. Minor stale doc, easy to verify directly. The ~790-test claim is consistent with the spread of test modules across crates. Cloudflare Code Mode is explicitly credited as inspiration (README §Why, third paragraph) — not pretended-as-novel.

## 4. Substrate vs. surface

- **Surface:** an opinionated MCP gateway with stdio transport, `forge.toml` config, and `forgemax run <file.js>` for testing. Pre-configured for 11 reputable downstream servers (narsil, GitHub, Playwright, Sentry, Cloudflare, Supabase, Notion, Figma, Stripe, Linear, Atlassian). Not for us — we're not building a gateway.
- **Substrate, cleanly separable (FSL still blocks code-borrow; patterns are free):**
  - (a) **The Code Mode pattern itself** — collapse N tool schemas to 2 (`search` + `execute`) keyed on LLM-written JS. The most differentiated idea in the portfolio.
  - (b) **The oxc AST gate** — `AstWalker` (banned-pattern set) + `AliasChecker` (multi-hop alias fixed-point). A complete worked example of "what to ban in an LLM-fed sandbox" with 28 bypass tests and an equal number of legitimate-pattern negatives.
  - (c) **The 4-layer progressive manifest** — `arc-swap` over a layered structure so the agent pays the schema cost only for the tools it actually drills into.
  - (d) **The resilience stack composition** — `CircuitBreaker(Timeout(McpClient))` + `ReconnectingClient` + per-server typeo correction at the dispatcher.
  - (e) **Cross-server group isolation with a per-execution shared lock** — `[groups]` config + `GroupEnforcingDispatcher` + `SharedGroupLock`. Solves data-flow control inside a single LLM execution.

## 5. Lane (1–6)

**Primary: Lane 4 (pattern / architecture). Secondary: Lane 5 (cloud-only fodder, latent).**

- **Lane 1** — no.
- **Lane 2** — the AST-validator banned-pattern set is technically a detection technique, but it applies to LLM-generated JS, not to source code we lint. Not relevant to our harness checks.
- **Lane 3 (substrate borrow into the CLI)** — **ruled out by license + binding-constraint mismatch.** FSL-1.1-ALv2 blocks code-borrow; the substrate is also Rust + deno_core (huge native dep), and our CLI is TS with a one-dep stance.
- **Lane 4 (pattern)** — **primary.** Two patterns worth carrying forward: (i) the Code Mode collapse, if Interlinked ever ships its own many-tool MCP server surface and hits the 100k-tokens-of-schema problem (relevant only as we scale the *server's* surface area, which is a Phase 4+ question); (ii) the AST-validator structure as the canonical reference for "validating LLM-fed sandbox JS" — useful if Tier 2 / Tier 3 ever evaluates LLM-written policy or remediation code in-process.
- **Lane 5 (cloud)** — **latent.** Forgemax-as-substrate makes sense only inside a multi-server gateway product. We don't have one today; if Agent CI / Tier 3 ever fans out across multiple downstream tool servers and needs to mediate them for the LLM reviewer, the Code Mode pattern would be a candidate. Not a decision to make now.
- **Lane 6** — direct CLI adoption (we're not a gateway), embedding deno_core or oxc into the TS harness (impossible — wrong language, wrong binding-constraint).

## 6. Dependency & displacement

- **Deps:** N/A for direct adoption — wrong language, license-blocked. As a subprocess (`forgemax run <file>`) it would add an external binary requirement, which our CLI's "self-contained hook script" stance disallows. Pattern-only reuse adds zero deps.
- **Displacement:** **none, today.** Forgemax mediates an LLM ↔ many MCP-tool-servers boundary; our harness mediates an agent ↔ tool-call (Bash, Write, Edit, MCP) boundary at the *hook* layer, not the MCP-protocol layer. Different cut. The closest internal analogue is `src/harness/grep-accelerator.ts` (which intercepts a tool call, narrows scope via index, and returns block-and-answer) — same *shape* (mediate + collapse), different *substrate* (trigram index, not V8). Worth noting as a kindred pattern; not displacement.

## 7. Smallest spike

**≤1 day, optional and parked.** Two candidates if Forgemax ever becomes relevant:

1. **AST-validator pattern transfer to a TS dialect** — if Tier 2/3 ever runs LLM-generated remediation or policy code locally, fork the `AstViolation` enum + walker shape into `src/harness/llm-code-validator.ts` using TypeScript's compiler API (`ts.createSourceFile` + AST walk) as the parser. Half-day to port the banned-pattern set; another half-day to port the alias checker. Skip unless a real consumer surface lands.
2. **Code-Mode collapse for Interlinked-MCP-Server** — if our own MCP server ever exposes more than ~30 tools, prototype a two-tool `search`/`execute` wrapper that the agent talks to instead. This is a Phase 4+ design question, not a near-term spike.

Both spikes presuppose a consuming surface we don't have. The honest answer is: read this file, link it from the Tier 3 design memo if Tier 3 ever names "LLM writes code, harness runs it" as a sub-pattern, and otherwise move on.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | **Nothing.** Wrong language, wrong category (we mediate hooks, not MCP tool schemas), license-blocked for code-borrow. Pattern absorption only. | — | parked |
| Guardrails (P2–3) | **Weak / parked.** The V8-sandbox-with-AST-gate is the right shape *if* Guardrails ever evaluates LLM-emitted policy/remediation code in-process — but Tier 2 is currently designed as a typed-label classifier feeding Cedar (`project_llm_policy_enforcement.md`), not as a code-execution gate. | — | parked |
| Agent CI (P4–5) | **Real but latent.** Tier 3 deep review may eventually want (a) to host a multi-tool LLM-reviewer surface, (b) to evaluate LLM-written suggested fixes in-process; either case would benefit from the Code-Mode + AST-gate pattern. Pair with `activegraph.md` (the substrate question for Tier 3) — Forgemax addresses tool-surface collapse; ActiveGraph addresses run substrate. Different layer; both could land. | One-day AST-validator port if needed (§7) | parked |

Phases 6–7 inherit from the Tier 3 choice — no separate row.

## 9. Artifact

- **Memory note** in `reference_arbitersec_competitor.md` already names Forgemax as the transferable design.
- **This file** is the durable reference.
- **No PR, no harness check, no roadmap-item-today.** A `parked` verdict on every surface is the correct call: Forgemax is genuinely well-engineered, but it solves a problem we don't have until Interlinked's *server-side* tool surface grows or Tier 3 starts running LLM-written code in-process.

## Notes

- **The Cloudflare Code Mode lineage is acknowledged in the README** (`postrv` explicitly credits `blog.cloudflare.com/code-mode/`). Cross-link to `project_cloudflare_ai_blogs_adoption.md` — Code Mode is one of the 11 patterns indexed there; Forgemax is a third-party MCP-specific implementation of it.
- **`forge-server`'s output truncation envelope** (`_truncated`/`_data_is_fragment` at 100 KB cut on newline/comma with UTF-8 safety) is a clean pattern for the same problem Interlinked's `streamCqSection` solves in `verify` — namely "the agent's tool output budget is finite, cut at a meaningful boundary." Not borrowable as code; worth referencing if we ever revisit the verify-output truncation shape.
- **`CircuitBreaker(Timeout(McpClient))` composition** is the same wrapping pattern our reservation/server-bridge resilience uses. Convergent evidence on the dispatcher-stack shape, same as the ActiveGraph reservation-model convergence in `activegraph.md`.
- **`forge-client/src/router.rs`'s Levenshtein typo suggestions** match the same `strsim`-based fuzzy matching we ship for our package allowlist (`findTyposquatMatch`). Different domain (tool names vs. package names), identical primitive.
- **What I deliberately did not borrow into the lane verdict:** the per-tool `tracing::instrument` annotations, the Prometheus metrics shape, the SSE transport, the `notify` config-file watcher, the `forge.toml` example with its 11 pre-wired downstream servers, the Homebrew/Scoop/npm distribution wrappers, the worker-pool warm-pre-spawn strategy. Each of those is solid engineering in Forgemax and not load-bearing for any Interlinked decision.
- **Related external-pulse entries:** `arbitersec.md` (the company-level intake that pointed here), `narsil-mcp.md` (the downstream MCP server Forgemax is built to front), `activegraph.md` (the other "deterministic substrate for an LLM-mediated surface" intake — same Tier 3 lane, different layer), `codewiki.md` (the read-the-source precedent — handy because Forgemax's README does have one minor stale claim).

## Methodology notes

- **Read order:** README (claims), workspace `Cargo.toml` (license + members), `ARCHITECTURE.md` (cross-server isolation + redaction design), `crates/forge-sandbox/src/ast_validator.rs` (the actual gate — 1727 LoC, worth the slow read), `crates/forge-manifest/src/forge.d.ts` (the LLM-facing TS surface — small and clarifying), `crates/forge-server/src/lib.rs` (the two-tool MCP entry). Skipped `forge-client/*` source after confirming the resilience stack composition matches what `ARCHITECTURE.md` claimed.
- **Determinism check confirmed in source, not just the README.** The substrate has no `chatCompletion`-style LLM dependency — `grep -r anthropic /tmp/forgemax/crates/` returns nothing relevant. The LLM-as-consumer is the only LLM in the system, which is the right architectural shape.
- **License read carefully.** FSL-1.1-ALv2 is non-OSI; it permits modification and redistribution but blocks selling a competing product whose value derives substantially from this code. For our purposes that means: pattern reuse is unconditionally fine, subprocess invocation is fine, code-borrow into our (open-source) CLI is technically allowed as long as we're not "Selling the Software" — but adopting an FSL dep into a codebase that aspires to be redistributable is a future-restriction trap. Better to stay pattern-only until v0.6.0 converts to ALv2.
- **Suggested INTAKE.md edit if this pattern recurs:** for a find that is well-engineered but solves a problem the project doesn't have yet, the verdict "parked on every surface" is correct and useful — the file's value is preventing re-evaluation in three months. Maybe surface this explicitly as a valid verdict shape alongside "skip" in INTAKE.md §"Output discipline".
