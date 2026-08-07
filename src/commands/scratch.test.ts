// Tests for the CLI-facing wrappers `scratchInitCommand` / `scratchStatusCommand`
// (`interlinked scratch init|status`). The pure provisioning logic
// (initScratchDir/scratchStatus) is already covered by
// src/commands/__tests__/scratch.test.ts; this file covers the console
// output / --json / --cwd-default branches those tests don't reach.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scratchInitCommand, scratchStatusCommand } from "./scratch.js";

let tmp: string;
let logSpy: ReturnType<typeof vi.spyOn>;

function printedLines(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls.map((c: unknown[]) => String(c[0]));
}

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "interlinked-scratch-cmd-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    logSpy.mockRestore();
});

describe("scratchInitCommand", () => {
    it("provisions scratch/ on disk and prints created-piece lines in human mode", () => {
        scratchInitCommand({ cwd: tmp });

        expect(existsSync(join(tmp, "scratch", "README.md"))).toBe(true);
        const gitignore = readFileSync(join(tmp, ".gitignore"), "utf8");
        expect(gitignore).toContain("scratch/*");

        const printed = printedLines(logSpy);
        expect(printed.some((l) => l.startsWith("created  "))).toBe(true);
        expect(printed.some((l) => l.includes("scratch/ ready"))).toBe(true);
    });

    it("prints machine-readable JSON with created/skipped arrays when --json is set", () => {
        scratchInitCommand({ cwd: tmp, json: true });

        expect(logSpy).toHaveBeenCalledTimes(1);
        const parsed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
        expect(parsed.created.length).toBeGreaterThan(0);
        expect(parsed.skipped).toEqual([]);
    });

    it("reports 'already fully provisioned' on a second run with nothing left to create", () => {
        scratchInitCommand({ cwd: tmp });
        logSpy.mockClear();

        scratchInitCommand({ cwd: tmp });

        const printed = printedLines(logSpy);
        expect(printed.some((l) => l.includes("already fully provisioned"))).toBe(true);
        expect(printed.some((l) => l.startsWith("exists   "))).toBe(true);
    });

    it("defaults to process.cwd() when no --cwd is given", () => {
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
        try {
            scratchInitCommand({});
            expect(existsSync(join(tmp, "scratch", "README.md"))).toBe(true);
        } finally {
            cwdSpy.mockRestore();
        }
    });
});

describe("scratchStatusCommand", () => {
    it("prints all-missing marks before provisioning, in human mode", () => {
        scratchStatusCommand({ cwd: tmp });

        const printed = printedLines(logSpy);
        expect(printed.some((l) => l.startsWith("✗ scratch/"))).toBe(true);
        expect(printed.some((l) => l.includes("Run `interlinked scratch init`"))).toBe(true);
    });

    it("prints all-present marks with no nudge after provisioning, in human mode", () => {
        scratchInitCommand({ cwd: tmp });
        logSpy.mockClear();

        scratchStatusCommand({ cwd: tmp });

        const printed = printedLines(logSpy);
        expect(printed.some((l) => l.startsWith("✓ scratch/"))).toBe(true);
        expect(printed.some((l) => l.startsWith("✓ scratch/README.md"))).toBe(true);
        expect(printed.some((l) => l.includes("Run `interlinked scratch init`"))).toBe(false);
    });

    it("prints machine-readable JSON status when --json is set", () => {
        scratchInitCommand({ cwd: tmp });
        logSpy.mockClear();

        scratchStatusCommand({ cwd: tmp, json: true });

        expect(logSpy).toHaveBeenCalledTimes(1);
        const parsed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
        expect(parsed).toEqual({
            dir: true,
            readme: true,
            gitignoreEntry: true,
            ignoreEntry: true,
        });
    });

    it("defaults to process.cwd() when no --cwd is given", () => {
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
        try {
            scratchStatusCommand({});
            const printed = printedLines(logSpy);
            expect(printed.some((l) => l.includes("scratch/"))).toBe(true);
        } finally {
            cwdSpy.mockRestore();
        }
    });
});
