import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSemanticTeamConfig, loadSemanticConfig } from "./config.js";

let temporary = "";

afterEach(() => {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    temporary = "";
});

describe("semantic configuration", () => {
    it("defaults to a disabled, exact pinned model reference", () => {
        const config = defaultSemanticTeamConfig();
        expect(config.enabled).toBe(false);
        expect(config.model).toMatch(/^[^@]+@[a-f0-9]{40}$/);
        expect(config.include).toEqual(["src/**"]);
    });

    it("rejects mutable aliases in committed team configuration", () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-config-"));
        mkdirSync(join(temporary, ".interlinked"));
        writeFileSync(join(temporary, ".interlinked", "semantic.json"), JSON.stringify({
            version: 1,
            enabled: true,
            model: "nomic-embed-text-v1.5-q4",
        }));
        expect(() => loadSemanticConfig(temporary)).toThrow(/exact registry revision/);
    });

    it("keeps remote runtime topology out of the local v1 schema", () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-config-"));
        mkdirSync(join(temporary, ".interlinked"));
        writeFileSync(join(temporary, ".interlinked", "semantic.local.json"), JSON.stringify({
            version: 1,
            device: "remote",
        }));
        expect(() => loadSemanticConfig(temporary)).toThrow(/auto or cpu/);
    });

    it("rejects remote fallback keys instead of silently accepting them", () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-config-"));
        mkdirSync(join(temporary, ".interlinked"));
        writeFileSync(join(temporary, ".interlinked", "semantic.local.json"), JSON.stringify({
            version: 1,
            remote_url: "https://embeddings.example",
        }));
        expect(() => loadSemanticConfig(temporary)).toThrow(/unsupported key.*remote_url/);
    });
});
