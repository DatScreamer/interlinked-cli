# deepsec

- **Source:** https://github.com/vercel-labs/deepsec • https://vercel.com/blog/introducing-deepsec-find-and-fix-vulnerabilities-in-your-code-base
- **Encountered:** 2026-05-04, user pasted GitHub URL with INTAKE.md pointer
- **Verdict:** PR (lane-2 matcher ports) + memory note (lane-4 noise-tier + scan-then-judge contrast) + cloud-roadmap entry (lane-5 judge architecture)
- **Source clone:** `reference-repos/deepsec/` (Apache 2.0)

## 1. Core idea (one sentence, your words)

Two-stage vulnerability scanner: a fast deterministic regex pre-filter (`scan`, ~115 matchers across CWE shapes + frameworks + languages) casts a wide candidate net, then a coding-agent SDK (Claude Agent SDK or Codex SDK) investigates each candidate file in batches and emits structured `Finding`s, optionally followed by a second AI pass (`revalidate`) that labels each finding `true-positive | false-positive | fixed | uncertain`.

## 2. Anatomy

```
packages/
  scanner/    Regex matchers (~115) + glob+match engine, no AI
  processor/  Claude/Codex SDK plugins, batching, INFO.md injection, append-only history
  core/       FileRecord schema, plugin contracts, registry singleton
  deepsec/    CLI bundle + Vercel Sandbox executor + samples
```

Load-bearing files I read:

- `packages/scanner/src/matchers/utils.ts` (40 lines) — the `regexMatcher(slug, [{regex,label}], content)` helper. Splits content into lines, runs each regex per-line, captures 1-based hit numbers + 5-line context snippet. Every "simple" matcher is a thin wrapper around this.
- `packages/scanner/src/matchers/sql-injection.ts` (37 lines) — typical declarative matcher shape: 16 regex/label pairs in an array, no logic.
- `packages/scanner/src/matchers/dockerfile-run-as-root.ts` (63 lines) — non-trivial matcher: tracks the *last* `FROM` to find the final stage of a multi-stage build, walks the final stage to find the last `USER`, special-cases `FROM scratch`. Shows that matchers can carry real parser-style logic when needed.
- `packages/scanner/src/matchers/agentic-untrusted-prompt-input.ts` (68 lines) — two-phase regex: file must look like an LLM call site (`streamText`/`generateText`/`messages: [`/Anthropic-SDK/etc.), then a 30-line window scan around `system:`/`prompt:`/`messages:` keys for `${var}` interpolation where `var` matches an "untrusted-origin" name (`notes`, `transcript`, `scraped`, `salesforce*`, `kb_*`, `crawlResult`, …). Detects the *sink* side of indirect prompt injection.
- `packages/scanner/src/index.ts` (300 lines) — `RegexScannerDriver`: globs files (deduped per filePattern set), reads each file once into an in-memory cache, runs every matcher against the cached content, upserts `FileRecord.candidates` with dedup-by-(slug, pattern, lineNumbers).
- `packages/processor/src/index.ts` (~880 lines) — `process()` and `revalidate()`. `DEFAULT_PROMPT_TEMPLATE` (~110 lines, lines 37–147) is a hand-tuned prompt: severity definitions, ~35-row vulnerability category table, a "False Positive Guidance" block, a `JSON.stringify in dangerouslySetInnerHTML` deep-dive, and an "Auth Bypass Patterns" taxonomy. Worth reading as a structured statement of the security-review job.

End-to-end session (from the README):

```
npx deepsec init                           # creates .deepsec/, picks projectId
# agent reads SETUP.md → writes .deepsec/data/<id>/INFO.md
pnpm deepsec scan                          # ~15s for 2k files; populates candidates[]
pnpm deepsec process                       # $$$ — agent investigates each candidate
pnpm deepsec revalidate --min-severity HIGH # cuts FP rate ~50%
pnpm deepsec export --format md-dir --out ./findings
```

## 3. Deterministic or agentic?

**Hybrid by design — and the README is honest about it.** Unlike CodeWiki, no marketing-vs-reality gap: the homepage says "agent-powered" and the cost reality ("scans can cost thousands or even tens-of-thousands of dollars") is in paragraph two of the README.

- **Deterministic substrate** — `packages/scanner/` (regex matchers + glob engine + dedup) and `packages/core/` (FileRecord schema + idempotent merge). ~115 matchers, every one a regex. No AST, no LSP.
- **Agentic core** — `packages/processor/` `process` and `revalidate` are LLM calls per batch via Claude Agent SDK (default) or Codex SDK, routed through Vercel AI Gateway. The actual "is this a vulnerability?" decision is made by the model.

**License: Apache 2.0** with a `NOTICE` file. Individual matchers are copy-pasteable into our codebase under Apache attribution. No license blocker for lane 2 or lane 3 borrowing.

## 4. Substrate vs. surface

- **Surface:** AI vulnerability scanner you point at a repo and burn money on.
- **Substrates worth considering:**
  - **The matcher corpus** — 115 regex patterns covering CWE shapes plus framework/language gaps our `generic-checks.ts` doesn't reach (Dockerfile, Terraform, Go, Lua, Drizzle, Hono, GitHub Actions, MCP/agent-specific shapes).
  - **`regexMatcher` helper shape** — declarative `{regex, label}[]` wrapper around line-scan + context capture. Our `generic-checks.ts` reimplements this loop in many places.
  - **`noiseTier: precise | normal | noisy`** taxonomy — explicit precision-intent declaration per detector, used to order processing (precise first = best signal/token).
  - **Append-only `FileRecord` + idempotent stage merge** — clean schema where re-running any stage merges additively into per-file history.

## 5. Lane

**Lane 2 primary (matcher ports), lane 4 secondary (architectural lessons), lane 5 tertiary (cloud judge architecture).**

### Lane 2 — matcher ports for `generic-checks.ts`

Gaps relative to our current ~50 generic checks. Verified absent via grep over `src/harness/`:

| deepsec matcher | Why it ports cleanly | FP-rate posture |
|---|---|---|
| `secret-in-fallback` | `process.env.X \|\| "hardcoded"` for SECRET/TOKEN/KEY/PASSWORD/AUTH names. Tight regex, ~zero FP. | precise → default gate |
| `secret-in-log` | `console.log(secret)` / log statements with credential vars | precise → default gate |
| `dockerfile-run-as-root` | We have *no* Dockerfile coverage. Multi-stage-aware. | normal → default gate |
| `dockerfile-curl-pipe-unverified` | `RUN curl ... \| sh` shapes | precise → default gate |
| `dockerfile-from-mutable-tag` | `FROM image` or `FROM image:latest` (supply-chain) | precise → default gate |
| `cors-wildcard` | `Access-Control-Allow-Origin: *` literal in code | precise → default gate |
| `error-message-leak` | `res.send(err.stack)` / err.message exposure | normal → advisory |
| `agentic-untrusted-prompt-input` | **Sink-side prompt injection.** Our existing `signatures.ts` covers the *inbound* side (WebFetch/Read prompt-injection text). This matcher covers the *outbound* side: agent code that constructs prompts from untrusted-name variables. Especially relevant to interlinked itself — we ship into agent infra. | normal → advisory |
| `prompt-leaks-system-prompt` | Returning the agent's own system prompt back to the user | precise → default gate |
| `cross-tenant-id` | User-supplied teamId/userId in DB lookups without ownership check | normal → advisory |

Skip for now: Lua matchers (rare in our ecosystem), Terraform matchers (worth a separate batch if/when we do IaC), AWS-specific IAM matchers.

### Lane 4 — architectural lessons

1. **The two-stage scan-then-judge composition is the inverse of our constraint.** deepsec deliberately tolerates a high FP rate in `scan` because the AI judge in `process` filters it. Our harness can't compose that way (per `feedback_harness_deterministic_only.md`), so every check must be FP-disciplined at the agent surface. **Implication:** matcher ports above need to be tightened relative to deepsec's tolerance — what's `normal` for them may be too loose for us. Use the verify two-tier (default vs `--all-checks`) as the FP-budget pressure valve.
2. **`noiseTier` is a precision axis we don't have.** Our checks declare `determinism: fully_deterministic | heuristic`, which is about the *model* of detection, not its precision. deepsec's `precise|normal|noisy` is about *expected hit count per 1k files*. Worth considering: add a `noiseTier` (or `precision`) field to `CHECK_REGISTRY` entries so the verify formatter can sort/filter without a separate `DEFAULT_ADVISORY_SKIPS` allowlist. The current allowlist is a string-set workaround for what's really a per-check property.
3. **`regexMatcher` helper would shrink `generic-checks.ts` substantially.** Many of our existing checks hand-roll the line-split + per-line regex.test + 1-based-line + context-snippet loop. A shared `regexBundle({slug, patterns, fileFilter})` helper modeled on deepsec's would be a clean refactor target after the ports above.
4. **The DEFAULT_PROMPT_TEMPLATE is a corpus-quality artifact.** Lines 37–147 of `processor/src/index.ts` are a structured taxonomy of "what counts as a security finding" with explicit FP-mitigation guidance. Worth keeping as a reference for how Vercel framed the security review job — particularly the auth-bypass patterns block, several of which (`searchParams as auth input`, `Next.js middleware-only auth is insufficient`, `parameter pollution`) are real bug shapes our harness doesn't yet detect.

### Lane 5 — guardrails-cloud reference architecture

The `process` / `revalidate` pipeline is structurally what guardrails-cloud could ship if/when it grows past deterministic-only:

- **Candidate stream** = harness check output (instead of regex matchers).
- **Judge** = cloud-side LLM that reads each flagged file via Read tool and emits structured verdicts.
- **Persistence** = `FileRecord`-style append-only schema with `analysisHistory[]` so re-runs merge additively across model changes.
- **Sandbox fanout** = Cloudflare Sandbox SDK as the equivalent of Vercel Sandbox microVM fanout (manifest-driven, idempotent resume).

The cost reality (thousands–tens of thousands per scan) is also a pricing-model lesson: per-flag judge calls beat per-repo flat fees if guardrails-cloud ever offers an LLM-judge tier.

## 6. Smallest spike

**Half a day.** Port the five highest-confidence, lowest-FP matchers (`secret-in-fallback`, `secret-in-log`, `dockerfile-run-as-root`, `dockerfile-curl-pipe-unverified`, `cors-wildcard`) into `generic-checks.ts`. Shape:

1. New file `src/harness/checks/secret-fallback.ts` etc. (or inline if the existing single-file pattern is preferred). Use deepsec regexes verbatim where the patterns are tight; tighten where deepsec's `normal` tier is too loose for our default gate.
2. Register through `check-registry/entries-warnings.ts` + `check-metadata.ts` per the agent-quality-checks recipe in CLAUDE.md.
3. Add a NOTICE entry attributing deepsec's Apache 2.0 license for the regex content (per the `bitar-decider.md` precedent for borrowed substrate).
4. Add fixtures + tests in `__tests__/generic-checks-extended.test.ts`.
5. Run `interlinked verify` over this repo and `reference-repos/serena/`, `reference-repos/cody-public-snapshot/` to calibrate FP rate. If FP rate is >5% on real repos, demote to advisory (`DEFAULT_ADVISORY_SKIPS`); else leave on the default gate.

**Sequel spike (another half day):** extract a `regexBundle()` helper modeled on `regexMatcher` and refactor 2–3 existing checks to use it, validating that the abstraction holds. Only land if the port-and-refactor delta is net-negative LoC.

The agentic-prompt-input + prompt-leaks-system-prompt matchers are higher-value but trickier to calibrate (the two-phase LLM-call-site detection has more moving parts) — those are a separate spike.

## 7. Artifact

- **PR** (this codebase): 5 matcher ports + NOTICE attribution + tests. ~half day.
- **Memory note**: this file. The noise-tier + scan-then-judge architectural observations don't belong in code yet; they're framing for future check-registry work.
- **Cloud-roadmap entry**: append a "deepsec-style judge layer" sketch to the guardrails-cloud roadmap doc in the sibling server repo (per `reference_sibling_server_repo.md`). The append-only FileRecord schema and Vercel Sandbox fanout pattern are the load-bearing references.

## 8. Surface

- **interlinked-cli:** matcher ports into `generic-checks.ts`; potential `noiseTier` field on `CHECK_REGISTRY`; potential `regexBundle()` helper extraction.
- **guardrails-cloud:** full lane-5 judge-pipeline architecture (FileRecord schema, idempotent stage merge, sandbox fanout, append-only analysis history, per-finding revalidation verdict).
- **agency-cloud:** none directly. (deepsec is a security product, not an agent-coordination product.)

## Notes

- The README's "Treat `deepsec` like a coding agent with full shell access" warning is the right framing for any LLM-judge product. Worth lifting almost verbatim into guardrails-cloud's threat-model doc.
- deepsec ships a `SKILL.md` at `packages/deepsec/SKILL.md` — a thin pointer file telling Claude Code where the docs live. This is the same pattern the user has been building toward with the `enforce` skill: SKILL.md as the entry point that routes the agent to the source of truth. Worth a separate look at the SKILL.md *style* (it's notably brief — 53 lines, no rules, just doc pointers + how-to-answer-common-questions table).
- Default model is `claude-opus-4-7` for both `process` and `revalidate`, which matches the Anthropic SDK conventions in the `claude-api` skill. Codex backend uses `gpt-5.5`. Same prompt, same JSON schema — the agent abstraction is clean.
- The `data/<projectId>/files/` layout (one JSON per source file, gitignored, additively merged across stages) is a more disciplined version of what our `recurrences.jsonl` is moving toward. Reference shape if/when we expand `recurrence.ts` past JSONL append.
- Plugin contracts (`packages/core/src/plugin.ts`) split into additive vs single-slot extension points (`matchers/notifiers/agents` additive; `ownership/people/executor` single-slot). That's a useful taxonomy for our own potential check-registry plugin surface.

## Methodology notes

The current INTAKE.md template treats determinism as a binary axis (deterministic → CLI; agentic → cloud). deepsec is the cleanest hybrid in the corpus and it argues for a third question for hybrids: *how does the deterministic layer hand off to the agentic layer*? deepsec hands off via `FileRecord.candidates` (a structured artifact); CodeWiki hands off via direct LLM call inside the recursion. Different shapes, different reuse stories. If more hybrids show up, fold a "composition" prompt into the rubric — for hybrid systems, the substrate value is often in the *handoff schema*, not in either layer alone.
