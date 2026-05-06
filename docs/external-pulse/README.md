# External-Pulse

A small intake corpus for evaluating tools, papers, frameworks, and repos before deciding whether (and where) to adopt them.

## Why this exists

When you encounter something interesting on Twitter, GitHub, or in a paper and want to know "could we use this?", the natural move is to paste a link and ask an AI agent. That question is undertyped — there's no taxonomy to land in, so the answer drifts toward whatever's associatively nearby. Naming the lane first changes the conversation.

The rubric in [INTAKE.md](./INTAKE.md) forces the categorization. Six lanes; a determinism filter; a one-page eval per project; commit it.

## Usage

For any non-trivial external project, **before** asking an AI agent what to do with it:

1. Copy the template from [INTAKE.md](./INTAKE.md) into `docs/external-pulse/<slug>.md`.
2. Fill in the seven questions, in your own words. Read the source for the load-bearing function — marketing language can hide LLM dependencies inside "deterministic" or "DP-inspired" framings.
3. Commit the file. The corpus is the artifact.

For drive-by curiosity, skip the rubric — it's only worth the friction for things you'd otherwise paste-and-ask.

## Worked examples

- [codewiki.md](./codewiki.md) — multi-agent LLM-driven repo wiki. Lane 5 primary (cloud-only fodder, fits a hypothetical docs-cloud line), lane 3 latent (polyglot dep-graph substrate). Verdict: memory note. Useful illustration of the "marketing-vs-reality" failure mode the rubric exists to catch.
- [agent-ci.md](./agent-ci.md) — local GitHub-Actions runner with cloud-API emulation. Lane 4 (pattern) + thin lane 3 (invoke as subprocess from `interlinked verify`). Verdict: half-day spike. Useful illustration of the **license gate** failure mode — FSL-1.1-MIT blocks substrate borrowing for two years, narrowing the usable lanes substantially.
- [serena.md](./serena.md) — LSP-backed MCP server giving coding agents IDE-grade symbol tools across 40+ languages. Lane 3 (integration via MCP) + lane 4 (pattern reinforcement). MIT-licensed. Verdict: two independent half-day spike options + this is the third project affirming "MCP-as-tool-surface for agents", which escalates the pattern from memory-note to RFC-worthy.
- [railway-agent-incident.md](./railway-agent-incident.md) — Railway's blog post about an AI agent deleting a customer database via a long-lived account-scoped API token, plus their safety roadmap response. First prose source in the corpus (blog post, not repo). Lane 4 (pattern) + thin lane 2 + thin lane 1. Verdict: a one-page design-principle doc + a trajectory-level destructive-API rule. **Fourth project converging on "agents need designed-for-them surfaces, not legacy APIs"** — the pattern cluster crosses from memory-note to explicit RFC threshold here.
- [openai-auto-review.md](./openai-auto-review.md) — Codex Auto-review mode for model-based approval of sandbox-boundary escalations. Lane 5 primary (cloud-only LLM reviewer) + lane 4 (separate reviewer role, denial-as-steering, repeated-denial stop) + thin lane 2 (deterministic lint for unsafe Codex approval bypasses). Verdict: memory note + half-day CLI lint spike.
- [deepsec.md](./deepsec.md) — Vercel Labs' two-stage AI vulnerability scanner: ~115 deterministic regex matchers (`scan`) feed candidates to a Claude/Codex Agent SDK judge (`process` / `revalidate`). Lane 2 primary (5+ matchers port directly into `generic-checks.ts` — Dockerfile, secret-in-fallback, CORS wildcard, sink-side prompt-injection) + lane 4 (the scan-then-judge architecture is the *inverse* of our deterministic-only constraint; `noiseTier` is a precision axis we're missing) + lane 5 (reference architecture for guardrails-cloud's eventual judge layer). Apache 2.0, copy-pasteable with NOTICE attribution. Verdict: half-day matcher-port PR + memory note + cloud-roadmap entry.

## Adjacent tooling

- [`/enforce` skill](../../.claude/skills/enforce/) — distills lane-1 imperative content (AGENTS.md, style guides, hard-imperative SKILL.md) into deterministic harness rules. If a candidate is purely lane-1, you can usually skip the rubric and run `/enforce <target>` directly.
- [Harness checks](../generated/quality-checks.md) — where lane-2 detection techniques and lane-3 substrate improvements actually land.
