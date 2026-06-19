# Arbiter Security (arbitersec.com)

- **Source:** https://arbitersec.com (+ /arbiter, /aletheia, /blog ×6) — closed-source products. Founder: Laurence Avent, https://github.com/postrv. Reverse-engineered 2026-05-21.
- **Encountered:** 2026-05-21, user request — "reverse engineer arbitersec.com and their two MCP servers as much as possible."
- **Verdict:** memory note (competitive landscape) + Lane 4 patterns — and those patterns are *already ours*, so this is convergent evidence, not a backlog item. **Skip for code:** the two flagship products are closed-source and sit in a different product category from our defensive harness. Follow-up: a dedicated `forgemax.md` intake (the one genuinely transferable design — needs a source read, not done here).

## 1. Core idea (one sentence, your words)

A solo-founder UK venture selling two closed-source Rust "MCP servers" that hand an AI agent *offensive*-security capability — **Arbiter** turns captured web traffic into a typed state graph and hunts/verifies web-app vulnerabilities; **Aletheia** loads PE/ELF/Mach-O binaries, decompiles them to typed C through an SSA pipeline, and finds memory-safety bugs with concolic proofs — both waitlist-only, sold to pentesters and reverse engineers.

## 2. Anatomy (concrete walkthrough)

This is a **prose-source intake** — the two flagship products have *no public code* (no repo, no crates.io/npm/PyPI package, no GitHub org). Everything below is the company's own account from six engineering blog posts (all dated 2026-04-17); only Forgemax and Narsil are independently inspectable.

**Verifiable vs. claimed — the split that matters:**

| Component | Public? | Status here |
|---|---|---|
| **Arbiter** (web pentest MCP, 267 tools, 52 vuln classes) | Closed | Blog-described only — unverifiable |
| **Aletheia** (binary-analysis MCP, 140 tools, v1.1) | Closed | Blog-described only — unverifiable |
| **Forgemax** (MCP gateway, 2 tools) | Open — `github.com/postrv/forgemax`, FSL-1.1-ALv2 | Real, ~149★ — needs its own intake |
| **Narsil** (code-intel/SAST MCP, 90 tools) | Open — MIT/Apache | Has its own intake `narsil-mcp.md` |
| **Sanctum** (runtime dev-security daemon) | Open — `github.com/postrv/sanctum-oss`, MIT | The real adjacency (see Notes) |

**Arbiter — load-bearing claims.** "Constraint-driven discovery": ingest HTTP traffic → build a typed state graph (endpoint nodes, `AuthBoundary`/`CsrfFlow`/`ParamValueFlow` edges) → 7 inference engines emit 11 constraint categories with confidence scores → a hypothesis generator tests only for *violations* (IDOR/privesc/auth-bypass). Bolted on: an HTTP/2 single-packet race engine (`h2` crate, 4 sync strategies, 12 race types — a faithful read of Kettle's Black Hat 2023 work), Chrome-DevTools-Protocol browser verification, a 16-rule auto-correlation engine, exports to HackerOne/Bugcrowd/SARIF.

**Aletheia — load-bearing claims.** A 5-phase decompiler: `goblin` load → `iced-x86`/`capstone` disassembly → 43-opcode SSA IR (Cooper-Harvey-Kennedy dominators, Cytron phi insertion) → union-find type recovery (cites Retypd/TIE/Mycroft) → typed-C emission. Plus Z3 concolic falsification (every finding ships a concrete witness), AFL-style hybrid fuzzing, and 4-tier MITRE-ATT&CK evasion detection. `#![deny(unsafe_code)]` workspace-wide.

**The honest read of the anatomy:** the blogs are technically literate — they cite the right papers and pick defensible crates. But the products are unbuildable-to-verify, the headline numbers are marketing figures (Narsil's own tool count drifted 76→90 between launch and now), and the proof claims — "100% on Google Firing Range," "0% false positives," responsible disclosures to Anthropic/Cloudflare/SecureDrop — are **self-reported with zero corroboration** (no CVEs, no GHSAs, no HackerOne profile). This is the CodeWiki marketing-vs-reality lesson in its strongest form: you cannot read the source at all.

## 3. Deterministic or agentic?

**Hybrid, branded deterministic.** "Deterministic Output" is one of the company's three stated pillars, and the core engines *are* deterministic algorithms (constraint graph, SSA decompiler, Z3 concolic, race timing). But the leaves are agentic: Arbiter's **Polychrome** module does "SLM-powered mutation" for WAF bypass, the **Prompt Shield** tools are AI-security auditing, and Aletheia's hybrid fuzzer does "LLM-guided search." Under our determinism filter those agentic leaves are lane-5, cloud-only — they would not be CLI-eligible even in our own product.

**License: proprietary / closed-source** for Arbiter and Aletheia — this alone **blocks lanes 3 (code-borrow) and 5 (paid reuse)**; only lane 4 (pattern) survives. (Forgemax is **FSL-1.1-ALv2** — source-available, converts to Apache-2.0 after 2 years; still blocks code-borrow. Narsil is MIT/Apache — borrowable, but it has its own file.)

## 4. Substrate vs. surface

- **Surface:** two offensive-security products (web pentest, binary RE), each exposed as an MCP server + REST API + CLR, waitlist-gated, priced Free/$79–99/Enterprise.
- **Substrate:** the constraint engine, the typed state graph, the SSA/IR decompiler, the race engine. **None of it is borrowable** — it is closed. The only separable substrate in the wider portfolio that *is* open is Forgemax (the gateway) and Narsil (code intelligence) — different files.

## 5. Lane (1–6)

**Lane 6 (skip) for the two products + Lane 4 (pattern) for a short list — and the patterns are already ours.**

- **Lane 6** — Arbiter and Aletheia are closed-source *and* a different product category. Interlinked is a *defensive* guardrail harness for AI coding agents; Arbiter/Aletheia are *offensive* tools whose customer is a bug-bounty hunter or malware analyst. Same call `qmd.md` got ("different category → lane 6"): nothing to borrow, nothing to displace.
- **Lane 4** — three patterns, all of which we already practice: (a) **determinism-first + every-finding-ships-a-replayable-proof** — identical stance to our `[proven]`/`[heuristic]` determinism tagging and the witness-carrying `e2e-protocol-*` probes; (b) **risk-tiered tool permissions** — Aletheia's phrase for what our guard-rule severity tiers already do; (c) **engineering-blog-as-GTM** — six deep technical posts as the entire top-of-funnel (a business-side note, not a code one).

## 6. Dependency & displacement

- **Deps:** N/A. Closed-source products — there is nothing to import or shell out to. (Forgemax/Narsil dep questions belong in their own files.)
- **Displacement:** **none.** Interlinked does no offensive security; there is zero overlap with `project-graph.ts`, `trigram-index.ts`, `evaluator.ts`, or any check family. The single genuine adjacency is **Sanctum** (a separate repo, see Notes) against our supply-chain allowlist + secrets layer — and that is convergence, not displacement: we shipped that surface first.

## 7. Smallest spike

**N/A — you cannot spike a closed competitor product, and a competitor's marketing is not a spike.** The spike-equivalent for this find is this intake plus the memory note. The one place a real spike exists is Forgemax's 2-tool collapse — and that spike belongs in `forgemax.md`, after its source is actually read.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | **Nothing to build.** Determinism-first and witness-carrying findings are convergent evidence for the existing `[proven]`/`[heuristic]` design — external validation, not a change. | — (memory note) | parked |
| Guardrails (P2–3) | **Nothing.** Offensive-security capability is a different product; Guardrails is a sub-second *defensive* blocking gate. Wrong category and wrong tempo. | — | parked |
| Agent CI (P4–5) | **Weak / none.** An async deep-scan could include SAST — but that is Narsil's lane (`narsil-mcp.md`, already routed to P4), not Arbiter's web-pentest engine. Rebuilding Arbiter/Aletheia would be a product pivot, not a roadmap item. | — | parked |

Parked on every surface. That is the correct verdict, and recording *why* it does not fit is the point of the rubric.

## 9. Artifact

- **Memory note** (`reference_arbitersec_competitor.md`) — competitive landscape: adjacent category, not a direct competitor; Sanctum is the piece to watch.
- **This file.**
- **Recommended follow-up:** a dedicated `forgemax.md` intake **with a source read** (clone to `reference-repos/forgemax`). Forgemax's N×M-tools → `search`+`execute` code-mode collapse is the one genuinely transferable design in the portfolio; it deserves its own rubric pass, not a paragraph here.
- **No PR, no harness check, no roadmap item.**

## Notes

- **Closed and unverifiable is the headline.** No public code for Arbiter or Aletheia. The architecture in §2 is the company's own engineering blog — detailed and technically credible, but unbuildable-to-check. Headline claims (Firing Range 100%, 0% FP, the Anthropic/Cloudflare/SecureDrop disclosures) are self-reported; OSINT found no CVEs, GHSAs, or HackerOne presence. Treat as marketing until proven.
- **Different category, by design.** This is why the verdict is lane 6, not "competitor." A defensive harness and an offensive pentest tool only look similar because both say "MCP" and "AI agents." The customers, the workflow, and the failure modes are disjoint.
- **Sanctum is the real one to watch.** `github.com/postrv/sanctum-oss` (MIT) — "developer security daemon for the AI coding era": runtime integrity monitoring, an AI-credential *egress* firewall, LLM-spend tracking, slopsquatting / malicious-`.pth` detection. We already ship the core of this (the supply-chain allowlist with typosquat detection, secrets detection). Sanctum is convergent evidence our direction is right, and a source of 2–3 *candidate* additions (credential-egress firewall, LLM-spend budgets) — but those are their own intake if pursued, not this file's.
- **Mythos positioning.** The site's "post-Mythos security workflow" framing rides Anthropic's 2026-04-07 *Claude Mythos* announcement (a model noted for autonomous zero-day discovery). The whole brand is ≤6 weeks of news-cycle-timed positioning on a 3-month-old domain.
- **Convergent evidence, recorded.** ArbiterSec's stated philosophy — "reproducible, structured, every finding ships a proof a human can replay, no 'potential'/'likely'" — independently restates our own `[proven]`/`[heuristic]` tagging and witness-carrying probes. Same shape as the reservation-model convergence noted in `activegraph.md`: two designs converging under different pressures is a signal the abstraction is right.
- **Related entries:** `narsil-mcp.md` (Narsil — same author, routed to Agent CI / P4; not re-evaluated here), `failproofai.md` (the actual direct competitor — local hook-guard, same category as us), `codewiki.md` (the read-the-source precedent), `qmd.md` (the "different category → lane 6" precedent).

## Methodology notes

- **First closed-source-competitor intake.** The rubric assumes you can read the source; here the flagship products have *no public code at all*. The working adaptation: §2 becomes prose-source (the engineering blog) with a hard verifiable-vs-claimed table up front; §3's determinism read is necessarily "as described"; §6–§7 collapse to N/A. When a find is a closed product, the verdict honestly trends to **lane 6 + lane 4** — you cannot borrow what you cannot read, and a competitor's blog is not a spike.
- **A company is not a project.** "Arbiter Security" resolved to five distinct projects (Arbiter, Aletheia, Forgemax, Narsil, Sanctum). The disciplined mapping is one intake per *evaluable* project: this file = the closed flagship pair; `narsil-mcp.md` already exists; `forgemax.md` (and possibly `sanctum-oss.md`) are follow-ups. Don't let "reverse engineer the company" collapse into one mega-file.
- **Suggested INTAKE.md edit if a second closed-competitor find lands:** add a note that for closed products §2 is prose-source + a verifiable/claimed split, §6–§7 are usually N/A, and the verdict trends lane 6+4 — the determinism filter still applies to whatever leaves you *can* see.

## Addendum — 2026-06-12 re-check (witness pattern amended)

- **No upstream changes.** Same six blog posts (all 2026-04-17), same waitlist-gated closed products. The §2 anatomy stands.
- **Lane-4(a) was half-right and is amended.** The original read called the witness discipline "identical stance to our `[proven]`/`[heuristic]` tagging." That conflates two things: we tag the provenance of the *check* ("a compiler ran"); Aletheia (as claimed) proves the *finding* ("this concrete input triggers this bug"). Finding-level witnesses are a capability we do **not** ship — they are the promotion mechanism the advisory tier lacks. The gap-closing design is `docs/design/witness-backed-verification.md` (W4 witness-escalation executor; W1 overlay-run observers). Verdict upgrade for that one pattern: lane 4 → actionable design, landed there rather than re-opening this file.
- **Fourth-ish convergence noted:** Aletheia's "differential validation against a Unicorn oracle" is the predict-vs-oracle shape of our shipped predict/reveal/reconcile protocol (after ECHO and Devin).
