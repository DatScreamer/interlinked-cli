import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["src/**/*.test.ts"],
        // Integration tests spawn real `npx biome` / `tsc` / CLI subprocesses.
        // Under the worker-capped full-suite run (see `poolOptions` below) a
        // cold start can take tens of seconds, so vitest's 10s default
        // produced timeout flakes that reddened `CI=1 npm test`. A 30s floor
        // gives ~3x headroom; genuinely-heavier cases keep explicit per-test
        // overrides (e.g. write.test.ts at 60s). hookTimeout matches so a slow
        // `beforeAll`/`afterAll` (biome warm-up, fixture I/O) is covered too.
        testTimeout: 30_000,
        hookTimeout: 30_000,
        // A global retry absorbs rare transient flakes without masking real
        // regressions — a genuinely broken test still fails on every retry.
        retry: 2,
        // Test isolation for the distilled-rules layer: the per-developer
        // `.interlinked/distilled-rules.json` (output of `/enforce`) varies
        // by whoever ran the skill against what — leaving it on means
        // evaluator tests pick up rules generated from the running dev's
        // AGENTS.md and assert against the wrong baseline. The opt-out
        // affects only `loadRules()`; tests that exercise
        // `loadDistilledRules` directly (e.g. `distilled-rules.test.ts`)
        // bypass this gate.
        env: {
            INTERLINKED_SKIP_DISTILLED_RULES: "1",
        },
        // CI-only parallelism cap. On macOS GitHub runners (the lower-
        // resource members of the matrix), running the full ~6700-test
        // suite with vitest's default parallelism produces enough
        // reporter IPC traffic to occasionally trip
        //   "[vitest-worker]: Timeout calling onTaskUpdate"
        // — every test passes, but the main↔worker RPC times out and
        // vitest exits non-zero, turning main red despite no real
        // regression. Capping concurrent worker threads in CI keeps
        // the IPC pressure under the timeout budget; local dev keeps
        // full parallelism (`undefined` lets vitest pick).
        //
        // Tracked symptom: CI run 25736848966 on commit 4d647ea (rerun
        // passed without any code change). Both pools are capped because
        // the project hasn't pinned `pool` — vitest could pick either.
        //
        // 2026-05-19: the 2-worker cap was no longer enough after the
        // supply-chain allowlist tests landed (+~150 tests, ~7800 total).
        // Three consecutive local pre-push runs on macOS hit the IPC
        // timeout despite all 7799 tests passing. Dropped to 1 worker in
        // CI to eliminate IPC contention entirely. Local dev keeps
        // unbounded parallelism via the `undefined` branch.
        poolOptions: {
            threads: {
                maxThreads: process.env.CI ? 1 : undefined,
            },
            forks: {
                maxForks: process.env.CI ? 1 : undefined,
            },
        },
    },
});
