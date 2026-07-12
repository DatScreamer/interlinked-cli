# Ontoloom

- **Source:** https://github.com/jonathanpopham/ontoloom (MIT; created 2026-06-30, primarily JS by bytes)
- **Encountered:** 2026-07-07, user prompt ("clone and analyze… use/adapt for our interlinked harness").
- **Verdict:** **PR.** Vendor `codemap.js` as an alternate `viz` renderer (LOD drill-down) + add graph-interchange exporters. **Same vendor as [[supermodel]]/[[trailtracker]]** (Jonathan Popham / Supermodel Tools) — the public, MIT, borrow-legal piece of that stack.

## 1. Core idea (one sentence, my words)

An airgapped, zero-dependency, MIT Rust+vanilla-JS knowledge-graph editor whose real asset is `codemap.js`: a fully-deterministic client-side code-graph *renderer* (drill-down tree + force-directed web) that visualizes [[trailtracker]]'s domain→unit→file→symbol hierarchy graphs at scale.

## 2. Anatomy (concrete walkthrough)

```
src/            Rust, std-only: json.rs (hand-rolled codec), model.rs (graph + optional
                schema, soft-validation), server.rs (loopback HTTP; /api/analyze shells
                `trailtracker export ontoloom`), export.rs, import.rs, assets.rs (include_str!)
web/            vanilla JS: app.js (manual editor), codemap.js (1,680 lines — THE asset),
                style.css, index.html
```

Load-bearing:
- **`web/codemap.js`** — the crown jewel. `CodeMap.detect()` sniffs a hierarchy graph (`view:"hierarchy"` + `level` + `CONTAINS`); `load()` renders it. **Big-graph LOD strategy: never renders the whole graph** — one collapse-bit per tree node, lays out only the expanded slice, starts collapsed at domain level (handles the 3,270-node eShop fixture incl. 2,685 symbols). Two layouts: tidy-tree (containment) + force-web (coupling). **Fully deterministic** — FNV-seeded starts, fixed tick budgets, no `Math.random`, byte-identical repaints (asserted in `tests/harness/`), localStorage drag-pins. First-run tour, ARIA, keyboard nav.
- **`src/export.rs`** — four exporters: Neo4j JSONL (APOC shape), Cypher, Ontoloom JSON (only lossless one), GraphML. Hand-written, std-only.
- **`src/server.rs`** — zero-dep loopback HTTP serving the `include_str!`-embedded UI. `/api/analyze` shells out to the private [[trailtracker]] binary.

User invokes: `./ontoloom` → browser opens to a graph editor; import a graph or analyze a repo. Not itself an agent tool.

## 3. Deterministic or agentic? (+ license)

**Fully deterministic**, no LLM anywhere (FNV-seeded layout, fixed budgets, byte-identical output). **License: MIT** → code-borrow legal.

## 3b. Role in its native architecture — and does it transfer?

Native role: the **visual surface** of the Geist Stack (renders [[trailtracker]] output). Transfers cleanly — the renderer is client-side JS, runs identically served by our own `viz` `node:http` server. We take the JS, discard the Rust.

## 4. Substrate vs. surface

- **Substrate (borrow):** `codemap.js`'s LOD drill-down renderer + the interchange exporters. Independent of the Rust host.
- **Surface (skip):** the manual ontology *editor* (`app.js` node/edge CRUD, schema panel) — our graph is derived from code, not hand-authored.

## 5. Lane (1–6)

**Lane 3 (substrate)** — a reusable renderer + interchange serializers. Secondary **Lane 4 (pattern)** — "determinism as diffability" (byte-reproducible layout → structure-drift filmstrip); soft-validation ("warn, never block") mirrors our advisory/gate split.

## 6. Dependency & displacement

- **Deps:** **zero new** — `codemap.js` is a vanilla-JS static asset served by `viz`, not an npm import. The interchange exporters are hand-written (std-only in Rust; trivially ported to TS). "No new dep" is met.
- **Displacement / equivalence:** directly upgrades **`interlinked viz`** (committed, `src/lib/viz/`). Our `viz` is a hand-rolled canvas force-sim (grid repulsion) — sophisticated but **flat file-level**, renders the whole snapshot, no hierarchy levels, no interchange export. `codemap.js` adds **LOD drill-down + domain→unit→file→symbol levels + tree/web duality**; our `viz` keeps what codemap lacks — **live SSE** (activity + gate decisions). The fusion (LOD hierarchy + live SSE) is the win; neither tool has both.

| Capability | Our `viz` | ontoloom `codemap.js` |
|---|---|---|
| Force layout | canvas, grid repulsion | SVG + tidy-tree |
| Scale strategy | whole snapshot | **lazy-expand LOD** |
| Granularity | flat file-level | **domain→unit→file→symbol** |
| Live data | **SSE (activity+checks)** | static |
| Interchange export | **none** | Neo4j/Cypher/GraphML |

## 7. Smallest spike (≤1 day)

~200-line adapter projecting our `structure` ArtifactGraph into ontoloom hierarchy-wire JSON (it already *is* a domain/unit/file/symbol hierarchy under different names: `layer`→domain, `package`→unit, `module`→file, `public_symbol`→symbol; `belongs_to_*`/`exports`→`CONTAINS`, `ImportEdge`→`DEPENDS_ON`) + vendor `codemap.js` behind a `viz --hierarchy` flag. Proves LOD drill-down against our own repo immediately.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|---|---|---|---|
| Free CLI (P1) | `codemap.js` as `viz` renderer; `interlinked structure export --format {cypher,graphml,neo4j-jsonl}` | §7 | now / next |
| Agent CI (P4–5) | same renderer, different node population (multi-agent/reservation/trajectory graph) served from a Worker — lift codemap's force-sim core, not the hierarchy | — | parked |

## 9. Artifact

**PR** — vendor `codemap.js` + the adapter (§7) as an alt `viz` renderer; add the interchange exporters as `interlinked structure export`. Both deterministic, local, zero-new-dep.

## Notes

- **This is a parallel-evolved twin of our own `viz`**, not a foreign tool — same DNA (zero-dep, loopback, hand-rolled deterministic force layout, offline). The value is cross-pollination, not adoption.
- **What to reject:** `server.rs` (we have a better SSE server); `/api/analyze`→[[trailtracker]] (private/unavailable — we're our own analyzer); the manual editor; the v0.2 roadmap (OWL/Turtle/Protégé). **Not yet built** (verified, not just README): the `[[wikilink]]` markdown-vault importer, OWL/Turtle export, and the schema-editor UI are all v0.2 *goals* — only the schema *model* (M1) landed. One watch-item: the M5 vault importer would render our own `MEMORY.md` `[[wikilink]]` vault as a graph.
- Related: [[trailtracker]], [[supermodel]]. Memory: `project_viz_dashboard_shipped.md` (note: `viz` is committed & clean, not uncommitted; and "forks: graph/both/sink" is not a real surface — both stale, correct on next memory pass).
