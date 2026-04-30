# External-Pulse Intake

When you encounter a tool, paper, framework, or repo and want to evaluate it for adoption into the interlinked CLI or the paid-product roadmap (guardrails-cloud, agency-cloud), copy the template below into `docs/external-pulse/<slug>.md` and fill it in **before** asking an AI agent "what should we do with X?"

The template forces categorization first. Without it, "what can we do with X?" is undertyped — there's no taxonomy to land in, so the AI gives whatever's associatively nearby and produces shallow integration suggestions. Naming the lane first changes the conversation.

## The six lanes

Every external project resolves to one of these:

| Lane | Definition | Where it lands |
|------|------------|----------------|
| 1. Imperative content | AGENTS.md, style guides, security checklists, hard-imperative SKILL.md, `.clinerules/`, GEMINI.md | `/enforce` → `.interlinked/distilled-rules.json` |
| 2. Detection technique | A specific regex / AST query / taint pattern / structural rule | New entry in `generic-checks.ts` or `structural-checks.ts` |
| 3. Substrate | A reusable capability — parser, graph algorithm, index, embedding, ranker | Improvement to `project-graph.ts` / `trigram-index.ts` / etc. |
| 4. Pattern / architecture | A design idea, not code (Sondera escalate, Supermodel writing-vs-modifying regime) | Memory entry; later RFC if still load-bearing |
| 5. Cloud-only fodder | Inherently agentic / centralized / LLM-as-judge | guardrails-cloud or agency-cloud roadmap, **not** the CLI |
| 6. Skip | Interesting but doesn't fit | One-line memory note at most; otherwise drop |

## The dominant filter: determinism

Per `feedback_harness_deterministic_only.md`, the CLI harness cannot host LLM-as-judge work. Anything whose value depends on model inference auto-routes to lane 5, not the CLI. This is **routing, not rejection** — lane-5 finds are exactly what justifies the paid roadmap. Treating "doesn't fit the CLI" as bad news collapses the framework; treat it as a positive signal toward guardrails-cloud or agency-cloud.

Read the source, not the README. Marketing language ("dynamic programming-inspired", "algorithmic", "deterministic pipeline") often hides LLM calls at the leaves. The CodeWiki worked example in this directory walks through one such case.

## Template

Copy everything between the fences into `docs/external-pulse/<slug>.md`. Aim for one page filled in. If you can't answer #1 in your own words, you don't understand the project well enough to evaluate it — read more first.

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

For a prose source (blog post, paper, thread): the 3–5 load-bearing claims or
findings in your own words. Skip Sections 3 and 4 below if they don't apply.>

## 3. Deterministic or agentic?
<deterministic / agentic / hybrid / N/A. If hybrid, name which parts are which. Read
the source if needed — marketing language can hide LLM calls inside DP-shaped or
"algorithmic" framings. **Also note license here** — flag if the license is more
restrictive than MIT/Apache (FSL/BUSL/AGPL/custom). License only blocks lanes 3
(code-borrow) and 5 (paid reuse); patterns and invoke-as-subprocess are always fine.>

## 4. Substrate vs. surface
<What's the underlying capability vs. the user-facing application? Could the
substrate be borrowed (or invoked) without the surface? N/A for prose sources.>

## 5. Lane (1–6)
<Pick one (or two with a justification). Lane values stay 1–6: imperative content
(→ /enforce), detection technique (→ harness check), substrate (→ CLI internals),
pattern (→ memory + RFC), cloud-only fodder (→ guardrails-cloud / agency-cloud),
or skip.>

## 6. Smallest spike
<≤1 day of work. What would you build to test viability? If "smallest spike" is
more than 1 day, the project is too big to adopt directly — write an RFC instead,
or skip.>

## 7. Artifact
<PR | RFC | memory note | cloud-roadmap entry | skip>

## 8. Surface
<interlinked-cli | guardrails-cloud | agency-cloud | none>

## Notes
<Anything else worth recording — quotes from the README, surprising findings,
things to verify later, links to related work already in `docs/external-pulse/`.>

## Methodology notes (optional)
<Anything the rubric itself didn't capture cleanly. Patterns to fold into a future
INTAKE.md edit if they recur.>
````

## Output discipline

- One file per project, kebab-case slug: `codewiki.md`, `cline-rules.md`, `cursor-tab-prediction.md`.
- Commit it. The corpus matters; you'll re-grep this in six months.
- If your understanding changes after talking to an AI or reading more, **update the file** in place — don't re-evaluate from scratch and don't open a second file for the same project.
- Resist scope creep. The rubric is intentionally short. Don't add "competitive analysis" or "market positioning" sections — those go elsewhere.
- A "skip" verdict is a valid output. Recording why something *doesn't* fit is as useful as recording why something does, and it prevents re-evaluating the same project in three months.

## When to skip the rubric

Use it for things you'd otherwise paste-and-ask Claude to "improve" the CLI with. For drive-by curiosity ("oh that's neat") just don't open the template. The cost of an empty `external-pulse/` entry is real — only fill one in if you'd otherwise burn 30 minutes of agent time speculating.
