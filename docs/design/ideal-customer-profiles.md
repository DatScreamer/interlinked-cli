# Ideal Customer Profiles — Free CLI + Guardrails + Agent CI

**Status:** Strategy / living doc. Companion to `three-product-architecture.md` —
§7 there defines the SKUs and sales motion; this doc defines *who* each SKU is
for, what pain qualifies them, how to reach them, and in what order to pursue
them. Grounded in the shipped CLI surface (README receipts, check inventory),
`proof-of-enforcement.md` (the OSS-PR customer), and July-2026 market signal
(sources at bottom).

**Audience:** Product/GTM decisions. Written 2026-07-09.

---

## TL;DR

Five ICPs, pursued in this order:

| # | Handle | Who | Product | When (§8 phase) | Role in the business |
|---|--------|-----|---------|------------------|----------------------|
| 1 | **The fleet-runner** | Senior IC / technical founder running 2–5 concurrent coding agents daily | Free CLI | Now (P1) | Adoption engine, credibility, design-partner pool |
| 2 | **The agent-leverage shop** | AI-native dev shop / product studio (5–50 people) whose margin *is* agent-hours per human | Guardrails Team → Agent CI | P2–P5 | **First paying customer.** Fastest sales cycle a solo founder can serve |
| 3 | **The accountable platform lead** | Platform/DevEx lead at an AI-mandated org (50–500 eng) | Guardrails Team/Ent → Agent CI | P3–P6 | Primary expansion revenue; rides GitHub/Anthropic managed-settings rails |
| 4 | **The drowning maintainer** | High-traffic OSS project (backed by a foundation or corporate steward) | Refereed admission control (R1 attestation) | Post-P5 | Most differentiated wedge + a distribution flywheel (every submitter installs the free CLI) |
| 5 | **The evidence-hungry CISO** | Security/AI-governance buyer at a regulated org (500+ eng) | Enterprise tiers | P7 | Park now, design for later (SIEM-friendly receipts, ZDR/BYOK seams) |

**The master qualifying variable** is not company size or industry. It is
**agent autonomy × blast radius**: (a) unattended agent-hours per week,
(b) concurrent agents per repo, (c) cost of one ungoverned action, and
(d) whether someone *else* must be convinced the agents were governed.

**The free-vs-paid discriminator** (resolves §9's cannibalization risk):
- **Free CLI** = *protect me from my own agents* (correctness, taste, incident prevention — value accrues to the person running the agent).
- **Paid cloud** = *prove to someone else my agents were governed* (client, security team, maintainer, auditor — value accrues at a trust boundary).

Every paid ICP below has a named "someone else." When a prospect can't name
one, they're a free-tier user — serve them well and don't try to charge them.

---

## 1. Market context (July 2026) — why now

- Enterprise AI coding agents are a **~$10B annualized market** (April 2026)
  heading for ~$52B by 2030; 40% of enterprise apps will embed agents by
  end-2026 (Gartner via EnterpriseDNA).
- The governance gap is the story: **92% of enterprises say AI governance is
  essential; only 44% have any binding tooling** (Atlan). Gartner predicts
  >2,000 AI-related legal claims by end-2026 from insufficient guardrails.
- Gartner (May 2026) warns that **uniform governance across AI agents fails**
  — differentiated, per-context policy is required. That is literally our
  tool-class/risk-tier architecture; use the citation in sales material.
- **The platforms nativized policy *distribution*, not policy *depth*.**
  GitHub shipped enterprise `managed-settings.json` GA (2026-07-01) with
  always-enabled hooks, enterprise-managed Copilot CLI plugins (May), and
  bypass-permission lockdown (June); Anthropic publishes Claude Code
  enterprise deployment guides (managed settings, hooks, telemetry). None of
  them ship a deterministic per-tool-call policy engine, quality ratchets, or
  a fail-closed supply-chain gate. **They built the rail; Interlinked is the
  train.** An enterprise can now *mandate* the Interlinked hook fleet-wide
  through the platforms' own settings channel.
- **OSS is drowning in agent PRs**: ~17M agent-generated PRs/month on GitHub
  (March 2026), +325% in six months; ~1 in 10 meets the bar to even open
  review; Jazzband shut down over slop volume; GitHub Actions burn hit 2.1B
  minutes/week; GitHub is publicly pondering a PR "kill switch." The
  `proof-of-enforcement.md` cost-shift design is aimed at exactly this wound,
  and the press narrative ("enterprise teams are next") extends it inward.

Category naming caution: "AI agent governance" search results are dominated by
*non-coding* agent registries (Arthur, Credo, Galileo) and model-level
guardrails (Bedrock). We are not that. Position against **coding-agent
runtime enforcement** ("the harness for your harness"), not the governance
platform category, or inbound will be wrong-fit.

---

## 2. ICP-1 — The fleet-runner (Free CLI, now)

**Who.** Senior/staff-level IC, technical founder, or prolific indie hacker.
Runs Claude Code + Codex/Cursor/Gemini CLI concurrently — often 2–5 sessions,
often overnight or in background loops. Terminal-native, git-fluent, macOS or
Linux, TS/Node primary (Python/Rust secondary). Comfortable cloning a repo to
install a tool. Firmographics irrelevant — this is a *person*, found anywhere
from solo shops to FAANG.

**Pain / trigger events.**
- An agent ran `rm -rf` on the wrong path, force-pushed, or `git reset --hard`-ed away an afternoon (the README receipts show 13 destructive-git blocks in 38 days of one person's use — this is weekly-frequency pain).
- Overnight/background runs produce plausible garbage: skipped tests, stub implementations, suppressed lint, quietly deleted assertions. Trust in unattended operation collapses.
- Two agents stomp each other's edits on one tree.
- The npm/PyPI malicious-package wave makes every agent-initiated `npm install` a small heart attack.
- CLAUDE.md conventions are ignored by the agent that read them.

**Why Interlinked wins.** Only tool that (a) blocks *before damage* at the
tool-call boundary, (b) works identically across five runners, (c) does it
local-first with no telemetry — their code never leaves the machine, (d) adds
taste enforcement (ratchets, TDD gate, content-quality overlay) that keeps
unattended output at a bar, and (e) coordinates multiple agents on one tree
(lease-based reservations — 17 conflict blocks in the receipts). FailproofAI
is the nearest competitor at ~39 regex policies; the depth gap (~116 guard
rules + ~340 registered checks + trajectory detectors + ratchets) is the moat
to keep visible.

**What they pay.** Mostly nothing, by design (§7: the funnel). A slice
converts to Guardrails Hobby when they want the shared signature DB and
cloud-verified checks. Their real value: stars, word-of-mouth, receipts-style
evidence, and being the humans inside ICP-2/3 organizations.

**Objections / friction to fix.**
- Git-clone-only install (deliberate for now, but it filters out half the segment) → npm package + Homebrew + single binary is the single highest-leverage adoption unlock (§8 P1 already says this).
- Fear of FP noise slowing their loop → lead with the receipts framing ("865 audited blocks, here's the breakdown") and the advisory/default split.
- No Windows → say it plainly on the landing page (already done).

**Channels.** HN/X/lobste.rs launches keyed to incident stories ("my agent
deleted prod config — here's the boundary that would have stopped it"), Claude
Code / Codex community Discords, the receipts landing page, CONTRIBUTING.md
mentions from ICP-4 later. Measure per §8 P1: installs, DAU, retention,
star velocity (decision gate: 5K installs in 8 weeks of real packaging).

**Qualification (self-serve, so this is targeting, not sales):** they
recognize themselves in "how many agents did you run yesterday?" ≥2.

---

## 3. ICP-2 — The agent-leverage shop (first paying customer, P2–P5)

**Who.** CTO or founding engineer of an AI-native development shop, product
studio, or "fractional engineering" firm: 5–50 people, each human supervising
several agents; client work shipped largely by agents. Also covers the
adjacent shape: a venture studio or portfolio operator running agent fleets
across many small codebases, and teams running *headless* fleets (Devin-class,
custom Agent-SDK loops in CI) — the §3 standalone-Guardrails deployment mode.

**Why they're first-paid rather than ICP-3:** solo-founder-servable. Founder
sells to founder; no procurement; decides in days; tolerates git-clone
installs and rough edges; pays from opex. And their pain is *existential*
rather than budgetary: one agent leaking a client secret or trashing a client
repo ends the firm. Design-partner math (§8 P2 needs 5–10) fits this segment
exactly.

**Pain / trigger events.**
- Unattended agents on **client** repos: the blast radius is someone else's production.
- Per-client policy separation ("agent may never touch `infra/` on client A; client B forbids external packages entirely").
- Quality assurance without human review of every line — their margin depends on *not* reading everything, but their reputation depends on the output holding a senior bar.
- Clients (increasingly, client *procurement*) asking "how do you control the AI?" with no good answer.

**Why Interlinked wins.** Reservations/cohorts are built for many-agents-one-
tree; per-repo committed guard rules give per-client policy; the ratchets are
exactly "senior bar without senior review"; and — uniquely — **the receipts
become client-facing collateral.** "Every action your deliverable was built
from passed a deterministic policy gate; here's the replayable log" is a
*sales weapon for them*, which means the tool generates revenue for the
customer instead of only reducing risk. That inverts the usual guardrail
willingness-to-pay problem. This is the named "someone else": **the client.**

**What they buy.** Guardrails Team (shared signature DB, org policy, audit)
→ Agent CI Team (mutation/integration/SBOM on deliverables) → eventually
R0/R1 attestation as a branded "governed delivery" report. Budget anchor: they
already pay per-dev for AI review tools and per-seat for agent subscriptions;
price Guardrails Team against that line, not against security tooling.

**Objections.** Latency in the loop (answer: tool-class budgets, local-first
default, cloud only where it pays); vendor-of-one risk (answer: local tier
keeps working if the cloud vanishes — CLI/server independence is a genuine
differentiator here); "we built some hooks ourselves" (answer: the receipts
breakdown vs. their three regexes; maintenance burden).

**Channels.** These firms are loud by profession — X/LinkedIn "AI-first
agency" positioning, build-in-public founders. Direct founder outreach with a
personalized receipts audit ("install free, bring the log to a call"). A
public "governed delivery" case study from one lighthouse shop cascades
through the segment.

**Qualification checklist (≥4 of 5 = design partner):**
1. ≥2 concurrent agents or unattended runs, weekly or more
2. TS/Node primary stack (Python/Rust acceptable)
3. Can name a real agent incident or near-miss
4. Can name the "someone else" (client, auditor, security reviewer)
5. Terminal-native, macOS/Linux, git-fluent team

---

## 4. ICP-3 — The accountable platform lead (expansion, P3–P6)

**Who.** Head of Platform Engineering / DevEx / Developer Productivity at a
50–500-engineer product company (SaaS, Series B → pre-IPO), TS/Node-heavy.
Owns the Claude Code / Copilot / Cursor rollout under a top-down AI-adoption
mandate; personally accountable when an agent causes an incident; sits
between a CTO demanding velocity and a security team demanding control.

**Pain / trigger events.**
- A board-visible agent incident (secret leak, malicious dependency, deleted infra) — the 2025–26 npm worm wave made "an agent ran `npm install`" a security-review topic.
- Security team blocks expansion of agent autonomy ("no bypass-permissions mode") until real controls exist; the platform lead must produce the controls to unblock their own mandate.
- Instruction drift: the org wrote CLAUDE.md/AGENTS.md standards; nothing enforces them; every team's agents behave differently.
- Quality regressions attributed to AI velocity — coverage sliding, complexity creeping, review queues overwhelmed.

**Why Interlinked wins.**
- **Ride the new rails, don't fight them.** GitHub's enterprise `managed-settings.json` (GA 2026-07-01) can mandate hooks org-wide; Claude Code has managed settings with the same shape. Ship a documented recipe — "deploy Interlinked to every laptop via the settings channel you already control" — and the platforms' governance investments become our distribution. This is timely *right now*: every GHE platform team is currently deciding what goes in that file.
- Uniform policy across five runners, when their fleet is inevitably mixed (GitHub now offers Claude and Codex inside Copilot — heterogeneity is institutionalized).
- `/enforce` is the killer demo: their existing CLAUDE.md/AGENTS.md distilled into enforced rules with verbatim provenance in minutes. Zero-to-policy from docs they already wrote.
- Deterministic decisions + replayable log = explainable to security review, unlike LLM-judged gates. The named "someone else": **their security team.**
- The fail-closed supply-chain allowlist is the single feature most likely to get security to *ask for* the rollout.

**What they buy.** Guardrails Team → Enterprise (Logpush-to-SIEM, ZDR/BYOK)
→ Agent CI (fleet anomaly detection, scheduled compliance scans). Note
Gartner's "uniform governance fails" line: sell per-tool-class risk tiering
and per-repo policy as the differentiator vs. one-size platform toggles.

**Objections / what must be true before this ICP closes.**
- Real packaging (npm/binary, MDM-friendly) and central config — no git-clone at 300 seats.
- FP discipline with evidence: publish block-precision numbers (the receipts audit methodology, scaled) or dev revolt kills the rollout bottom-up.
- Vendor viability: solo-maintainer risk is the elephant; mitigations are source-available code, local-tier independence, and design-partner references. Expect this objection to gate Enterprise, not Team.
- Support expectations (SLAs) — genuinely P6–P7 territory; don't promise early.

**Channels.** Bottom-up: their staff engineers are ICP-1 users — instrument
the "N installs from one org domain" signal (opt-in telemetry) as the sales
trigger. Content: the managed-settings deployment recipe, the receipts
methodology, "what to put in your enterprise managed-settings.json" — publish
while the GA is news. Platform-eng communities (PlatformCon, DevEx Slacks).

---

## 5. ICP-4 — The drowning maintainer (the differentiated wedge, post-P5)

**Who.** Maintainers of high-traffic OSS (frameworks, popular libraries,
package ecosystems) — and critically, the **foundations and corporate
stewards** behind them (Linux Foundation projects, company-stewarded OSS),
because maintainers are cash-poor and the steward holds the budget. Secondary:
OSPOs at companies whose OSS repos take external agent PRs.

**Pain (now acute and public).** ~17M agent PRs/month, ~1 in 10 worth
reviewing; projects shutting down (Jazzband); CI budgets burning (2.1B
Actions-minutes/week); maintainer burnout as the story of 2026. The asymmetry
is structural: a PR costs its submitter nothing and the maintainer CI money
plus scarce human attention.

**Why Interlinked wins — nobody else has this shape.** The
`proof-of-enforcement.md` R1 design is refereed admission control: the
maintainer publishes a ruleset hash; the *submitter* runs the governed suite
locally via the free CLI (free to contributors who were doing the work
anyway); the maintainer's cloud referee spot-re-executes an unpredictable
O(k) sample and signs an attestation. Cost shifts left onto the submitter;
faking a receipt costs the same as honestly running the suite; slop dies
before human review. PR-review LLMs (CodeRabbit et al.) *reduce the cost of
reviewing* slop; refereed admission **prevents its arrival** — a different
and stronger claim, and the deterministic harness is the enabling property
competitors' LLM-judge architectures cannot copy. The named "someone else":
**the maintainer** (from the submitter's side) and **the contributor
community** (from the maintainer's side).

**What they buy.** Per-repo refereeing (the steward pays; submitters ride
free), priced against their visible CI burn. GitHub's own "kill switch"
deliberations are the sales-timing gift: admission control is the nuanced
alternative to closing the door.

**Strategic value beyond revenue: the flywheel.** Every contributor to a
refereed repo installs the free CLI to submit. One large framework adopting
"attach an `interlinked verify` receipt to your PR" seeds tens of thousands
of ICP-1 installs.

**Near-term prep (cheap, before the cloud referee exists):** ship the R0
deterministic receipt (`verify --receipt`: ruleset-hash + tree-bound,
reproducible, no keys) so OSS projects can *request* receipts in
CONTRIBUTING.md today. Zero cloud cost, starts the norm, validates demand.

**Risks.** OSS friction politics (any submission cost deters legit first-time
contributors — lead with "free if you meant it"; the deterrence-stack analysis
in the memo has the asymmetry answers); GitHub could ship a native crude
version (rate limits, provenance labels) — differentiate on *ran-your-actual-
suite* semantics, not identity checks.

---

## 6. ICP-5 — The evidence-hungry CISO (park until P7, design for now)

**Who.** CISO / AppSec director / Head of AI Governance at a regulated or
large org (fintech, health, 500+ eng) with a formal AI-governance program
(EU-AI-Act-driven or board-driven).

**Why they'll eventually buy.** They must answer "how do you control
autonomous agents?" with evidence. Deterministic no-model-in-the-decision-path
verdicts, receipts by construction, Logpush-to-SIEM, ZDR/BYOK, and the
local-first option (code never leaves) are precisely auditor-shaped. The named
"someone else": **the regulator/board.**

**Why park it.** Procurement, SLAs, support tiers, on-prem asks, and vendor-
viability scrutiny a solo founder can't yet survive — chasing these deals
early would consume the roadmap (§8 puts this at P7 deliberately). Also be
honest per the trust-boundary principle: **local checks are not a security
boundary against an adversarial agent**; the defensible enterprise security
claim arrives with the cloud-anchored tier and R1 attestation. Don't oversell
before then — this segment punishes overselling.

**Design-for-now obligations (all cheap):** keep receipt/attestation formats
SIEM/auditor-friendly (stable schemas, signed, replayable); keep the
determinism tags (`[proven]`/`[heuristic]`) rigorous; keep CLI/cloud
independence so "local-only pilot" is always possible.

---

## 7. Anti-ICPs — do not chase

| Segment | Why not |
|---|---|
| **Autocomplete-only orgs** (inline Copilot, no agentic tool use) | No tool-call surface to guard; no pain. Wait for them to adopt agents. |
| **Non-coding agent governance** (support bots, RPA, agent registries) | Arthur/Credo/Galileo's category. Name-collision inbound — route away fast. |
| **Windows-native shops** | Unsupported platform; say so loudly to save everyone time. |
| **Vibe-coder / no-code segment** | Can't run the install, won't pay, unbounded support load. |
| **Enterprise-first without bottom-up usage** | P7 problem; today it burns roadmap. Take the meeting, plant receipts, don't build to their RFP. |
| **JVM/.NET-primary orgs** (qualifier, not disqualifier) | Guard rules + supply-chain + reservations are language-agnostic, but the deepest content gates (tsc/biome overlay, coverage/mutation ratchets) are TS-first; Python/Rust partial. Sell what works; don't promise parity. |
| **Model-safety / eval buyers** | They want eval harnesses and red-teaming, not tool-call enforcement. Adjacent, not us. |

---

## 8. Feature → ICP matrix

| Capability (shipped unless noted) | ICP-1 fleet-runner | ICP-2 agent shop | ICP-3 platform lead | ICP-4 maintainer | ICP-5 CISO |
|---|---|---|---|---|---|
| Destructive-command guard + fail-closed cold fallback | ●●● | ●●● | ●●● | ○ | ●● |
| Content-quality gates (tsc/biome diff-overlay, TDD gate) | ●●● | ●●● | ●● | ●● | ○ |
| Ratchets: coverage / cyclomatic / CRAP / mutation | ●● | ●●● | ●● | ●●● | ○ |
| Supply-chain allowlist (fail-closed installs) | ●● | ●●● | ●●● | ● | ●●● |
| Reservations / multi-agent cohort | ●● | ●●● | ● | ○ | ○ |
| `/enforce` (docs → enforced rules, provenance) | ● | ●● | ●●● | ● | ●● |
| Activity log / receipts / attribution | ● | ●●● (client proof) | ●● (audit) | ●● | ●●● |
| Grep accel, statusline, viz (delight/retention) | ●●● | ● | ○ | ○ | ○ |
| Guardrails cloud: Cedar + signature DB + classifier (P2–3) | ○ | ●● | ●●● | ○ | ●● |
| Agent CI: mutation / integration / SBOM / fleet anomaly (P4–5) | ○ | ●●● | ●●● | ●● | ●●● |
| R0 receipt → R1 refereed attestation (post-P5) | ● | ●●● | ●● | ●●● | ●●● |
| Multiplayer control plane (future) | ○ | ●● | ●● | ○ | ● |

●●● core buying reason · ●● strong support · ● nice · ○ irrelevant

---

## 9. Sequencing (mapped to §8 phases) and conversion events

| Phase | Primary ICP | Conversion event | Success measure |
|---|---|---|---|
| P1 (now) | ICP-1 | Install → daily hook traffic | §8: 5K installs/8wks post-packaging; retention curve |
| P2–3 Guardrails | ICP-2 (5–10 design partners), sourced from ICP-1 | `install-hooks --cloud=guardrails` | p99 <800ms modify-class; partner-reported FP rate; first $ |
| P4–5 Agent CI | ICP-2 expansion + first ICP-3 logos | GitHub App install / first scheduled scan | <$0.50/run LLM review; signal quality >7/10 |
| Post-P5 | ICP-4 (one lighthouse framework) | CONTRIBUTING.md receipt requirement | Submitter CLI installs per refereed repo; maintainer CI-minutes saved |
| P6–7 | ICP-3 Enterprise, first ICP-5 | Managed-settings fleet deploy; SIEM Logpush enabled | ACV, expansion rate |

---

## 10. Implications — near-term actions this analysis argues for

1. **Packaging is the #1 ICP unlock** (npm + Homebrew + binary): every ICP
   past "clones repos for fun" is gated on it. Already the P1 plan; this doc
   just raises its priority relative to new checks.
2. **Publish the managed-settings deployment recipe now** — GitHub's GA is
   days old; "what to put in your enterprise managed-settings.json" content
   lands while platform teams are actively deciding. Same recipe for Claude
   Code managed settings.
3. **Ship the R0 receipt** (`verify --receipt`) ahead of any cloud referee —
   zero-cost seeding of the ICP-4 flywheel and the ICP-2 "governed delivery"
   report.
4. **Productize the receipts audit** (the 865-blocks methodology) as a
   repeatable per-prospect artifact — it is the qualification tool, the demo,
   and the FP-rate evidence in one.
5. **Design-partner script**: use the 5-point checklist (§3); require a named
   "someone else." Prospects without one are free-tier users — serve, don't
   sell.
6. **Positioning guardrail**: never market into the "AI agent governance"
   platform category; anchor on coding-agent runtime enforcement. Cite
   Gartner's uniform-governance-fails line *for* per-tool-class tiering.

---

## Sources (July 2026 market claims)

- Gartner via EnterpriseDNA — [enterprise AI coding agents ~$10B, 2026](https://enterprisedna.co/resources/news/gartner-enterprise-ai-coding-agents-10-billion-market-2026/)
- Gartner press — [uniform governance across AI agents will fail (2026-05-26)](https://www.gartner.com/en/newsroom/press-releases/2026-05-26-gartner-says-applying-uniform-governance-across-ai-agents-will-lead-to-enterprise-ai-agent-failure)
- Atlan — [AI agent risks & guardrails 2026 (92%/44% governance gap)](https://atlan.com/know/ai-agent-risks-guardrails/)
- GitHub Changelog — [enterprise managed-settings.json GA (2026-07-01)](https://github.blog/changelog/2026-07-01-enterprise-managed-settings-json-is-generally-available/), [bypass-permission controls (2026-06-17)](https://github.blog/changelog/2026-06-17-enterprise-managed-settings-now-support-bypass-permission-controls/), [enterprise-managed Copilot CLI plugins (2026-05-06)](https://github.blog/changelog/2026-05-06-enterprise-managed-plugins-in-github-copilot-cli-are-now-in-public-preview/), [Enterprise AI Controls / agent control plane GA (2026-02-26)](https://github.blog/changelog/2026-02-26-enterprise-ai-controls-agent-control-plane-now-generally-available/)
- The New Stack — [OSS maintainers drowning in AI PRs (17M/mo, 1-in-10 legit)](https://thenewstack.io/ai-generated-code-crisis/)
- danilchenko.dev — [GitHub's AI agent problem: 17M PRs, kill switch](https://www.danilchenko.dev/posts/2026-04-11-github-ai-agents-pull-requests/)
- The Register — [GitHub ponders PR kill switch (2026-02-03)](https://www.theregister.com/2026/02/03/github_kill_switch_pull_requests_ai/)
- General Analysis — [Claude Code enterprise security deployment guide](https://generalanalysis.com/guides/claude-code-enterprise-security-deployment)
