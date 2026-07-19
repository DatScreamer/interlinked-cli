# CI lane split (2026-07)

## Problem

CI ran the full ~21k-test vitest suite as a single `build-and-test` job. On the
ubuntu runner the suite exceeded `timeout-minutes: 25` and was cancelled with
**no verdict** — CI burned 25 minutes per run and produced nothing. Root cause
was suite *duration*, not any single test: at `CI=1` (the worker cap that dodges
a vitest reporter-IPC timeout) the suite needs ~30 min single-threaded on the
runner, ~13 min locally on macOS.

## Fix: three parallel jobs

`.github/workflows/ci.yml` splits into three jobs, each well under 25 min:

| Job | Runs | Why separate |
|-----|------|--------------|
| `unit` | `test:unit` — every `*.test.ts` **except** `*.integration.test.ts` | Fast, OS-independent; quick feedback + clean-checkout backstop |
| `integration` | `test:integration` — the `*.integration.test.ts` files | Subprocess-spawning / Linux-sensitive tests; exactly what a Linux runner uniquely validates over the dev's macOS pre-push gate |
| `package` | build + publint/attw/pack + tarball-install + onboarding smokes | The new-user install path; kept off the test lanes' critical path |

Measured at `CI=1`: unit ~7.3 min, integration ~3 min locally → ~15 / ~7 min on
the runner. On the runner: integration 2 min, package 3 min.

### Lane mechanism

`*.integration.test.ts` naming = the lane (self-classifying; new integration
tests just take the suffix). 84 subprocess-spawning files were renamed. Two lane
configs (`vitest.{unit,integration}.config.ts`) override include/exclude off the
shared base (`vitest.config.ts`); `npm test` + the pre-push gate still run the
full suite as the superset.

`retry` dropped 2 → 1: the flaky real-git tests now live in the integration lane
with 120s timeouts, so the double-retry (which tripled a flake's cost) is gone.

## Bugs the split exposed (were masked by the full-suite timeout)

1. **`extract-refs.test.ts` ReDoS-guard perf budgets** — asserted linear
   bracket scanning finishes `< 500ms`; the slower ubuntu runner clocks ~620ms
   on the 240k-bracket case. Raised to `REDOS_GUARD_MS = 3000` (a real
   catastrophic-backtracking regression is exponential → seconds/minutes, so the
   generous ceiling still catches it). Fixed.

2. **`recurrence.test.ts` Linux collection hang** — hangs during collection
   (import/register, before any test runs) on the ubuntu runner; deterministic,
   confirmed file-specific (excluding it lets the lane complete; the hang does
   not move to another file), yet passes at `CI=1` on macOS. Imports are pure
   and describe bodies trivial, so the cause is still open. **Quarantined** from
   the unit lane (`vitest.unit.config.ts` exclude) and still run by the pre-push
   gate. TODO(recurrence-ci-hang): root-cause and un-quarantine.

## Diagnosis method (for the next Linux-only hang)

The hang was pinpointed with a temporary class reporter wired into the unit lane
that logs `[FILE-START]/[FILE-END]` (and `[CASE-START]/[CASE-END]`) in real time
from the main process; the cancelled job's log then names the last
started-not-ended file/case. Cancelling the run early (once the other lanes pass
and the unit lane is clearly stuck) yields the log ~15 min sooner than the 25-min
timeout.
