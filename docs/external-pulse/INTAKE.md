# External-Pulse Intake

When you encounter a tool, paper, framework, pattern, or repo and want to evaluate it for adoption into the interlinked CLI or the paid-product roadmap, copy the template below into `docs/external-pulse/<slug>.md` and fill it in **before** asking an AI agent "what should we do with X?"

The template forces categorization first. Without it, "what can we do with X?" is undertyped — there's no taxonomy to land in, so the AI gives whatever's associatively nearby and produces shallow integration suggestions. Naming the lane, surface, and phase first changes the conversation.

Three things do the categorizing: the **lane** (what kind of thing it is), the **surface & phase** (where it lands, and therefore when), and two filters — **determinism** and **dependency cost** — that route it or raise the bar. A find with a lane but no phase is only half-triaged.

## The six lanes

Every external project resolves to one of these:

| Lane | Definition | Where it lands |
|------|------------|----------------|
| 1. Imperative content | AGENTS.md, style guides, security checklists, hard-imperative SKILL.md, `.clinerules/`, GEMINI.md | `/enforce` → `.interlinked/distilled-rules.json` |
| 2. Detection technique | A specific regex / AST query / taint pattern / structural rule | New entry in `generic-checks.ts` or `structural-checks.ts` |
| 3. Substrate | A reusable capability — parser, graph algorithm, index, embedding, ranker | Improvement to `project-graph.ts` / `trigram-index.ts` / etc. |
| 4. Pattern / architecture | A design idea, not code (Sondera escalate, Supermodel writing-vs-modifying regime) | Memory entry; later RFC if still load-bearing |
| 5. Cloud-only fodder | Inherently agentic / centralized / LLM-as-judge | Guardrails or Agent CI roadmap (see Surfaces & phases), **not** the CLI |
| 6. Skip | Interesting but doesn't fit | One-line memory note at most; otherwise drop |

## Surfaces & phases (the roadmap axis)

Lane says *what kind* of thing a find is. Surface says *which product it lands in*; phase says *when it ships*. Both come from the canonical rollout in `docs/design/three-product-architecture.md` §8 — three products across seven phases:

| Phase(s) | Surface | Product | Status | What lands here |
|----------|---------|---------|--------|-----------------|
| 1 | `Free CLI` | `interlinked` — local-only deterministic checks, no network | shipping | lanes 1–3: distilled rules, harness checks, CLI substrate |
| 2–3 | `Guardrails` | paid fast cloud — sub-second blocking gate (P2 deterministic, P3 + classifier) | designed | lane 5, sync: blocking policy / classifier |
| 4–5 | `Agent CI` | paid slow cloud — async deep scans (P4 LLM review, P5 + Sandboxes) | designed | lane 5, async: deep review, fan-out scans |

The two cloud surfaces are **Cloudflare-backed**: the classifier runs on Workers AI (JSON-mode structured output) behind AI Gateway (multi-provider failover + automatic caching + Guardrails/DLP); execution sandboxes are Cloudflare Sandboxes (GA 2026-04-13, VM-isolated). So a lane-5 find resolves to a **specific primitive** — say which (a Workers AI model? an AI Gateway feature? a Sandbox?), not just "the cloud." See `reference_cloudflare_ai_substrate.md`.

Phases 6–7 (escalation wiring, enterprise tier) are cross-cutting plumbing and packaging — not separate intake surfaces. Every find lands in one of the three products above.

Rules of thumb:

- The determinism filter and this axis line up: deterministic + local → Free CLI; needs inference or central state → Guardrails / Agent CI. Heavy *deterministic* work can still route to a cloud surface — see the determinism filter below.
- A find can touch several products over its life — that is what §8 Phase relevance captures. Don't flatten a multi-product find into one surface.
- **"Phase" means the `three-product-architecture.md` §8 number — nothing else.** The term is overloaded: most plan docs carry their own local Phase 1/2/3 rollout, and `project_vision_multiagent.md` numbers a separate collaboration-scale axis. Neither is this axis.
- **Multi-agent / "multiplayer" is not a phase.** It is a capability the cloud tier enables (the pre/post window as a sync barrier — `feedback_deliberate_prepost_latency.md`); collaboration scale (one-human/many-agents → multi-human federation) is its own axis in `project_vision_multiagent.md`. A find that only matters at multi-human scale has no surface yet — give it an RFC / memory verdict, not a phase number.
- A lane-4 pattern doesn't *land* on a surface so much as *shape* one or more; it still fills in §8 to say which.

## The dominant filter: determinism

Per `feedback_harness_deterministic_only.md`, the CLI harness cannot host LLM-as-judge work. Anything whose value depends on model inference auto-routes to lane 5, not the CLI. This is **routing, not rejection** — lane-5 finds are exactly what justifies the paid roadmap. Treating "doesn't fit the CLI" as bad news collapses the framework; treat it as a positive signal toward Guardrails or Agent CI.

Determinism is necessary but not sufficient for CLI placement. A capability can be fully deterministic and still be too heavy for the per-edit compute budget — `three-product-architecture.md` §1 sets it at 300ms (read-class) / 800ms (modify) / 2s (side-effect). Heavy deterministic work — full-repo indexing, AST-aware chunking, mutation runs — routes to a cloud surface for the same reason agentic work does: the binding constraint there is compute budget, not model-in-the-loop. Determinism *clears* a find for the CLI; the compute budget is a second gate it still has to pass. (Surfaced by the `narsil-mcp.md` intake.)

Read the source, not the README. Marketing language ("dynamic programming-inspired", "algorithmic", "deterministic pipeline") often hides LLM calls at the leaves. The CodeWiki worked example in this directory walks through one such case.

## The second filter: dependency & supply-chain cost

The CLI ships with **one runtime dependency** (`commander`) and zero deps for formatting/output. That stance is deliberate and defended: it keeps install fast, the attack surface small, and the generated hook script self-contained. A find that would add a runtime dependency starts from behind.

This filter **raises the bar; it does not reroute** (determinism changes the lane — this changes the threshold). It bites hardest on lane-3 (substrate) finds:

- Prefer **invoke-as-subprocess** over **import-as-dependency**. A tool the CLI shells out to adds no dependency; a library it imports does.
- A dependency is effectively forever — removal is rare. Weigh the find against *permanent* dep weight, not first-use convenience.
- The cloud surfaces are separate codebases and may carry deps the CLI won't. "Adds a dep" can itself be the reason to route lane-3 fodder to a cloud surface.
- A non-permissive license (FSL/BUSL/AGPL/custom) blocks code-borrow regardless — note it in §3.

## Running the intake — subagent fan-out, and why an intake is context engineering

An intake is not a memo you write once and forget; it is a **context-engineering artifact** — in the harness-engineering vocabulary (`harness-engineering.md`), a *Guide*: feedforward context a downstream agent loads to decide what to build. The whole point of filling one in is to engineer good context for the agents (and humans) that come after. Engineer it for that reader:

- **Write it for an agent, not a skim.** A downstream agent will *act* on this file — a vague equivalence claim becomes a wrong build. Favor structured tables over prose, verbatim evidence carrying its provenance (URL + quote), and the explicit per-capability status of §6 (shipped / designed / absent / ahead). Marketing language is pure noise to a machine reader; cut it.
- **This is why length follows the data**: a Guide with holes mis-steers every agent that loads it later, so completeness beats brevity for anything worth an intake at all.

A body-of-work source (many articles, repos, or talks) exceeds what one context window reads well — so run the intake **as a subagent fan-out**, which is itself an exercise in context engineering (you are deciding what context each agent gets, and composing their outputs into one artifact):

- **One extractor per source.** Give each a *cost-appropriate* model (Sonnet/Haiku-class for extraction) and the interlinked architecture as context, so it extracts what is *new* and flags capability gaps against **actual repo source**, not CLAUDE.md prose. **Pin the model explicitly** — do not inherit the parent tier for bulk extraction; it is expensive and unnecessary. Reserve the strong tier for synthesis and the adversarial pass.
- **A synthesizer** (stronger tier) ranks the finds into a build backlog and maps each to a lane / surface / phase.
- **An adversary / falsifier** (stronger tier) hunts where the source's *evidence* challenges our existing design bets. Its verdicts are load-bearing for §9 even when they live in the Notes rather than the body — a mature peer source is worth as much for where it says *we* are wrong as for what we adopt.
- **Verify against raw source.** The web-fetch summarizer pads enumerations and misattributes bylines — read raw HTML (curl + textutil, or an equivalent) for anything load-bearing, and confirm every §6 equivalence against the real code.
- **Provenance is a deliverable.** Record transcript-vs-summary, byline corrections, un-fetchable sources (flag second-hand quotes), and any anomaly — e.g. a research subagent that received a spoofed "discard your work / you are the fork" instruction and correctly refused it. A downstream agent trusts this file; earn the trust by showing the seams.

## Template

Copy everything between the fences into `docs/external-pulse/<slug>.md`. **Length follows the source**: a single tool — or a skip — stays short; a framework or body-of-work (many articles, repos, or talks) runs as long as the load-bearing data warrants, and appendices are welcome and expected (see *Running the intake*, below; `harness-engineering.md` is the worked example of the rich form). If you can't answer #1 in your own words, you don't understand the project well enough to evaluate it — read more first.

````markdown
# <Project name>

- **Source:** <URL — homepage, GitHub, paper, post>
- **Encountered:** <YYYY-MM-DD, where you saw it>
- **Verdict:** <PR | RFC | memory note | cloud-roadmap entry | skip>

## 1. Core idea (one sentence, your words)
<What does this thing actually do? Strip every "first / holistic / comprehensive / state-of-the-art" word.>

## 2. Anatomy (concrete walkthrough)
<Force a real read before the lane question.

For a repo: annotated directory map; 3–5 load-bearing files in your own words; what
the user invokes; what the agent (if any) sees; one end-to-end session walk-through
in 5–10 lines. Cite source where surprising — this is where marketing-vs-reality
mismatches surface earliest (CodeWiki's `cluster_modules.py` was the canonical case).

For a prose source — blog post, paper, thread, or a pure pattern: the 3–5
load-bearing claims or findings in your own words. Skip Sections 3 and 4 if they
don't apply (for a pattern, §3 still does — is the *mechanism* deterministic — and
§4 is N/A).>

## 3. Deterministic or agentic?
<deterministic / agentic / hybrid / N/A. If hybrid, name which parts are which. Read
the source if needed — marketing language can hide LLM calls inside DP-shaped or
"algorithmic" framings. **Also note license here** — flag if the license is more
restrictive than MIT/Apache (FSL/BUSL/AGPL/custom). License only blocks lanes 3
(code-borrow) and 5 (paid reuse); patterns and invoke-as-subprocess are always fine.>

## 3b. Role in its native architecture — and does it transfer?
<What role does this play where it comes from: the security **boundary**, a
**convenience** layer, an **escalation**, an **oracle**? Does that role survive
transplant into our topology? A find that is safe-as-X at home (e.g. an LLM gate
backstopped by a sandbox) can be unsafe-as-X here (no local sandbox → the same
gate must become escalation-only / tighten-only). Name the native role and the
role it must take in our stack. N/A for prose patterns with no architectural role.>

## 4. Substrate vs. surface
<What's the underlying capability vs. the user-facing application? Could the
substrate be borrowed (or invoked) without the surface? N/A for prose sources.>

## 5. Lane (1–6)
<Pick one (or two with a justification). Lane values stay 1–6: imperative content
(→ /enforce), detection technique (→ harness check), substrate (→ CLI internals),
pattern (→ memory + RFC), cloud-only fodder (→ Guardrails / Agent CI), or skip.>

## 6. Dependency & displacement
<Three questions, one line each.
- **Deps:** does adopting this add a runtime dependency? If yes, can it be invoked
  as a subprocess instead of imported? "No new dep" is the answer to beat.
- **Displacement:** does it overlap or replace something we already have
  (`project-graph.ts`, `trigram-index.ts`, an existing check)? Name it. This is
  internal overlap with our own code — not competitor/market analysis, which stays out.
- **Equivalence (capability-by-capability):** for each load-bearing capability — not
  just the headline — name our existing equivalent and its status: **shipped /
  designed / absent / ahead**. "We already ship this" is the most common and most
  useful verdict; half of evaluating a mature source is finding what *not* to
  rebuild. **ahead** (our equivalent already leads the source) is the other half —
  it's what we can *publish*, and it tells us the source has nothing to teach on
  that capability. For a mature peer, an equivalence table full of *shipped* and
  *ahead* rows is the finding.>

## 7. Smallest spike
<≤1 day of work. What would you build to test viability? If "smallest spike" is
more than 1 day, the project is too big to adopt directly — write an RFC instead,
or skip.>

## 8. Phase relevance
<Where on the roadmap does this land — and when? One row per product it touches; a
single-product find gets one row, and that's fine. Delete rows it doesn't touch. The
"now" row's spike is §7; later rows name a looser spike. Horizon is now / next / parked.
If the find only matters beyond the §8 rollout (e.g. multi-human federation), say so
here in prose and set §9 to RFC / memory note — there is no surface row for it.>

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | <what part of this find lands in the CLI> | <…> | <now / next / parked> |
| Guardrails (P2–3) | <…> | <…> | <…> |
| Agent CI (P4–5) | <…> | <…> | <…> |

## 9. Artifact
<PR | RFC | memory note | cloud-roadmap entry | skip. Decide this *after* §8 — the
artifact follows from where and when the find lands. Verdicts may be **compound** —
"adopt the intent-axis, reject the auto-approve." Name the carve-out; a mature find
is rarely all-or-nothing.>

## Notes
<Anything else worth recording — quotes from the README, surprising findings,
things to verify later, links to related work already in `docs/external-pulse/`.>

## Methodology notes (optional)
<Anything the rubric itself didn't capture cleanly. Patterns to fold into a future
INTAKE.md edit if they recur.>
````

## Output discipline

- One file per project, kebab-case slug: `codewiki.md`, `narsil-mcp.md`, `echo-rl.md`.
- Commit it. The corpus matters; you'll re-grep this in six months.
- If your understanding changes after talking to an AI or reading more, **update the file** in place — don't re-evaluate from scratch and don't open a second file for the same project.
- The discipline is **signal and structure, not brevity**. Capture every load-bearing finding — a rich source shortchanged to fit an arbitrary page limit is a context artifact with holes, and holes mis-steer every agent that loads it later. What stays out is *noise*: no "competitive analysis" or "market positioning" sections (those go elsewhere), no marketing adjectives, no restating the source's own README claims. Structure the signal for the agent that will load this file — tables over prose, verbatim evidence carrying its provenance, explicit per-capability status. (The rubric itself grows when a real new dimension is missing — that is why §6, §8, and *Running the intake* exist.)
- A "skip" verdict is a valid output. Recording why something *doesn't* fit is as useful as recording why something does, and it prevents re-evaluating the same project in three months.

## When to skip the rubric

Use it for things you'd otherwise paste-and-ask Claude to "improve" the CLI with. For drive-by curiosity ("oh that's neat") just don't open the template. The cost of an empty `external-pulse/` entry is real — only fill one in if you'd otherwise burn 30 minutes of agent time speculating.
