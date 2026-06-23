# Impeccable

- **Source:** https://github.com/pbakaus/impeccable (Apache-2.0, npm: `impeccable`) · site: impeccable.style
- **Encountered:** 2026-06-22, user-supplied GitHub link ("how could we use or adapt this?")
- **Verdict:** Compound. **SHIPPED 2026-06-22** — (1) native `checks/design-slop.ts` advisory family (9 ported pure-regex rules, zero dep, design-exts only); (2) `interlinked design [path]` subprocess command wrapping `impeccable detect --json` (the trivy/semgrep pattern — full 44 rules + cascade when `impeccable` is on PATH, degrades when absent); (3) cloud-roadmap entry for the browser engine recorded in `three-product-architecture.md` §4 Agent-CI check inventory. **REJECTED** — the denial loop-breaker pattern (user call: it would counteract `persistent_warning_escalation`, which we keep). **SKIP** — the 23 LLM design commands (different product) and importing the css-tree/htmlparser2/puppeteer engines into the one-dep CLI.

> This is the rare intake where the find is an **architectural twin** of our own harness in a domain we don't cover. The equivalence table is the heart of it: we already ship ~all of impeccable's *plumbing* (multi-provider hook, inline suppressions, shell-write extraction, projected-edit gating, subprocess-wrapping). The only novel things are the **44 design rules** and the **CSS/DOM engines** under them. So this is "borrow the rules + the domain," not "adopt the tool."

## 1. Core idea (one sentence, your words)
A deterministic detector of "AI-generated frontend slop" — overused fonts (Inter), purple/cyan gradients, side-tab accent borders, nested cards, bounce easing, gray-on-color, long line length, tiny touch targets — that parses HTML/CSS/JSX three ways (regex, static-HTML cascade, headless-browser computed styles), wired as a multi-provider agent hook (Cursor blocks pre-write; Claude/Codex/Copilot annotate post-write) and a standalone CLI, sitting underneath 23 LLM-driven design-authoring commands (`polish`, `critique`, `bolder`…).

## 2. Anatomy (concrete walkthrough)
It installs as one skill (`/impeccable <cmd> <target>`) across 11 agent harnesses; the deterministic core lives in `.agents/skills/impeccable/scripts/`:

```
detector/
  registry/antipatterns.mjs   44-rule catalog: {id, category(slop|quality), severity, name, description, gated?}
  rules/checks.mjs            2.6k-line per-rule check bodies (element/page/layout analyzers)
  engines/
    regex/detect-text.mjs     structured matchers {id, regex, test, fmt} — CSS + Tailwind-class + JSX-style aware
    static-html/css-cascade.mjs  1k-line cascade resolver (specificity, inheritance) over htmlparser2 + css-tree
    static-html/detect-html.mjs  parse → resolve computed-ish styles → run element/page rules
    browser/detect-url.mjs    puppeteer: render the page, read REAL computed styles + layout geometry
  cli/main.mjs                `impeccable detect <dir|file|url> [--json] [--no-config] [--gpt|--gemini]`
  node/file-system.mjs        walkDir, import-graph, framework/dev-server detection (the lone fetch = localhost port probe)
design-system.mjs / lib/design-parser.mjs  parse DESIGN.md → allowed palette/fonts/radii → drift checks
hook-before-edit.mjs (476L)   Cursor preToolUse WRITE GATE; hook.mjs = post-edit context for Claude/Codex/Copilot
hook-lib.mjs (1.6k)           shared: config, cache, templating, filterFindings, loadDetector
```

Load-bearing reads:
- **`hook-before-edit.mjs`** — the Cursor pre-write gate. It reconstructs the *projected* file content (applies `old_string`/`new_string` edits onto the on-disk file; also extracts content from `cp`, heredocs, `python … .write_text(...)`, `tee`, shell redirects), runs `detector.detectText(projected, …)`, and **denies the write** if any finding survives `filterFindings`. Skips sensitive/generated paths, gates on `ALLOWED_EXTS`, fails *open* on any error ("never break a turn accidentally"). This is line-for-line the same shape as our `manifest-edit-guard` / `large-file-policy` PreToolUse delta gates.
- **`detector/engines/regex/detect-text.mjs`** — the most portable engine. `REGEX_MATCHERS = [{ id, regex, test, fmt }]` with FP-guards baked in: `isSafeElement` (skip blockquote/nav/pre/code), `isNeutralBorderColor` (a gray/silver border isn't an "accent stripe"), `stripHtmlToText`. Recognizes `border-l-4` (Tailwind) *and* `border-left: 4px solid` (CSS) *and* `borderLeft: "4px solid"` (JSX). Structurally identical to our `checks/<family>.ts` inline detectors.
- **`detector/registry/antipatterns.mjs`** — the 44-rule catalog as pure data; `gated: 'gpt'|'gemini'` tags hold provider-specific tells off-by-default behind `--gpt`/`--gemini`.
- **`hook-before-edit.mjs::bumpCursorDenial`** — a **loop-breaker**: after `EDIT_COUNT_THRESHOLD` repeated *identical* denials (same finding signature, same file) in a session, it **downgrades the block to an allow-with-warning** so the agent isn't trapped. (Notable: the *opposite* of our `persistent_warning_escalation`.)

End-to-end: agent edits `Hero.tsx` → Cursor preToolUse fires `hook-before-edit.mjs` → projects the edit → `detectText` finds `font-family: Inter` + a purple→cyan gradient → write **denied** with a rendered message naming the rules; on a 3rd identical denial it allows-with-warning. On Claude/Codex the same detector runs post-write and the findings land as context. The CLI path (`npx impeccable detect src/ --json`) runs the same engines with no agent, no LLM, no API key.

## 3. Deterministic or agentic?
**Hybrid with a sharp, source-confirmed seam.** README claims "44 deterministic detector rules **plus LLM-only critique checks**" — and the source backs it. `grep -riE 'openai|anthropic|claude|fetch\(|api[_-]?key|inference|gpt-|generateText'` over `detector/` returns **nothing load-bearing**: the `claude-`/`cic-` hits are DOM-id skips (ignore agent-injected elements), `--gpt`/`--gemini` *gate deterministic rules* (they don't call those models), and the single `fetch` is a `http://localhost:${port}/` dev-server probe. The three engines are pure: regex matching, css-tree/htmlparser2 cascade resolution, and puppeteer reading the browser's own computed styles. The **23 commands** (`polish`/`critique`/`bolder`/…) are the agentic surface — markdown prompt-packs the host LLM executes; no model in the *detector*. **License Apache-2.0** → port/borrow is legally clean (attribute).

## 3b. Role in its native architecture — and does it transfer?
Native roles: the detector is the **boundary** on Cursor (denies bad writes pre-disk) and an **advisor** on Claude/Codex/Copilot (post-edit context); the CLI is an **oracle / CI gate** (`detect --json`, exit codes); the 23 commands are an **authoring assistant**.
- The detector's **boundary/advisor role transfers perfectly** — it is *literally the role our harness already plays*, just in a new domain. Deterministic + tighten-only (taste advisory), so it needs no sandbox backstop; safe to run on the per-edit path.
- The **browser engine's rendered-DOM oracle role** transfers only to a heavier surface: puppeteer-rendering a page blows the per-edit compute budget (INTAKE §44–48), so it routes to a manual `audit` command or the cloud tier, not the PreToolUse hook.
- The **authoring-assistant role does NOT transfer.** interlinked is a *governance* harness, not a design-authoring skill; the 23 commands are a different product (closer to Anthropic's `frontend-design` skill, which impeccable forked).

## 4. Substrate vs. surface
- **Substrate:** (a) the 44-rule **antipattern catalog** (data); (b) the **regex engine** (pure JS, zero dep); (c) the **static-HTML cascade engine** (needs css-tree/htmlparser2/css-select/domutils); (d) the **browser engine** (needs puppeteer); (e) **DESIGN.md → design-token drift** parsing.
- **Surface:** the `/impeccable` skill + 23 commands, the multi-provider installer, the `impeccable detect` CLI, the browser extension.
- (a)+(b) are borrowable as **ported code** (same language, no dep). (c)+(d) are borrowable only as **invoke-as-subprocess** (`npx impeccable detect`) or as cloud steps — importing them violates the one-dep stance.

## 5. Lane (1–6)
**Lane 2 (detection technique)** for the ported regex rules + **Lane 3 (substrate, *invoke-as-subprocess*)** for the full detector, with a **Lane 4** carve-out (the denial loop-breaker *pattern*) and a **Lane 5** carve-out (browser-rendered checks → cloud by compute budget, not by agenticness). The 23 commands are **Lane 6 / skip** for us.

## 6. Dependency & displacement
- **Deps:** Pure-regex rules port with **zero new dep** (plain JS regex → our `checks/`). The cascade engine would add **4 deps** (css-tree, htmlparser2, css-select, domutils) and the browser engine **puppeteer** — both rejected as imports; reach them via `npx impeccable detect` subprocess (no dep, optional-on-PATH, exactly like `semgrep`/`gitleaks`/`hadolint` in `check-engine/tool-catalog.ts`).
- **Displacement (internal overlap):** impeccable is a *sibling harness* — it overlaps our **plumbing** heavily but our **checks** not at all. We already ship its hook machinery (see equivalence); the non-overlapping win is the entire **design/CSS/UI domain**, which is **absent** from our ~120 check families (verified: `grep -liE 'font-family|gradient|contrast|design.?system|antipattern|line-?length|touch.?target' src/harness/checks/` → only an unrelated test file).
- **Equivalence (capability → our equivalent → status):**

  | Impeccable capability | Our equivalent | Status |
  |---|---|---|
  | Design/CSS/UI antipattern detection (44 rules) | — | **absent** ← the find |
  | CSS cascade resolution (specificity/inheritance) | — | **absent** |
  | Rendered-DOM computed-style checks (contrast, overflow, touch target) | — | **absent** |
  | DESIGN.md design-token drift (font/color/radius) | `registry-parity.ts` (paired-registry drift) | **partial cousin — not token-aware** |
  | Multi-provider hook install (Claude/Cursor/Codex/Copilot/Gemini/…) | `hooks.ts` + `hook-installers.ts` (Claude/Copilot/Gemini/Codex) | **shipped** (impeccable adds Pi/Kiro/Trae/Rovo/Qoder/OpenCode breadth) |
  | PreToolUse write-gate projecting old/new_string onto file | `manifest-edit-guard`, `large-file-policy`, `baseline-integrity-gate` | **shipped** |
  | Shell-write content extraction (heredoc/python/tee/cp/redirect) | heredoc-data-sink / inline-exec (DCG adoption) | **shipped** |
  | Inline suppression directives (`<!-- impeccable-disable id: reason -->`) | `suppressions.ts` (`@ts-ignore`/`biome-ignore` + justification) | **shipped** |
  | Config ignores (ignoreRules/ignoreFiles/ignoreValues) | `.interlinked/` config + `disabled_rules` + ignore globs | **shipped** |
  | Per-session denial cache | `session-state.ts` trajectory cache | **shipped** |
  | Repeated-denial handling | `persistent_warning_escalation` — **escalates** (loud) | **shipped, OPPOSITE policy** (impeccable de-escalates to break loops) |
  | NDJSON audit log per hook invocation | `activity.jsonl` + guard-event logging | **shipped** |
  | External deterministic scanner as subprocess | `tool-catalog.ts` (tsc/biome/semgrep/gitleaks/lizard/…) | **shipped — adding `impeccable detect` is one more row** |
  | LLM design-authoring commands (polish/critique/…) | `/enforce` distills rules; no authoring skill | **different product — skip** |

  Read top-to-bottom: **we own the plumbing; impeccable owns the design domain.** Don't rebuild the hook — borrow the rules.

## 7. Smallest spike (≤1 day)
A native `src/harness/checks/design-slop.ts` family seeded from `detector/engines/regex/detect-text.mjs` + `registry/antipatterns.mjs`:
1. Port ~8–12 **pure-regex** rules that need no cascade/DOM: `overused-font`, `single-font`, `side-tab`/`border-accent-on-rounded`, `gradient-text`, `ai-color-palette`, `cream-palette`, `bounce-easing`, `dark-glow`, `em-dash-overuse`, `marketing-buzzword`, `oversized-h1`, plus `broken-image` (empty/placeholder `src`).
2. Bring the FP-guards across verbatim (`isSafeElement`, `isNeutralBorderColor`) — they are why these stay low-noise.
3. Gate the family on design exts (`.html/.htm/.astro/.vue/.svelte/.jsx/.tsx/.css`) the way the rest of the registry does language detection.
4. Register in `check-registry/entries-warnings.ts` + `check-metadata.ts`; **advisory** for taste rules (`feedback_taste_enforcement` — these are taste levers; → `DEFAULT_ADVISORY_SKIPS`), **default-gate** only for `broken-image` (a real bug, near-zero FP).
5. Ship ≥3 positive + ≥3 negative cases per rule (check-authoring convention). Attribute Apache-2.0 source.

Bigger-than-spike (→ next, not the ≤1-day): the `impeccable detect --json` tool-catalog entry (gets all 44 + cascade for free, but needs the runner + parser + presence-gate).

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|---|---|---|---|
| Free CLI (P1) | (a) native `design-slop.ts` regex rules on the per-edit path (advisory taste-levers) — §7; (b) `npx impeccable detect --json` as an optional `verify --all-checks` tool (all 44 rules + CSS cascade, presence-gated, off the hook path, zero dep — the trivy/semgrep pattern) | §7 (~½ day) + tool-catalog wiring (~½ day) | **now** |
| Guardrails (P2–3) | DESIGN.md design-token drift (font/color/radius outside the declared palette) as a sub-second deterministic gate — closest thing to a *blocking* design check; the rendered checks aren't natural sub-second blockers | port `design-system.mjs` token-parse + a drift detector | **parked** |
| Agent CI (P4–5) | the **browser engine** — render a deployed preview and read real computed styles for contrast / layout-overflow / touch-target (the high-fidelity checks the static engines can't do) in the async deep-review fan-out. Cloudflare primitive: **Browser Rendering** (`@cloudflare/puppeteer`) — impeccable's puppeteer path maps onto it directly — or the binary in a **Cloudflare Sandbox** | run `impeccable detect <preview-url>` under Browser Rendering, parse JSON | **next** |

## 9. Artifact
**Compound — status 2026-06-22:**
- **SHIPPED — `checks/design-slop.ts`** (the marquee): 9 ported pure-regex rules (overused-font, side-tab, gradient-text, ai-color-palette, bounce-easing, gray-on-color, broken-image, em-dash-overuse, marketing-buzzword) plus impeccable's FP-guards (`isSafeElement`, `isNeutralBorderColor`, `stripHtmlToText`), advisory, design-exts only, 45 tests. Registered as `design_slop` (PostToolUse live + `verify --all-checks`). Carries our two-step workflow (`feedback_generalize_across_codebases`): a new check class generalized from an external corpus.
- **SHIPPED — `interlinked design [path]`** subprocess command (`commands/design.ts`, 20 tests): the full 44 rules + cascade via `impeccable detect --json` when `impeccable` is on PATH; degrades loudly when absent, pointing at the native `design_slop` subset.
- **SHIPPED (doc) — cloud-roadmap entry:** rendered-DOM design audit via Cloudflare Browser Rendering recorded in `three-product-architecture.md` §4 Agent-CI check inventory.
- **REJECTED — the denial loop-breaker.** Considered as a lane-4 pattern (cap N identical denials → downgrade block→warn to avoid trapping the agent). User call: it would counteract `persistent_warning_escalation`, our deliberate escalate-on-repeat policy — so we keep escalation. The per-finding-attribution refinement to escalation (`project_escalation_amplifies_stable_fp`) stands on its own, independent of impeccable's opposite (de-escalation) choice.
- **Skip:** importing css-tree/htmlparser2/puppeteer; the 23 LLM commands; the browser extension.

## Notes
- **Convergent-evolution validation.** impeccable independently arrived at our exact architecture — multi-provider hook, inline-disable suppressions, projected-edit pre-write gating, shell-write extraction across heredoc/python/tee/cp, per-session cache, fail-open contract, NDJSON audit. Two teams landing on the same design from scratch is strong evidence the architecture is right — and a strong reason **not to rebuild any of it**, only to borrow the rules.
- **Why this isn't a trivy-style "wrap only" verdict.** trivy/grype are Go → un-importable, so the only options were subprocess/data-borrow. impeccable is **JS + Apache-2.0**, so the language gate is *open*: porting the regex rules natively (zero dep, per-edit, pre-disk-blockable) is on the table and is the higher-value slice. The dep gate is then **per-engine** (regex = free; cascade = +4; browser = +puppeteer), which is what splits the rules from the engines.
- **Taste, not correctness — keep it advisory.** Most rules are aesthetic (`feedback_taste_enforcement` says taste levers are wanted, but they belong in the advisory tier, not the blocking gate). Only `broken-image` is a hard bug. Don't let design slop block a turn by default — that's exactly the noise class our advisory tier exists for.
- **The detector ships with its own FP corpus.** `isNeutralBorderColor`, `isSafeElement`, `stripHtmlToText`, the `--gpt`/`--gemini` gating, and `severity: 'advisory'` on the riskier rules are the same FP-discipline our 69-case guard corpus enforces — port the guards, not just the regexes, or the rules will be noisy.
- Related intakes: `trivy.md` / `grype-syft.md` (external-deterministic-scanner-as-subprocess, the §8 P1(b) pattern), `sondera-coding-agent-hooks.md` (sibling agent-hook harness), `deintroverter.md` (another ported-rule-from-the-wild precedent).

## Methodology notes (optional)
- First intake where the find is a **same-language sibling harness**. The trivy methodology note flagged "language mismatch is a sharper gate than dep-count"; this is the inverse case — same language ⇒ the dep gate goes *per-engine*, and the decisive split becomes "which engines are dep-free" rather than "import vs subprocess" wholesale. Worth a one-line INTAKE.md §52 addendum if it recurs: when a find is in our language, run §6's dep filter *per-capability*, not once for the whole tool.
