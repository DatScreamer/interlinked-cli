# separate-tests fixture

Tiny ESM package with sources under `src/` and vitest tests under `tests/`.
Used by the harness-compat evals. As committed, `npm test` FAILS: `src/calc.js`
contains a deliberate bug that `tests/calc.test.js` catches (the
fix-failing-test task asks the agent to repair the source, not the test).
