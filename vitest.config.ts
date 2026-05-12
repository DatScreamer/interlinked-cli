import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["src/**/*.test.ts"],
        testTimeout: 10_000,
        // Several tests spawn real `npx biome` / `tsc` subprocesses. Under
        // parallel full-suite load, cold-start npx can overshoot the per-file
        // diff-overlay budget, producing empty results that fail assertions.
        // A global retry absorbs these rare transient flakes without masking
        // real regressions — a genuinely broken test will still fail on every
        // retry. Keep the value conservative so retry isn't a crutch.
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
        poolOptions: {
            threads: {
                maxThreads: process.env.CI ? 2 : undefined,
            },
            forks: {
                maxForks: process.env.CI ? 2 : undefined,
            },
        },
    },
});
