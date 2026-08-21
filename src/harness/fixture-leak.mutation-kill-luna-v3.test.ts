import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectFixtureLeaks, formatFixtureLeakWarning } from "./fixture-leak.js";

describe("fixture leak detection", () => {
    let cwd: string;

    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "fixture-leak-mutation-"));
        execSync("git init -q", { cwd });
        execSync("git config user.email test@example.com", { cwd });
        execSync("git config user.name Test", { cwd });
        execSync("git commit --allow-empty -q -m initial", { cwd });
    });

    afterEach(() => {
        rmSync(cwd, { recursive: true, force: true });
    });

    function commit(path: string, source: string): void {
        const absolute = join(cwd, path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, source);
        execSync(`git add ${path}`, { cwd });
        execSync("git commit -q -m fixture", { cwd });
    }

    function untracked(path: string): void {
        const absolute = join(cwd, path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, "fixture");
    }

    // test-contract: each supported test-file shape and valid fixture basename produces exactly its referenced leak.
    it("recognizes supported test paths and fixture extensions", () => {
        commit("src/__tests__/alpha.test.tsx", 'const n = "_alpha.ts"; writeFixture(n);');
        commit("src/__tests__/beta.spec.jsx", 'const n = "_beta.js"; setupFixture(n);');
        commit("src/tests/gamma.js", 'const n = "_gamma.py"; createFixture(n);');
        untracked("src/fixtures/_alpha.ts");
        untracked("src/fixtures/_beta.js");
        untracked("src/fixtures/_gamma.py");

        expect(detectFixtureLeaks(cwd)).toEqual([
            { file: "src/fixtures/_alpha.ts", referencedBy: "src/__tests__/alpha.test.tsx" },
            { file: "src/fixtures/_beta.js", referencedBy: "src/__tests__/beta.spec.jsx" },
            { file: "src/fixtures/_gamma.py", referencedBy: "src/tests/gamma.js" },
        ]);
    });

    // test-contract: a writer call that names a different fixture cannot authorize an unrelated basename.
    it("rejects an unmentioned basename", () => {
        commit("src/__tests__/checks.test.ts", 'writeFixture("_other.ts");');
        untracked("src/fixtures/_missing.ts");

        expect(detectFixtureLeaks(cwd)).toEqual([]);
    });

    // test-contract: a basename in a comment without a writer call is not sufficient evidence.
    it("rejects comment-only references", () => {
        commit("src/__tests__/checks.test.ts", "// _missing.ts is documented here");
        untracked("src/fixtures/_missing.ts");

        expect(detectFixtureLeaks(cwd)).toEqual([]);
    });

    // test-contract: only a strict underscore-prefixed supported extension is a fixture candidate.
    it("rejects invalid candidate basenames", () => {
        commit("src/__tests__/checks.test.ts", 'writeFixture("_valid.ts");');
        untracked("src/fixtures/valid.ts");
        untracked("src/fixtures/_valid.ts.backup");
        untracked("src/fixtures/__valid.ts");

        expect(detectFixtureLeaks(cwd)).toEqual([]);
    });

    // test-contract: no untracked files and no candidate files both return the advisory empty result.
    it("returns no leaks when there is nothing to scan", () => {
        expect(detectFixtureLeaks(cwd)).toEqual([]);
        commit("README.md", "tracked");
        untracked("notes.txt");

        expect(detectFixtureLeaks(cwd)).toEqual([]);
    });

    // test-contract: the warning has the complete stable message and exact display-boundary behavior.
    it("formats the complete warning without an extra continuation at the limit", () => {
        const leaks = Array.from({ length: 5 }, (_, index) => ({
            file: `src/fixtures/_orphan-${index}.ts`,
            referencedBy: "src/__tests__/fixture.test.ts",
        }));
        const warning = formatFixtureLeakWarning({ leaks });

        expect(warning).toBe(
            "[interlinked:fixture-leak] Stopping with 5 orphaned test fixture(s) under src/ — files whose basename appears in a writeFixture()/setupFixture()/createFixture() call but never got cleaned up:\n" +
                "  - src/fixtures/_orphan-0.ts  (created by src/__tests__/fixture.test.ts)\n" +
                "  - src/fixtures/_orphan-1.ts  (created by src/__tests__/fixture.test.ts)\n" +
                "  - src/fixtures/_orphan-2.ts  (created by src/__tests__/fixture.test.ts)\n" +
                "  - src/fixtures/_orphan-3.ts  (created by src/__tests__/fixture.test.ts)\n" +
                "  - src/fixtures/_orphan-4.ts  (created by src/__tests__/fixture.test.ts)\n" +
                "The test's afterAll/afterEach was supposed to rm these and didn't (the cleanup threw, the runner was killed mid-test, or the file path drifted from the helper). Either fix the cleanup helper or `rm` the listed files before stopping.",
        );
        expect(formatFixtureLeakWarning({ leaks: leaks.slice(0, 1), maxShown: 1 })).not.toContain("...and");
    });
});
