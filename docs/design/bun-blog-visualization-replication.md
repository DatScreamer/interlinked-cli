# Bun Blog Visualization Replication Plan

**Status:** Research and implementation plan, created 2026-07-09.

**Sources inspected:**

- Primary page: <https://bun.com/blog/bun-in-rust>
- Markdown endpoint: <https://bun.com/blog/bun-in-rust.md>
- Page CSS bundle: <https://bun.com/_assets/site-fe5bbc3c.css>
- Page behavior bundle: <https://bun.com/_assets/behaviors-pc3ndgw8.js>
- Theme bootstrap: <https://bun.com/_assets/theme-etrzkzgr.js>

**Thesis:** The impressive parts of the Bun post are not heavyweight rendering
technology. They are small, data-dense, progressive-enhancement islands: mostly
server-rendered HTML/SVG with compact inline scripts that animate already-visible
facts. Interlinked can reproduce the effect by generating the same class of
visual artifacts from local harness, git, CI, and review telemetry.

This document describes the visual system, the component architecture, the data
contracts, and an implementation path for Interlinked-owned visualizations.

---

## 1. What Bun Actually Built

The post uses ordinary article prose plus five custom interactive blocks. In the
Markdown source, those blocks appear as custom tags:

| Markdown tag | Rendered visualization | Main story job |
|---|---|---|
| `reworkLeaderboard` | adversarial review carousel | show reviewer/implementer split catching bugs |
| `commitPunchcard` | 11 day by 24 hour commit heatmap | prove sustained parallel output |
| `errorWorkQueue` | compiler-error work queue replay | show distributed compiler-error burn-down |
| `ciBurndown` | Buildkite race-to-green replay | show platform CI convergence |
| `portReplay` | git log replay with counters | show commit volume and code churn over time |

Important observation: the global JavaScript bundle does not implement these
visualizations. The public bundle handles normal site behaviors such as theme
toggle, copy buttons, table-of-contents highlighting, and tab groups. Each
visualization is emitted as a self-contained inline "island" in the HTML.

The technical pattern is:

1. A build-time content component renders a complete static fallback.
2. The fallback already contains the interesting data in HTML, SVG attributes,
   or compact JSON arrays.
3. A tiny inline script waits for the section to enter the viewport.
4. The script animates counters, opacity, transforms, labels, and replay state.
5. The section remains readable when JavaScript is disabled or motion is reduced.

That is the main thing to replicate. The page is not visually impressive because
it uses a complicated graphics stack. It is impressive because it compresses a
large operational story into truthful, specific, replayable displays.

---

## 2. Shared Visual Language

All five custom blocks use the same visual shell:

- Full-width breakout from the article column using negative horizontal margins.
- Dark panel background around `#0b0c10`.
- Thin gray border, rounded corners on larger screens, border-only band on small
  screens.
- `not-prose` isolation so article typography does not leak into dashboards.
- Monospace micro-labels for telemetry, timestamps, counts, and buttons.
- Small uppercase tracking labels for "system" headers.
- High-contrast accent colors for state:
  - green for pass/progress,
  - red for failure,
  - yellow/orange for active work,
  - pink/purple for generated/code volume,
  - cyan for deletion or secondary movement.
- Static captions underneath the visualization, written like figure captions,
  not marketing copy.

The consistent shell makes each dense object feel like part of a single
instrument panel. For Interlinked, use the same pattern, but create an
Interlinked-specific palette so the result is inspired by Bun's technique rather
than a clone of Bun's brand.

Recommended Interlinked shell:

```ts
type VizShellProps = {
    id: string;
    eyebrow: string;
    title: string;
    stat?: string;
    caption: string;
    children: string;
};
```

CSS requirements:

- Make the shell independent from article prose.
- Use `overflow-anchor: none` to prevent scroll anchoring jumps during replay.
- Use stable min heights for animated regions so replay does not move following
  prose.
- Use CSS custom properties for palette and dimensions.
- Make the mobile layout a scroll-safe band, not a squeezed desktop card.
- Respect `prefers-reduced-motion: reduce`.

Do not put UI cards inside other cards. The visualization block is the frame;
sub-elements inside it should be panels, rows, lanes, or code/list surfaces.

---

## 3. Shared Runtime Pattern

Every custom visualization can share a tiny client runtime. The Bun page repeats
the same ideas inline; Interlinked should factor them into a local package while
still shipping small per-component payloads.

Required runtime helpers:

```ts
type IslandBoot = (root: HTMLElement) => void;

type MotionMode = "animated" | "reduced";

type ViewportTriggerOptions = {
    thresholdRatio: number;
    minVisibleViewportFraction: number;
};
```

Runtime behavior:

- `bootIsland(selector, fn)` initializes after `DOMContentLoaded` when needed.
- `onFirstView(root, fn)` starts replay when at least half the widget is visible.
- `motionMode()` returns `"reduced"` when the user has requested reduced motion.
- `easeOutCubic(t)` uses `1 - (1 - t)^3`.
- `formatInteger(n)` uses `en-US` grouping for counters.
- `animate(durationMs, render)` wraps `requestAnimationFrame` and clamps `t`.
- `scheduleSweep(items, getDelay, fn)` handles opacity/counter sweeps.

Accessibility requirements:

- Each SVG should have a `role="img"` or be labelled by nearby text.
- Every heatmap/bar cell that represents a real datum should have a `<title>`.
- Replay buttons must be real `<button>` elements.
- Reduced-motion mode should show the final state immediately, not a blank block.
- Important counts must exist as text in the static HTML before JavaScript runs.

Copyright requirement:

- Reimplement the mechanics, not the code. Do not copy Bun's inline scripts,
  bundled CSS, generated data, or exact content. Use our own event data,
  generated colors, class names, and component code.

---

## 4. Component 1: Adversarial Review Replay

### What Bun Shows

The first interactive block is a carousel of three bugs found by adversarial
review. Each pane has the same story structure:

1. The implementer shows plausible code.
2. A split-context reviewer explains the failure mode.
3. A fix or commit line resolves the bug.

The animation is simple but effective:

- Hide all panes except the active bug.
- Reveal the implementer message.
- Reveal the reviewer message.
- Highlight the bad code line.
- Reveal the fix/commit message.
- Enable a next/replay button.

The reviewer context is visually separated from the implementer context. That
matters. The visualization teaches the process, not only the bug.

### Interlinked Component

Name: `AdversarialReviewReplay`

Use cases:

- Explaining split-context Tier 3 review.
- Showing why an Interlinked check exists by replaying "agent wrote, reviewer
  found, check now prevents".
- Publishing high-signal release notes for new harness detectors.
- Demonstrating false-positive fixes: original warning, adversarial critique,
  revised deterministic rule.

Data contract:

```ts
type ReviewReplay = {
    eyebrow: string;
    title: string;
    summaryStat: string;
    panes: ReviewPane[];
};

type ReviewPane = {
    id: string;
    label: string;
    implementer: ActorCard;
    reviewer: ActorCard;
    codeBefore: CodeLine[];
    reviewFinding: string;
    codeAfter?: CodeLine[];
    resolution: string;
    commit?: {
        sha?: string;
        subject: string;
        url?: string;
    };
};

type ActorCard = {
    name: string;
    context: string[];
};

type CodeLine = {
    text: string;
    kind?: "normal" | "bad" | "fixed" | "context";
};
```

Rendering:

- Render every pane server-side for no-JS readability.
- Use a fixed-height stage calculated at build time when possible, or set with
  CSS `min-height`.
- Keep code in `<pre><code>` or line-based `<div>` rows. Line rows need stable
  height so highlights do not shift layout.
- Store pane metadata in `data-pane-id` attributes, not in a large JS object
  when the HTML already contains the content.

Animation:

- `0 ms`: active pane visible, messages hidden.
- `150 ms`: implementer message fades in.
- `700 ms`: reviewer message fades in and bad lines tint red.
- `1300 ms`: fix/commit message fades in.
- `1500 ms`: next button becomes active.

Reduced motion:

- Show all messages in the active pane immediately.
- Keep manual next/replay behavior available.

Interlinked-specific examples:

- `debug_assert_side_effect`: agent moves a side-effecting call into
  `debug_assert!`, reviewer catches release-only erasure, check prevents it.
- `destructive_command_guard`: agent proposes `rm -rf`, PreToolUse blocks before
  execution, fix uses scoped deletion or asks for approval.
- `test_oracle_integrity`: agent deletes a failing assertion, trajectory check
  catches test weakening after red run.

Implementation difficulty: low.

Primary risk: writing panes that are too verbose. Each bug should fit in one
screen-width block; the caption can carry detail.

---

## 5. Component 2: Commit Punchcard

### What Bun Shows

The commit punchcard is an SVG heatmap with 11 rows and 24 columns. Rows are
days; columns are hours. Each non-empty cell stores:

- an hour index,
- a count,
- a precomputed fill color,
- a tooltip title with the date/hour and commit count.

The replay is a left-to-right, topologically time-ordered opacity sweep. The
counter increments as cells become visible. The final static state is already in
the HTML.

### Interlinked Component

Name: `CommitPunchcard`

Use cases:

- Agent campaign retrospectives.
- "Harness dogfood week" reports.
- Docs pages showing rewrite or migration velocity.
- Comparing human-only vs harness-assisted periods.

Data contract:

```ts
type CommitPunchcardData = {
    timezone: string;
    startDate: string;
    endDate: string;
    totalCommits: number;
    peakBucket: {
        commits: number;
        label: string;
    };
    buckets: CommitHourBucket[];
};

type CommitHourBucket = {
    date: string;          // YYYY-MM-DD in display timezone
    hour: number;          // 0-23
    ordinal: number;       // increasing replay order
    commits: number;
    insertions?: number;
    deletions?: number;
    subjects?: string[];
};
```

Data generator:

```bash
git log --reverse --date=iso-strict --numstat --format='@@%H%x09%aI%x09%s'
```

Implementation notes:

- Parse commit boundaries from `@@`.
- Bucket by local or configured timezone.
- Count commits per hour.
- Sum `numstat` rows for insertions/deletions when available.
- Keep merge commits configurable: include for project activity, exclude for
  pure authoring throughput.
- Precompute color scale at build time so JS does not need a color library.

Rendering:

- SVG is the right tool. Use one `<rect>` per bucket.
- Include axis labels as SVG text or HTML overlay.
- Use `<title>` on each non-empty cell.
- Include legend labels derived from the real min/max.

Animation:

- Start all non-empty cells at opacity `0`.
- Sweep over `4000 ms` based on `ordinal / lastOrdinal`.
- On each reveal, add the bucket's commits to the displayed counter.
- If many buckets share a delay, batch DOM writes per frame.

Reduced motion:

- Render final cells at full opacity.
- Keep final total and peak labels visible.

Implementation difficulty: low.

Primary risk: misleading the reader if buckets are generated from rebased or
squashed history. Store the data generation command and commit range next to the
artifact.

---

## 6. Component 3: Work Queue Replay

### What Bun Shows

The compiler-error work queue is the densest block on the page. It presents:

- an approximate error counter,
- a replay button,
- a changing timestamp,
- a faux `errors.txt` file,
- four worktree lanes,
- pipeline cells for implement, review, apply,
- animated chips moving through the pipeline,
- crate/category rows filling as fixes land,
- a rolling commit-subject log.

The underlying data is compact: a timeline of events, each assigning a completed
unit of work to a lane/category. The expensive-looking animation is mostly
positioned HTML elements translated between known anchor points.

### Interlinked Component

Name: `WorkQueueReplay`

Use cases:

- Visualizing `verify --all-checks` burn-down across check IDs.
- Showing a multi-agent remediation campaign by file or check family.
- Explaining a cloud mutation-testing or sanitizer-finding queue.
- Demoing "compiler errors as a work queue" for any language.

Data contract:

```ts
type WorkQueueReplayData = {
    title: string;
    startTime: string;
    endTime: string;
    startCount: number;
    totalCompleted: number;
    countLabel: string; // "errors left", "findings left", "mutants killed"
    worktrees: WorktreeLane[];
    targets: WorkTarget[];
    events: WorkQueueEvent[];
    fileLines: string[];
    logSubjects: WorkLogSubject[];
};

type WorktreeLane = {
    id: string;
    label: string;
};

type WorkTarget = {
    id: string;
    label: string;
    total: number;
    color?: string;
};

type WorkQueueEvent = {
    atMs: number;
    targetId: string;
    worktreeId?: string;
    subjectIndex?: number;
};

type WorkLogSubject = {
    text: string;
    added?: number;
    deleted?: number;
};
```

Interlinked data sources:

- Local `interlinked verify --json` output grouped by `check_id`.
- Harness daemon JSONL events grouped by `hook_event`, `check_id`, `file`, or
  severity.
- Cloud job reports grouped by finding type.
- CI failure reports grouped by package or command.

Rendering:

- Top row: count, replay button, current clock.
- Left panel: sampled errors/findings as fixed-height monospace rows.
- Middle panel: worktree lanes. Each lane has three stage cells:
  `fix`, `review`, `apply`.
- Right or bottom panel: target rows with progress fills.
- Bottom log: recent landed fixes.

Animation:

- Batch events into about 100 to 180 visual batches so large datasets stay
  smooth.
- Create one temporary chip per event or batch.
- Use `getBoundingClientRect()` once per replay to capture anchors.
- Move the chip by CSS transforms:
  1. source file panel,
  2. fix stage,
  3. review stage,
  4. apply stage,
  5. target row.
- Increment target fills and counters at the final stage.
- Keep at most a fixed number of active lanes visible if the target list is
  large; evict oldest completed lanes.

Reduced motion:

- Apply every event immediately.
- Show final counters, fills, and recent log rows.

Implementation difficulty: high.

Primary risks:

- Layout instability on mobile. Fix with explicit track sizes and responsive
  breakpoints.
- Too many DOM nodes. Batch events and recycle chip elements.
- Misrepresenting concurrency. The data generator should preserve true event
  order, and captions should state when events were sampled or compressed.

Recommended first Interlinked instance:

Visualize a single `verify --all-checks` remediation run:

- `startCount`: number of findings at first scan.
- `targets`: top 8 check IDs by finding count.
- `events`: one per finding resolved, derived by diffing sequential verify
  snapshots.
- `fileLines`: representative findings.
- `logSubjects`: commit or patch summaries.

---

## 7. Component 4: CI Race To Green

### What Bun Shows

The CI visual replays platform lanes over time. Each lane is a compact SVG strip
of build attempts. Rect colors encode state:

- red for at least one failing shard,
- dim green for no failures but incomplete/superseded,
- bright green for full pass,
- gray/low-opacity for future or not-yet-visible runs.

During replay:

- a vertical headbar sweeps across time,
- each lane's label changes color based on current state,
- first-green timestamps appear,
- the top counter moves from `0 / 6` to `6 / 6`,
- a final banner appears when all lanes are green.

### Interlinked Component

Name: `CiRaceToGreen`

Use cases:

- Release retrospectives for cross-client support: Claude, Codex, Copilot,
  Gemini.
- Multi-platform test campaigns.
- "Before merge" proof for a risky harness change.
- Cloud worker rollout by region or tenant cohort.

Data contract:

```ts
type CiRaceToGreenData = {
    title: string;
    provider: "github-actions" | "buildkite" | "local" | "other";
    startTime: string;
    endTime: string;
    finalBuildLabel: string;
    lanes: CiLane[];
    runs: CiRun[];
};

type CiLane = {
    id: string;
    label: string;
    shardCount?: number;
    firstGreenAt?: string;
};

type CiRun = {
    id: string;
    label: string;
    at: string;
    laneStates: Record<string, CiLaneState>;
    url?: string;
};

type CiLaneState = "none" | "failed" | "incomplete_pass" | "passed";
```

GitHub Actions data source:

- Use `gh run list --json databaseId,createdAt,displayTitle,conclusion,status,url`.
- Use `gh run view <id> --json jobs` to map jobs to lanes.
- Normalize `success` to `passed`.
- Normalize `failure`, `timed_out`, `cancelled` with failed jobs to `failed`.
- Normalize `cancelled` or superseded runs with no failed jobs to
  `incomplete_pass`.

Rendering:

- Use one SVG per lane. This keeps horizontal scroll and responsive sizing
  simple.
- Each run rect gets a title: run label, timestamp, state, optional URL.
- Use a shared x-scale across lanes.
- Add date ticks on a separate top axis.

Animation:

- Replay over `10000` to `16000 ms`.
- For each frame, find the latest run at or before the current timestamp.
- Set future rects to low opacity.
- Compute current lane state from the latest run.
- Show first-green stamps when the current timestamp passes that lane's first
  green point.
- Show the final banner only when every lane is green.

Reduced motion:

- Render final state immediately.

Implementation difficulty: medium.

Primary risk: CI provider semantics differ. Keep the normalizer separate from
the component and store raw provider data for audits.

---

## 8. Component 5: Git Log Replay

### What Bun Shows

The git log replay is a time-series bar chart plus live counters and a rolling
commit log. The bars are already present as SVG. During replay:

- total commits count up,
- total lines count up,
- the timestamp advances,
- a playhead crosses the chart,
- recent commit subjects scroll in a log area.

Unlike the punchcard, this is optimized for temporal drama instead of
hour-of-day distribution.

### Interlinked Component

Name: `GitLogReplay`

Use cases:

- Interlinked release campaign histories.
- Agent campaign recaps.
- Comparing churn before/after a harness rule.
- Showing docs generation or rule import waves.

Data contract:

```ts
type GitLogReplayData = {
    startTime: string;
    endTime: string;
    timezone: string;
    totalCommits: number;
    totalInsertions: number;
    totalDeletions: number;
    peakBucket: {
        commits: number;
        label: string;
    };
    buckets: GitReplayBucket[];
    ticker: GitReplayTickerItem[];
};

type GitReplayBucket = {
    atMs: number;
    commits: number;
    insertions: number;
    deletions: number;
};

type GitReplayTickerItem = {
    atMs: number;
    subject: string;
    insertions?: number;
    deletions?: number;
    url?: string;
};
```

Data generator:

- Use the same raw parser as `CommitPunchcard`.
- Bucket by minute, 5 minutes, or hour depending on range.
- Precompute cumulative counts.
- Preserve a sampled ticker list of meaningful commits:
  - non-merge commits,
  - commits above a line-change threshold,
  - commits matching a selected prefix,
  - commits with review attribution.

Rendering:

- SVG bars use insertion/deletion ratio for color.
- Counter text is static final state first, then script can reset and replay.
- Ticker rows should have a fixed row count and fixed height.

Animation:

- Replay over `20000` to `30000 ms` for long campaigns.
- Frame index maps from progress to bucket index.
- Counters use precomputed cumulative arrays.
- Playhead is a single SVG line translated along x.
- Ticker rows update only when the selected ticker index changes.

Reduced motion:

- Show final counters and the latest ticker rows.

Implementation difficulty: medium.

Primary risk: line counts from generated files can dominate the narrative. The
generator needs include/exclude patterns and should display them in metadata.

---

## 9. Data Generation Package

Create a small internal package rather than hand-authoring JSON for every
article.

Suggested location:

- `src/lib/visualizations/git-log.ts`
- `src/lib/visualizations/ci.ts`
- `src/lib/visualizations/work-queue.ts`
- `src/lib/visualizations/review-replay.ts`
- `src/lib/visualizations/render-data.ts`

If this should not ship in the CLI package, put scripts under:

- `scripts/visualizations/`

Recommended CLI shape:

```bash
interlinked viz git-punchcard --since 2026-07-01 --until 2026-07-09 --out docs/generated/viz/punchcard.json
interlinked viz git-replay --range main..feature --bucket 5m --out docs/generated/viz/git-replay.json
interlinked viz ci-race --provider github-actions --workflow test.yml --out docs/generated/viz/ci-race.json
interlinked viz work-queue --from .interlinked/events.jsonl --group-by check_id --out docs/generated/viz/work-queue.json
```

This can start as non-public scripts. Promote to CLI only after there are two or
more docs pages that use it.

Common metadata fields:

```ts
type VisualizationArtifact<T> = {
    schemaVersion: 1;
    generatedAt: string;
    source: {
        kind: "git" | "ci" | "verify" | "harness-events" | "manual";
        command?: string;
        range?: string;
        files?: string[];
        notes?: string[];
    };
    data: T;
};
```

Why this metadata matters:

- The visualizations are persuasive. They must also be auditably true.
- Rebased history, skipped CI jobs, generated files, and sampled events can
  change the story.
- Captions should expose the sampling/compression rule when it affects
  interpretation.

---

## 10. Rendering Strategy Options

### Option A: Static HTML Islands

Build a tiny renderer that writes HTML snippets for docs.

Pros:

- Works without a docs framework migration.
- Easy to publish as static artifacts.
- Closest to Bun's actual shape.

Cons:

- Less ergonomic for future documentation authors.
- Harder to share styles with a future docs site.

Best first step for this repo.

### Option B: MDX Components

Create React/MDX components for each visualization.

Pros:

- Best authoring ergonomics if Interlinked gets an MDX docs site.
- Component props can be typed directly.
- Easy to test with Storybook or Playwright component fixtures.

Cons:

- Adds framework decisions this repo may not need yet.

Good second step if the docs site exists or is planned.

### Option C: Markdoc Tags

Implement custom tags like Bun's Markdown source.

Pros:

- Clean article authoring syntax.
- Strong content/data separation.
- Directly mirrors the source pattern researched here.

Cons:

- Requires a Markdoc build pipeline.
- More infrastructure than needed for a first prototype.

Good long-term option for a polished public docs/blog system.

Recommendation:

1. Start with static HTML island generation from JSON artifacts.
2. Use the same data contracts that MDX/Markdoc would consume later.
3. Add a renderer boundary so output format can change without regenerating
   telemetry.

---

## 11. Test And QA Plan

Visualizations need tests because they will be used as evidence.

Data generator tests:

- Parse git logs with merge commits, binary files, renames, and generated files.
- Timezone bucketing across midnight.
- Empty ranges.
- Large commit counts.
- Stable schema snapshots.

Renderer tests:

- The static HTML contains final counts.
- Every non-empty SVG datum has a tooltip title.
- No duplicate DOM IDs when two visualizations appear on one page.
- Reduced-motion path renders final state.
- Replay button exists where replay is supported.

Browser tests:

- Use Playwright against generated fixture pages.
- Desktop and mobile screenshots.
- Pixel assertion that SVG bars/cells are nonblank.
- Trigger viewport entry and confirm counters change.
- Enable reduced motion and confirm no long animation runs.
- Check text does not overflow buttons or labels.

Performance tests:

- Work queue with 2,000 events should animate without adding 2,000 persistent
  chip nodes.
- CI race with 1,000 runs should keep SVG node count bounded by actual cells and
  avoid per-frame layout thrash.
- Git replay should update ticker rows only when index changes, not every frame.

Accessibility checks:

- Buttons are keyboard focusable.
- Color is not the only state carrier; labels and titles include state.
- SVGs have accessible names or adjacent summaries.
- Reduced-motion is respected.

---

## 12. Implementation Phases

### V0 - Design Research Artifact

Deliver this document.

Acceptance:

- The five Bun custom visualization classes are identified.
- Each has a concrete Interlinked component/data contract.
- Legal and implementation constraints are explicit.

### V1 - Shared Shell And Runtime

Files:

- `src/lib/visualizations/runtime.ts`
- `src/lib/visualizations/shell.ts`
- `src/lib/visualizations/styles.css` or emitted inline CSS
- fixture HTML under `docs/generated/visualizations/fixtures/`

Deliver:

- `VizShell`
- `bootIsland`
- `onFirstView`
- `animate`
- `easeOutCubic`
- reduced-motion helpers

Acceptance:

- One fixture page renders a shell and starts an animation on viewport entry.
- Reduced motion shows final state.
- Playwright screenshot passes desktop and mobile.

### V2 - Commit Punchcard

Files:

- `src/lib/visualizations/git-log.ts`
- `src/lib/visualizations/commit-punchcard.ts`
- tests for git parser and HTML renderer

Deliver:

- Git log parser.
- Hourly bucket generator.
- SVG heatmap renderer.
- Sweep animation.

Acceptance:

- Can generate a punchcard for this repo over a selected date range.
- Static HTML contains total commits and peak bucket.
- Every cell has a title.
- Animation completes in 4 seconds.

### V3 - Adversarial Review Replay

Files:

- `src/lib/visualizations/adversarial-review.ts`
- sample data under `docs/generated/visualizations/samples/`

Deliver:

- Pane renderer.
- Code-line highlight animation.
- Next/replay behavior.

Acceptance:

- Three sample panes render.
- Bad lines highlight only after reviewer text appears.
- Reduced motion shows all active-pane content immediately.

### V4 - Git Log Replay

Files:

- `src/lib/visualizations/git-replay.ts`

Deliver:

- Minute or configurable bucket generator.
- Bar SVG renderer.
- Counter/playhead/ticker replay.

Acceptance:

- Can render a repo history range.
- Includes generated-file exclude option.
- Ticker rows are stable height and do not shift layout.

### V5 - CI Race To Green

Files:

- `src/lib/visualizations/ci-race.ts`
- optional `src/lib/visualizations/providers/github-actions.ts`

Deliver:

- Provider-independent CI state schema.
- GitHub Actions normalizer if `gh` data is available.
- Lane SVG renderer.
- Timeline replay.

Acceptance:

- Can render from a saved JSON fixture without network.
- First-green stamps match input data.
- Final banner appears only when all lanes are green.

### V6 - Work Queue Replay

Files:

- `src/lib/visualizations/work-queue.ts`
- optional `src/lib/visualizations/providers/interlinked-events.ts`

Deliver:

- Verify/harness event normalizer.
- Target progress rows.
- Animated pipeline chips.
- Rolling log.

Acceptance:

- Handles at least 2,000 events in a fixture.
- Keeps active chip DOM bounded.
- Works on mobile by switching from multi-column to stacked layout.

### V7 - Public Docs Integration

Deliver:

- A public-facing Interlinked engineering note using at least three components.
- Generated data artifacts checked in or reproducibly generated.
- Docs build command validates schema and screenshots.

Acceptance:

- One command regenerates data.
- One command runs visualization tests.
- The page is readable without JavaScript.

---

## 13. Interlinked-Specific Storyboard

The strongest first article would not be "we copied Bun's charts." It should be
"Interlinked makes agent work auditable." Suggested article flow:

1. **Agent proposed code, harness reviewed code.**
   Use `AdversarialReviewReplay` for three real detector wins.

2. **A week of harness hardening.**
   Use `CommitPunchcard` for commits over time.

3. **Findings became a work queue.**
   Use `WorkQueueReplay` for check burn-down grouped by check family.

4. **The suite raced to green.**
   Use `CiRaceToGreen` for platform/client matrix.

5. **The campaign replay.**
   Use `GitLogReplay` for the full history and rolling commit subjects.

The article should keep Bun's core editorial lesson: the visualizations are not
decorative. Each one answers a credibility question:

| Credibility question | Visualization |
|---|---|
| Did independent review catch real bugs? | Adversarial review replay |
| Was there sustained output or one burst? | Commit punchcard |
| Did errors actually burn down? | Work queue replay |
| Did the full matrix pass? | CI race to green |
| How much changed over the campaign? | Git log replay |

---

## 14. Concrete First Prototype

Build only two components first:

1. `CommitPunchcard`
2. `AdversarialReviewReplay`

Reason:

- They are the smallest and least risky.
- They cover both data-generated and manually-authored visual stories.
- They establish the shell, runtime, accessibility, and visual test harness.

Prototype steps:

1. Add `scripts/visualizations/git-log-to-punchcard.ts`.
2. Add `src/lib/visualizations/runtime.ts`.
3. Add `src/lib/visualizations/commit-punchcard.ts`.
4. Add `src/lib/visualizations/adversarial-review.ts`.
5. Generate `docs/generated/visualizations/bun-style-prototype.html`.
6. Run Playwright screenshot tests on desktop and mobile.
7. Iterate CSS until text, labels, and SVG geometry are stable.

Prototype acceptance:

- No network needed after generation.
- HTML opens directly from disk or through a static server.
- The punchcard uses this repo's real git history.
- The review replay uses Interlinked-specific example panes.
- Both widgets pass reduced-motion checks.
- No Bun code, data, class names, or exact copy is reused.

---

## 15. Non-Goals

- Do not build a full blog system as part of the visualization prototype.
- Do not copy Bun's generated HTML, inline scripts, CSS class names, or data.
- Do not use canvas for these first components; SVG/HTML is enough and easier to
  audit.
- Do not require live GitHub/Buildkite access to render a page. Network-backed
  providers should write saved JSON fixtures.
- Do not make animations the source of truth. The static artifact must contain
  the facts.
- Do not ship a visualization that omits the data generation command or source
  range.

---

## 16. Key Takeaways For Interlinked

The highest-leverage replication is architectural:

- Use custom docs tags or generated HTML islands.
- Render truthful final states server-side.
- Animate by revealing and replaying, not by inventing state in the browser.
- Keep data compact and inspectable.
- Make every chart answer a trust question.
- Treat reduced motion and no-JS as first-class paths.
- Test visualizations like product UI because they will be used as evidence.

Bun's post feels advanced because it combines operational specificity with
simple, robust rendering primitives. Interlinked can get the same effect by
turning harness telemetry into stable data artifacts, then replaying those
artifacts with small SVG/DOM islands.
