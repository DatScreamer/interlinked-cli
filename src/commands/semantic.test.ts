import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { semanticModelsAction, semanticStatusAction } from "./semantic.js";

let temporary = "";

beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-command-"));
    process.env.INTERLINKED_MODEL_CACHE = join(temporary, "model-cache");
});

afterEach(() => {
    delete process.env.INTERLINKED_MODEL_CACHE;
    rmSync(temporary, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("semantic command network boundary", () => {
    it("models and status never acquire a missing model", async () => {
        const fetchMock = vi.fn(async () => {
            throw new Error("ordinary semantic commands must not use the network");
        });
        vi.stubGlobal("fetch", fetchMock);
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        expect(await semanticModelsAction({ json: true })).toBe(0);
        expect(await semanticStatusAction({ cwd: temporary, json: true })).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
