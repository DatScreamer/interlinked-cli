import { describe, expect, it, vi } from "vitest";
import { computeTypeScriptFunctionTokens } from "../function-tokens/typescript.js";
import type { HarnessEvent } from "../types.js";
import { checkCommitFunctionTokenGate } from "./commit-function-token-gate.js";

function functionWithTokens(count: number): string {
    const shell = "function target(){}";
    const base = computeTypeScriptFunctionTokens(shell, "src/example.ts")?.[0]?.canonicalTokens;
    if (base === undefined || base > count) throw new Error("invalid fixture token target");
    return `function target(){${";".repeat(count - base)}}`;
}

function event(command = "git commit -m test"): HarnessEvent {
    return {
        hook_event: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: "/repo",
        session_id: "session",
        agent_source: "codex",
        timestamp: "2026-08-30T00:00:00.000Z",
    };
}

function deps(before: string, after: string) {
    return {
        resolveRepoRoot: vi.fn(() => "/repo"),
        changedFiles: vi.fn(() => ["src/example.ts"]),
        gitShow: vi.fn((_root: string, ref: string) => {
            if (ref.startsWith("HEAD:")) return before;
            if (ref.startsWith(":")) return after;
            return null;
        }),
        readFile: vi.fn(() => after),
    };
}

describe("commit function-token backstop", () => {
    it("blocks a staged function that crosses from 500 to 501", () => {
        const result = checkCommitFunctionTokenGate(
            event(),
            deps(functionWithTokens(500), functionWithTokens(501)),
        );
        expect(result?.rule_id).toBe("commit-function-tokens-cap");
        expect(result?.reason).toContain("src/example.ts");
        expect(result?.reason).toContain("501");
    });

    it("allows existing over-cap debt to hold or shrink", () => {
        expect(
            checkCommitFunctionTokenGate(
                event(),
                deps(functionWithTokens(700), functionWithTokens(700)),
            ),
        ).toBeNull();
        expect(
            checkCommitFunctionTokenGate(
                event(),
                deps(functionWithTokens(700), functionWithTokens(501)),
            ),
        ).toBeNull();
    });

    it("blocks existing over-cap debt growing by one token", () => {
        const result = checkCommitFunctionTokenGate(
            event(),
            deps(functionWithTokens(700), functionWithTokens(701)),
        );
        expect(result?.reason).toContain("raised from 700");
    });

    it("reads worktree content for git commit -a", () => {
        const d = deps(functionWithTokens(500), functionWithTokens(501));
        const result = checkCommitFunctionTokenGate(event("git commit -am test"), d);
        expect(result?.decision).toBe("block");
        expect(d.readFile).toHaveBeenCalledWith("/repo/src/example.ts");
        expect(d.gitShow).not.toHaveBeenCalledWith("/repo", ":src/example.ts");
    });

    it("does no git work for a non-commit command", () => {
        const d = deps("", "");
        expect(checkCommitFunctionTokenGate(event("git status"), d)).toBeNull();
        expect(d.resolveRepoRoot).not.toHaveBeenCalled();
    });
});
