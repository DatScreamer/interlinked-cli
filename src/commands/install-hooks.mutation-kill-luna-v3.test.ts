import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const installHooksMock = vi.hoisted(() => vi.fn(() => ({
    entries: [],
    skipped: [],
    manifest_path: "manifest.json",
    purged: 0,
    foreign: 0,
    orphans_cleaned: [],
})));
const writeModeMock = vi.hoisted(() => vi.fn());
const resolveHookBinaryPathMock = vi.hoisted(() => vi.fn(() => "/fallback/interlinked"));

vi.mock("../harness/installer.js", () => ({
    installHooks: installHooksMock,
    manifestPath: vi.fn(() => "manifest.json"),
}));
vi.mock("./mode.js", () => ({ writeMode: writeModeMock }));
vi.mock("../lib/hooks.js", () => ({ resolveHookBinaryPath: resolveHookBinaryPathMock }));

import { installHooksCommand, parseModeChoice } from "./install-hooks.js";

let tmp = "";

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "interlinked-install-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    installHooksMock.mockClear();
    writeModeMock.mockClear();
    resolveHookBinaryPathMock.mockClear();
});

afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
});

describe("parseModeChoice", () => {
    // test-contract: the highest displayed preset number selects the final preset.
    it("accepts the final preset number", () => {
        expect(parseModeChoice("3")).toBe("balanced");
    });

    // test-contract: blank input preserves the documented balanced default.
    it("defaults blank input to balanced", () => {
        expect(parseModeChoice("   ")).toBe("balanced");
    });

    // test-contract: non-finite numeric input cannot select a preset.
    it("falls back for non-numeric input", () => {
        expect(parseModeChoice("not-a-mode")).toBe("balanced");
    });
});

describe("installHooksCommand", () => {
    // test-contract: omitted runner and scope use all runners and the project scope.
    it("passes default runner and scope selections to the installer", async () => {
        await installHooksCommand({ json: true, binary: "/custom/binary" });

        expect(installHooksMock).toHaveBeenCalledWith({
            cwd: tmp,
            binaryPath: "/custom/binary",
            runners: [],
            scope: "project",
            dryRun: false,
        });
    });

    // test-contract: the literal all runner selection is equivalent to no runner filter.
    it("treats all as the all-runners selection", async () => {
        await installHooksCommand({ runner: "all", json: true });

        expect(installHooksMock).toHaveBeenCalledWith({
            cwd: tmp,
            binaryPath: "/fallback/interlinked",
            runners: [],
            scope: "project",
            dryRun: false,
        });
    });

    // test-contract: unknown scope falls back to project while a valid scope is preserved.
    it("uses project for an unknown scope", async () => {
        await installHooksCommand({ scope: "workspace", json: true });

        expect(installHooksMock).toHaveBeenCalledWith({
            cwd: tmp,
            binaryPath: "/fallback/interlinked",
            runners: [],
            scope: "project",
            dryRun: false,
        });
    });

    // test-contract: cloud opt-in writes enabled product metadata and the requested token source.
    it("writes guardrails cloud configuration", async () => {
        await installHooksCommand({
            cloud: "guardrails",
            tokenEnv: "INTERLINKED_TOKEN",
            json: true,
        });

        const config = JSON.parse(readFileSync(join(tmp, ".interlinked", "cloud.json"), "utf8")) as Record<string, unknown>;
        expect(config).toEqual(expect.objectContaining({
            enabled: true,
            product: "guardrails",
            token_source: { env: "INTERLINKED_TOKEN" },
            zdr: false,
        }));
        expect(existsSync(join(tmp, ".interlinked"))).toBe(true);
    });

    // test-contract: dry-run avoids persistent mode writes and cloud configuration.
    it("does not write mode or cloud files during dry-run", async () => {
        await installHooksCommand({
            dryRun: true,
            cloud: "agent-ci",
            mode: "strict",
            json: true,
        });

        expect(writeModeMock).not.toHaveBeenCalled();
        expect(existsSync(join(tmp, ".interlinked", "cloud.json"))).toBe(false);
    });
});
