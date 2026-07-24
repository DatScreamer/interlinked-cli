# Buzz (block/buzz)

- **Source:** https://github.com/block/buzz — Apache-2.0, Rust, 3.2k★, created 2026-03-06, HEAD `7e34bee` (2026-07-21)
- **Encountered:** 2026-07-22, user asked whether to stand one up locally or as a remote server
- **Verdict:** **Compound.** Lane 4 (pattern — agent identity + owner attestation) + lane 3 candidate (`git-sign-nostr`, invoke-as-subprocess). **Do not stand up a relay yet.** Reject as coordination infrastructure; adopt the identity pattern; run one free pre-spike first (see §7).

## 1. Core idea (one sentence, your words)

Buzz is a self-hostable Nostr relay (NIP-29 groups + NIP-42 auth) wearing a Slack UI, where AI agents are members with their own keypairs rather than bots behind a webhook — so every message, reaction, and membership change is a Schnorr-signed event attributable to a specific human or a specific agent.

## 2. Anatomy (concrete walkthrough)

26 Rust crates (~219k LOC) + a separate Tauri desktop workspace (~92k LOC Rust, 1,132 more packages) + web/admin-web/Flutter mobile (~229k LOC TS).

| Crate | LOC | Role |
|---|---|---|
| `buzz-relay` | 58k | WS relay, NIP-42, REST bridge, git hosting, huddle audio |
| `buzz-acp` | 32k | **Not** an ACP↔MCP bridge (README:180 is wrong — no `rmcp` server dep). ~2k lines of ACP client + 30k of Nostr chat-bot runtime (pool, queue, reconnect) |
| `buzz-db` | 26k | Postgres event store |
| `buzz-agent` | 18k | Standalone ACP agent (Anthropic / OpenAI-compat / Databricks) |
| `buzz-cli` | 15k | Agent-facing CLI: 21 groups, 101 leaf subcommands |
| `buzz-dev-mcp` | 5k | The only MCP **server** in the repo — 7 tools |
| `buzz-workflow` | 4.4k | YAML step machine, `evalexpr` conditions, zero LLM |
| `buzz-audit` | 1k | Per-tenant SHA-256 hash chain |
| `git-sign-nostr` | 2.5k | **Standalone** git signing backend — no relay needed |

**What the agent sees.** `buzz-dev-mcp` exposes exactly: `shell`, `read_file`, `view_image`,
`str_replace`, `todo`, `_Stop`, `_PostCompact` (`buzz-dev-mcp/src/lib.rs:30-127`). There are
**zero Buzz/Nostr MCP tools** — agents reach the relay by shelling out to the `buzz` CLI, which
is symlinked onto `PATH` as a multicall personality (`shim.rs:31-40`). Claude Code sessions get
**no** MCP servers at all (`mcp_command: None`, `discovery.rs:101`).

**End-to-end session.** Tauri desktop mints a per-agent nsec → spawns `buzz-acp` with
`BUZZ_PRIVATE_KEY` (`runtime.rs:1578-1605`) → `buzz-acp` connects to the relay, subscribes to its
channels → a channel message passes the client-side `author_allowed` filter (`buzz-acp/src/lib.rs:197-213`)
→ prompt goes over stdio ACP to a spawned agent binary (for Claude: the external npm adapter
`@agentclientprotocol/claude-agent-acp`, zero flags, `config.rs:613-615`) → agent calls tools →
`bash -c <model string>` runs in `~/.buzz` or `$HOME` → output posts back as an agent-signed
kind:9 event.

## 3. Deterministic or agentic?

**Hybrid, split cleanly.** Deterministic: the relay, signature verification, Postgres FTS search
(`buzz-search/src/lib.rs:5-10` — a generated `tsvector` column, no embeddings), and the workflow
engine (`evalexpr`, 4096-byte/100ms bounds, no LLM dependency in the crate). Agentic: `buzz-agent`
and everything downstream of `buzz-acp`.

**License:** Apache-2.0 throughout — clean for code-borrow and paid reuse. One supply-chain edge
inherited: `Cargo.toml:164-171` pins `aws-creds` to a Block employee's personal fork.

## 3b. Role in its native architecture — and does it transfer?

Natively the relay is **the** trust boundary, and it is a real one: NIP-42 is unconditional on the
WebSocket (`nip11.rs:90-95`, `handlers/event.rs:612-630`), ingest rejects any event whose `pubkey`
≠ the authenticated identity (`ingest.rs:1499-1503`), and read authorization has separate gates for
`#p`-gated kinds, agent engrams, and author-only kinds — applied *before* the NIP-50 search branch
specifically to close a search-harvest bypass (`req.rs:174-205`).

**But the boundary protects the relay, not the machine.** The shell tool sits entirely outside it,
by explicit design: *"No containment enforcement — the resolved path may land anywhere on the
filesystem"* (`buzz-dev-mcp/src/paths.rs:4-5`). The only thing between an untrusted channel
participant and code execution on the operator's laptop is `respond_to` — a **client-side** default
the relay neither knows about nor enforces (`buzz-acp/src/lib.rs:2063-2082`).

**Transfer verdict:** the identity half transfers; the authorization half does not exist to transfer.
In our topology the relay would be an *observability + attribution* surface only — never a gate.

## 4. Substrate vs. surface

- **Surface:** the workspace (channels, canvases, huddles, git forge). Aimed at multi-human teams.
- **Substrate worth having:** NIP-OA owner attestation (`buzz-sdk/src/nip_oa.rs:109-166`) + `git-sign-nostr`. Preimage is `"nostr:agent-auth:" || agent_pubkey || ":" || conditions`, BIP-340 signed by the *owner*; self-attestation rejected at both sign and verify (`:152-156, 216-220`).
- **Critically: the substrate runs standalone.** `git-sign-nostr` is a `gpg.x509.program` backend. No relay, no Postgres, no Docker.

## 5. Lane

**Lane 4 (pattern), with a lane-3 sub-borrow.** The workspace itself is lane 6/skip for us — it
solves multi-human coordination, which per `INTAKE.md` has no surface on the §8 rollout. The
identity model is lane 4; `git-sign-nostr` is lane 3 via invoke-as-subprocess (no dep added).

## 6. Dependency & displacement

- **Deps:** none if we borrow the pattern; `git-sign-nostr` is a subprocess, not an import. Standing up the relay adds an entire operated system, not a dependency.
- **Displacement:** overlaps `src/commands/{send,inbox,tasks,handoff,workspace,attach}.ts` (thin MCP-tool wrappers) and, at the audit layer, `src/lib/audit-chain.ts`.
- **Equivalence, capability by capability:**

| Buzz capability | Our equivalent | Status |
|---|---|---|
| Hash-chained audit log | `src/lib/audit-chain.ts` + `interlinked audit verify` | **shipped — and ahead.** Buzz's `verify_chain` has *zero* production callers (only `#[cfg(test)]`), no admin route, no CLI, no export. We ship the verifier they don't. |
| Agent→human messaging, tasks, handoff | `send` / `inbox` / `tasks` / `handoff` | **shipped** (thinner, but sufficient for solo-operator-many-agents) |
| Deterministic full-text search | `trigram-index.ts` + grep accelerator | **shipped** |
| Per-agent cryptographic identity | — | **absent.** Real gap; the R1 rung of `project_proof_of_enforcement_bft_extensibility.md` |
| Owner→agent delegated authority | — | **absent.** Same gap |
| Per-edit action authorization | the entire harness | **shipped — Buzz has none.** Their gap is our product |
| Multi-human shared rooms | — | **absent, and out of scope** (no §8 surface) |

## 7. Smallest spike

**Free pre-spike, ~10 minutes, zero infrastructure — do this first.** `buzz-acp` drives the
*local* Claude Code install (`underlying_cli: Some("claude")`, readiness probed via
`claude auth status`; no Anthropic key on any relay host). Whether Interlinked's hooks fire under a
Buzz-driven session depends entirely on `@agentclientprotocol/claude-agent-acp` — an external npm
package **not vendored in this repo**. `npm pack` it and read how it invokes Claude.

- **Hooks fire →** Buzz + Interlinked composes into cryptographic attribution *plus* deterministic
  gating, which neither has alone. That justifies a local standup to build the demo.
- **Hooks don't fire →** Buzz is a pattern read; we're done, at zero cost.

**Real spike (~half a day, if we want the identity gap closed regardless):** wire `git-sign-nostr`
as a signing backend for agent commits and carry a NIP-OA owner attestation. Gets us
"which human authorized which agent to make this commit," verifiable offline, with no relay.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|---|---|---|---|
| Free CLI (P1) | Agent-identity signing of chained audit records / commits via `git-sign-nostr` | §7 real spike | next |
| Guardrails (P2–3) | Cloud-anchored attestation — the external anchor Buzz's chain lacks (R1) | Sign chain heads server-side | parked |

The workspace itself has **no surface row**. Multi-human coordination is not a phase
(`INTAKE.md`), and we are currently one human with many agents — the regime where our existing
`logs --follow` / `viz` / `watch` beat a channel feed.

## 9. Artifact

**Compound verdict.**

- **Reject** as coordination or observability infrastructure. We already ship the equivalents, and the multi-human value has no surface yet.
- **Reject** a remote standup now — see Notes for why the risk is asymmetric.
- **Adopt** the owner-attestation *pattern* as prior art for proof-of-enforcement R1; borrow `git-sign-nostr` as a subprocess if we build it.
- **Adopt** two audit-chain construction details (Notes).
- **Gate** any local standup behind the free pre-spike in §7.

## Notes

**Why not remote, concretely.** The code defaults are dev defaults and they compound:
`BUZZ_REQUIRE_AUTH_TOKEN` defaults **false** (`config.rs:463-465`), which makes a bare
`X-Pubkey: <any hex>` header full REST identity with replay detection explicitly skipped
(`bridge.rs:117-125`); with it false and `BUZZ_RELAY_PRIVATE_KEY` unset, the relay signs
NIP-29/43 events with a key committed in the repo as `0x…01` (`main.rs:398-405`);
`BUZZ_REQUIRE_RELAY_MEMBERSHIP` defaults false so any generated keypair is a member; and the
per-IP connection limiter is **dead code** with no production caller (`admission.rs:85` is a
`#[cfg(test)]` stub), so per-pubkey rate limits fall to trivial keypair rotation. The
`deploy/compose` and Helm paths set all of these correctly — but nothing warns someone who
follows the README's dev path onto a VPS.

Add the release asymmetry: **desktop has shipped 70 releases, the relay exactly 2**, and
relay-v0.2.0 was a from-scratch multi-tenant schema rewrite requiring an operator cutover script
(`scripts/cutover/1321_backfill_default_community.sql`). "BREAKING" appears **zero** times in a
changelog that plainly contains breaking changes. `deploy/compose/.env.example:5-6` still says to
pin a semver tag "once available."

**Marketing vs reality** (the rubric's core discipline — README claims the source refutes):

| Claim | Reality |
|---|---|
| "every message, reaction, workflow step, review approval, and git event is a signed event in one log" (README:36) | **Workflow steps are never signed events** — kinds 46001-46007 have zero emit sites; runs live in a `workflow_runs` JSONB column. Audit entries (48001) likewise never emitted. It is four stores, not one log. |
| "JSON in / JSON out" (README:157) | No envelope; 8+ subcommands emit prose, TSV, or raw bytes. `--format` is honored at 5 call sites; `moderation::dispatch` names the param `_format` and discards it. Errors *are* genuinely structured. |
| "Scoped by identity, not by permission flags" (README:47) | Open channels are readable **and writable** by any authenticated identity in the community (`channel.rs:633-643`, `ingest.rs:508-522`). `SECURITY.md:57-61` is wrong. NIP-98 callers get `Scope::all_known()` unconditionally. |
| NIP-OA `conditions` as scoping | `kind=` clauses enforced **nowhere**; `created_at` only in the identity-archive handler. Attestations are not audience-bound → replayable at any relay where the owner is a member. |
| "Workflow approval gates (infra exists, glue still drying)" (README:102) | **Accurate** — the one calibrated claim. `TODO (WF-08)` at `executor.rs:663`; a `request_approval` step fails the run permanently (fail-closed but non-functional). 3 of 7 workflow actions work; `add_reaction` POSTs to a route that doesn't exist. |

**What Buzz does better than us — two borrowable details for `audit-chain.ts`:**
1. Tenant id **leads** the digest (`buzz-audit/src/hash.rs:19-46`) so a row cannot be lifted between chains. Ours covers `workspace_key`/`session` by whole-record inclusion, which is equivalent — worth a regression test pinning it.
2. Presence-tagging so `None` and `Some(vec![])` cannot collide, and **hard-fail on serialization error** rather than a silent empty. Our `canonicalJson` maps `undefined → "null"` via `?? "null"`, collapsing `undefined` and `null` to one preimage.

**Gap Buzz surfaced in our code:** `appendGuardDecision` (`hook-template-chunks/session-state.ts:687`)
tail-reads the previous hash then `appendFileSync`s with no lock. Buzz serializes appends with a
per-community `pg_advisory_lock` released on all paths including panic (`service.rs:50-70`).
Parallel agents = parallel hook processes → both read hash `H`, both write `previousHash: H`; the
verifier walks a single `expectedPrev` and only forgives forks rooted at `GENESIS`
(`audit-chain.ts:203-215`) → false `TAMPERED`. Tracked separately; not a Buzz adoption item.

## Methodology notes

Four parallel read-only source agents (agent surface / ACP bridge / workflow+audit / deploy+ops)
against a `--depth 1 --filter=blob:none` clone. The split paid off: the deploy agent found
`deploy/compose` + the Helm chart, which **refuted** an early conclusion drawn from `AGENTS.md`'s
five-repo table that the production path was Block-internal. Worth generalizing — *"the repo's own
architecture doc describes the vendor's pipeline, not the OSS deployment surface"* is a distinct
failure mode from the CodeWiki marketing-vs-reality case, and it cut the opposite way (the project
was **better** than the doc implied).
