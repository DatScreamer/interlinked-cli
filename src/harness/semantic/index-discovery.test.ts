import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSemanticTeamConfig } from "./config.js";
import { discoverSemanticSources } from "./index-discovery.js";

let temporary = "";
let root = "";

beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-discovery-"));
    root = join(temporary, "repo");
    mkdirSync(join(root, "src"), { recursive: true });
});

afterEach(() => {
    rmSync(temporary, { recursive: true, force: true });
});

describe("semantic source discovery", () => {
    it("resolves symlinks and excludes a source file that escapes the repository", () => {
        const outside = join(temporary, "outside.ts");
        writeFileSync(outside, "export function escaped() { return 1; }\n");
        writeFileSync(join(root, "src", "local.ts"), "export function local() { return 1; }\n");
        symlinkSync(outside, join(root, "src", "escape.ts"));

        expect(discoverSemanticSources(root, defaultSemanticTeamConfig()).map((source) => source.relativePath)).toEqual([
            "src/local.ts",
        ]);
    });

    it("excludes tests by default and includes them only when requested", () => {
        writeFileSync(join(root, "src", "local.ts"), "export function local() { return 1; }\n");
        writeFileSync(join(root, "src", "local.test.ts"), "export function scenario() { return 1; }\n");

        expect(discoverSemanticSources(root, defaultSemanticTeamConfig(), false).map((source) => source.relativePath)).toEqual([
            "src/local.ts",
        ]);
        expect(discoverSemanticSources(root, defaultSemanticTeamConfig(), true).map((source) => source.relativePath)).toEqual([
            "src/local.test.ts",
            "src/local.ts",
        ]);
    });
});
