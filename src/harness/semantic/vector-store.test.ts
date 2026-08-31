import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IndexedFunctionRow } from "./types.js";
import { loadSemanticIndex, publishSemanticGeneration, semanticIndexRoot } from "./vector-store.js";

let temporary = "";

afterEach(() => {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    temporary = "";
});

const row: IndexedFunctionRow = {
    id: "alpha-id",
    file: "src/alpha.ts",
    qualifiedName: "alpha",
    declarationKind: "function",
    language: "typescript",
    line: 1,
    endLine: 3,
    canonicalTokens: 9,
    modelTokens: 15,
    contentHash: "content",
    inputHash: "input",
    chunkCount: 1,
    chunkRanges: [[0, 20]],
    vectorOffset: 0,
};

function metadata() {
    return {
        modelFingerprint: "fingerprint",
        canonicalTokenizer: "interlinked-code-v1",
        repositoryIdentity: "repository",
        sourceHash: "source",
        dimension: 2,
        buildStartedAt: "2026-08-30T00:00:00.000Z",
        direct: 1,
        aggregated: 0,
        notIndexed: 0,
        unsupported: 0,
        includeTests: false,
        experimental: true,
    };
}

function generationDirectory(root: string, generation: string): string {
    return join(semanticIndexRoot(root), "generations", generation);
}

function digest(data: string | Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

describe("semantic vector generations", () => {
    it("publishes one complete generation and reads its verified vector", () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-store-"));
        const published = publishSemanticGeneration(temporary, [row], [Float32Array.from([0.6, 0.8])], metadata());
        const loaded = loadSemanticIndex(temporary, "fingerprint");
        expect(loaded.generation).toBe(published.generation);
        expect(loaded.rows).toEqual([row]);
        expect([...loaded.vectors]).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)]);
    });

    it("rejects vector corruption instead of returning partial results", () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-store-"));
        const published = publishSemanticGeneration(temporary, [row], [Float32Array.from([1, 0])], metadata());
        appendFileSync(join(semanticIndexRoot(temporary), "generations", published.generation, "vectors.f32"), Buffer.from([0]));
        expect(() => loadSemanticIndex(temporary)).toThrow(/aligned|integrity/);
    });

    it("rejects function-row hash and row-count corruption", () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-store-"));
        const published = publishSemanticGeneration(temporary, [row], [Float32Array.from([1, 0])], metadata());
        const directory = generationDirectory(temporary, published.generation);
        appendFileSync(join(directory, "functions.jsonl"), "\n");
        expect(() => loadSemanticIndex(temporary)).toThrow(/metadata failed integrity/);

        const original = `${JSON.stringify(row)}\n`;
        writeFileSync(join(directory, "functions.jsonl"), original);
        const meta: Record<string, unknown> = JSON.parse(readFileSync(join(directory, "meta.json"), "utf8"));
        meta.functionsSha256 = digest(original);
        meta.functionsBytes = Buffer.byteLength(original);
        meta.functionCount = 2;
        writeFileSync(join(directory, "meta.json"), JSON.stringify(meta));
        expect(() => loadSemanticIndex(temporary)).toThrow(/row and vector counts disagree/);
    });

    it("rejects a hash-valid out-of-order offset", () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-store-"));
        const published = publishSemanticGeneration(temporary, [row], [Float32Array.from([1, 0])], metadata());
        const directory = generationDirectory(temporary, published.generation);
        const changed = `${JSON.stringify({ ...row, vectorOffset: 1 })}\n`;
        const meta: Record<string, unknown> = JSON.parse(readFileSync(join(directory, "meta.json"), "utf8"));
        meta.functionsSha256 = digest(changed);
        meta.functionsBytes = Buffer.byteLength(changed);
        writeFileSync(join(directory, "functions.jsonl"), changed);
        writeFileSync(join(directory, "meta.json"), JSON.stringify(meta));
        expect(() => loadSemanticIndex(temporary)).toThrow(/offset is out of order/);
    });

    it("rejects a hash-valid non-finite stored vector", () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-store-"));
        const published = publishSemanticGeneration(temporary, [row], [Float32Array.from([1, 0])], metadata());
        const directory = generationDirectory(temporary, published.generation);
        const vectors = readFileSync(join(directory, "vectors.f32"));
        vectors.writeFloatLE(Number.NaN, 0);
        const meta: Record<string, unknown> = JSON.parse(readFileSync(join(directory, "meta.json"), "utf8"));
        meta.vectorsSha256 = digest(vectors);
        writeFileSync(join(directory, "vectors.f32"), vectors);
        writeFileSync(join(directory, "meta.json"), JSON.stringify(meta));
        expect(() => loadSemanticIndex(temporary)).toThrow(/non-finite/);
    });

    it("rejects a different active fingerprint", () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-store-"));
        publishSemanticGeneration(temporary, [row], [Float32Array.from([1, 0])], metadata());
        expect(() => loadSemanticIndex(temporary, "other-fingerprint")).toThrow(/fingerprint/);
    });
});
