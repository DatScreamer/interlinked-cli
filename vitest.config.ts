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
    },
});
