# Bench results

Longitudinal record of evaluator hot-path p50 / p99 timings. Populated by `npm run bench`. Each row is a measurement on a specific commit; thresholds live in `bench/THRESHOLDS.md` once locked.

| Date | Commit | Scenario | Class | p50 (ms) | p99 (ms) | Notes |
|---|---|---|---|---|---|---|
| 2026-04-27 | cdf2dc4 | Bash ls — no rule fires | Read | 0.0301 | 0.0499 | Phase-1 scaffolding baseline. 200 iterations × 50 warmup. |
| 2026-04-27 | (post Phase B + memory-fix) | Bash ls — no rule fires | Read | 0.0335 | 0.0719 | After Phase B.1 + content-keyword filter + 105 rules. Trivial regression vs baseline; well within budget (300 ms). |
| 2026-04-27 | (post Phase B + memory-fix) | Read file_path — no rule fires | Read | ≈0.011 | ≈0.022 | New scenario. Read-tool path is faster than Bash because guard rules don't apply to non-Bash tools. |
| 2026-04-27 | (post Phase B + memory-fix) | Edit on benign .ts file | Modify | ≈0.013 | ≈0.020 | New scenario. With Plan 04's 9 inline detectors gated by content_keywords, no detector fires on a 12-char content delta — most are quick-rejected. |
| 2026-04-27 | (post Phase B + memory-fix) | Write benign .py content | Modify | ≈0.010 | ≈0.016 | New scenario. |
| 2026-04-27 | (post Phase B + memory-fix) | Bash git push --force | Side-effect | 0.009 | 0.014 | New scenario. Hot rule firing path is the FASTEST (rules-loader's keyword index hits early; rule is the first match in the chain). |
| 2026-04-27 | (post Phase B + memory-fix) | Bash terraform destroy | Side-effect | 0.019 | 0.025 | New scenario. Plan 02 rule fires; iteration through more keyword candidates than the git case. |
| 2026-04-27 | (post Phase B + memory-fix) | Bash npm install | Side-effect | 0.038 | 0.054 | New scenario. **Worst case** for the keyword-quick-reject because npm hits no rule keywords; un-keyworded fallback rules iterate fully. Still 4000× under budget. |

## Threshold-locking workflow

1. ✅ Land Plan 01 (evaluator architectural upgrades) — done.
2. Run `npm run bench` three times on a quiet machine; record p99 for each scenario.
3. Set per-scenario threshold to `1.5 × max(p99)` of the three runs (variance buffer for CI).
4. Add the threshold assertion to the bench `expect()`; commit `bench/THRESHOLDS.md`.
5. From this point forward, every PR's bench p99 must stay under threshold or the PR is blocked.

Thresholds are not budgets. The budget is what users can perceive (Read 300 ms / Modify 800 ms / Side-effect 2000 ms p99 per `three-product-architecture.md`); the threshold is `1.5 × measured_p99` so we catch regressions while leaving headroom for runner variance.

## What we know after the post-Phase-B run

- **Pre-event evaluator is essentially free.** Worst-case p99 (npm command, no keyword hits) is 0.05 ms. Budget is 2000 ms. We have 40 000× headroom for additional Pre rules.
- **The post-event pipeline is where the budget pressure lives.** Real-world telemetry from `interlinked harness latency` (this session): Post p99 = 59.58 s on TS edits. Phase A's parallelism + tsgo --watch is the only path to fitting that into 30 s.
- **Keyword-quick-reject works.** The npm-install scenario is 4× slower than rule-firing scenarios because it iterates more un-keyworded fallback rules — visible proof the keyword filter is doing real work.
- **Plan 04's content_keywords filter is invisible at this scale.** The 9 inline detectors gated by keywords add no measurable Pre cost on benign content because most fail the substring gate immediately.

## Open scenarios to add

- **PostToolUse Edit + .ts content** — dependent on Phase A.7 telemetry shape; bench would shell out to the daemon socket and time round-trip. Will be the budget-canary scenario.
- **Daemon-warm vs daemon-cold** — measure Phase A.5's tsgo --watch impact directly.
- **rules-loader cold load** — first-call cost.
