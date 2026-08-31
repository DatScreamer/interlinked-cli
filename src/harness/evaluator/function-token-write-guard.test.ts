import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeTypeScriptFunctionTokens } from "../function-tokens/typescript.js";
import {
    checkFunctionTokenWrite,
    resetFunctionTokenWarningsForTesting,
} from "./function-token-write-guard.js";

function functionWithTokens(count: number, name = "target"): string {
    const shell = `function ${name}(){}`;
    const base = computeTypeScriptFunctionTokens(shell, "example.ts")?.[0]?.canonicalTokens;
    if (base === undefined || base > count) throw new Error("invalid token fixture target");
    return `function ${name}(){${";".repeat(count - base)}}`;
}

describe("function-token write gate", () => {
    let cwd: string;
    let file: string;

    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "function-token-gate-"));
        mkdirSync(join(cwd, "src"), { recursive: true });
        file = join(cwd, "src", "example.ts");
        resetFunctionTokenWarningsForTesting();
    });

    afterEach(() => {
        rmSync(cwd, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it("allows exactly 500 canonical tokens and blocks 501", () => {
        expect(checkFunctionTokenWrite({ file_path: file, content: functionWithTokens(500) }, cwd)).toBeNull();
        const blocked = checkFunctionTokenWrite(
            { file_path: file, content: functionWithTokens(501) },
            cwd,
        );
        expect(blocked?.block).toContain("501");
        expect(blocked?.block).toContain("500-token cap");
        expect(blocked?.block).not.toContain("per edit");
    });

    it("allows existing over-cap debt to hold or shrink and blocks growth", () => {
        writeFileSync(file, functionWithTokens(700));
        expect(checkFunctionTokenWrite({ file_path: file, content: functionWithTokens(700) }, cwd)).toBeNull();
        expect(checkFunctionTokenWrite({ file_path: file, content: functionWithTokens(501) }, cwd)).toBeNull();
        expect(checkFunctionTokenWrite({ file_path: file, content: functionWithTokens(701) }, cwd)?.block).toContain("raised from 700");
    });

    it("allows unrestricted growth while the end state remains under the cap", () => {
        writeFileSync(file, functionWithTokens(100));
        expect(checkFunctionTokenWrite({ file_path: file, content: functionWithTokens(499) }, cwd)).toBeNull();
    });

    it("honors a tightened per-repository cap", () => {
        mkdirSync(join(cwd, ".interlinked"), { recursive: true });
        writeFileSync(
            join(cwd, ".interlinked", "metric-caps.json"),
            JSON.stringify({ max_function_tokens: 250 }),
        );
        expect(checkFunctionTokenWrite({ file_path: file, content: functionWithTokens(251) }, cwd)?.block).toContain("250-token cap");
    });

    it("fails open visibly and once per unsupported language", () => {
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const goFile = join(cwd, "src", "example.go");
        const input = { file_path: goFile, content: "package p\nfunc f() {}\n" };
        expect(checkFunctionTokenWrite(input, cwd)).toBeNull();
        expect(checkFunctionTokenWrite(input, cwd)).toBeNull();
        expect(stderr).toHaveBeenCalledTimes(1);
        expect(String(stderr.mock.calls[0]?.[0])).toContain("function-tokens:not-measured");
    });

    it("fails open visibly for another cappable source extension", () => {
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const shellFile = join(cwd, "src", "script.sh");

        expect(checkFunctionTokenWrite({ file_path: shellFile, content: "main() { echo ok; }\n" }, cwd)).toBeNull();

        expect(stderr).toHaveBeenCalledWith(expect.stringContaining("sh source was allowed"));
    });
});
