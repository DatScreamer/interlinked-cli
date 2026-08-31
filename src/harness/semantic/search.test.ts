import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexedFunctionRow, LoadedSemanticIndex, SemanticIndexMeta } from "./types.js";

const mocks = vi.hoisted(() => ({
    status: vi.fn(),
    loadIndex: vi.fn(),
    embed: vi.fn(),
}));

vi.mock("./index-status.js", () => ({ semanticIndexStatus: mocks.status }));
vi.mock("./vector-store.js", () => ({ loadSemanticIndex: mocks.loadIndex }));
vi.mock("./config.js", () => ({
    loadSemanticConfig: () => ({
        manifest: { queryPrefix: "search_query: " },
        local: {},
    }),
}));
vi.mock("./runtime.js", () => ({
    createLlamaRuntime: async () => ({ fingerprint: "fingerprint", embed: mocks.embed }),
}));

import { semanticSearch, semanticSimilar } from "./search.js";

const meta: SemanticIndexMeta = {
    schemaVersion: 1,
    modelFingerprint: "fingerprint",
    canonicalTokenizer: "interlinked-code-v1",
    repositoryIdentity: "repo",
    sourceHash: "source",
    functionCount: 4,
    vectorCount: 4,
    dimension: 2,
    byteOrder: "little-endian",
    functionsSha256: "functions",
    functionsBytes: 1,
    vectorsSha256: "vectors",
    vectorsBytes: 32,
    buildStartedAt: "2026-08-30T00:00:00.000Z",
    buildCompletedAt: "2026-08-30T00:00:01.000Z",
    direct: 4,
    aggregated: 0,
    notIndexed: 0,
    unsupported: 0,
    includeTests: false,
    aggregationVersion: "weighted-centroid-v1",
    overlapPercent: 10,
    experimental: true,
};

function row(id: string, symbol: string, line: number, endLine: number, vectorOffset: number): IndexedFunctionRow {
    return {
        id,
        file: "src/a.ts",
        qualifiedName: symbol,
        declarationKind: "function",
        language: "typescript",
        line,
        endLine,
        canonicalTokens: 20,
        modelTokens: 30,
        contentHash: `${id}-content`,
        inputHash: `${id}-input`,
        chunkCount: 1,
        chunkRanges: [[0, 10]],
        vectorOffset,
    };
}

const index: LoadedSemanticIndex = {
    generation: "generation",
    meta,
    rows: [
        row("outer", "outer", 1, 20, 0),
        row("inner", "outer.inner", 5, 10, 1),
        row("related", "related", 30, 35, 2),
        row("distant", "distant", 40, 45, 3),
    ],
    vectors: Float32Array.from([
        0, 1,
        1, 0,
        0.8, 0.6,
        -1, 0,
    ]),
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.status.mockResolvedValue({
        schemaVersion: 1,
        state: "current",
        generation: "generation",
        modelFingerprint: "fingerprint",
        reason: null,
        meta,
    });
    mocks.loadIndex.mockReturnValue(index);
    mocks.embed.mockResolvedValue([Float32Array.from([1, 0])]);
});

describe("semantic exact cosine search", () => {
    it("prefixes queries, ranks descending, and breaks ties deterministically", async () => {
        const response = await semanticSearch("/repo", "find the related implementation", { top: 3 });
        expect(mocks.embed).toHaveBeenCalledWith(["search_query: find the related implementation"]);
        expect(response.results.map((result) => result.symbol)).toEqual([
            "outer.inner",
            "related",
            "outer",
        ]);
        expect(response.results[0]?.score).toBeCloseTo(1);
    });

    it("uses the innermost containing function as the similar-query vector", async () => {
        const response = await semanticSimilar("/repo", "src/a.ts", 6, { top: 3 });
        expect(response.results.map((result) => result.symbol)).toEqual([
            "related",
            "outer",
            "distant",
        ]);
        expect(response.results.some((result) => result.symbol === "outer.inner")).toBe(false);
        expect(mocks.embed).not.toHaveBeenCalled();
    });

    it("allows a stale but verified generation and labels every result", async () => {
        mocks.status.mockResolvedValue({
            schemaVersion: 1,
            state: "stale",
            generation: "generation",
            modelFingerprint: "fingerprint",
            reason: "source changed",
            meta,
        });
        const response = await semanticSearch("/repo", "query", { top: 1 });
        expect(response.stale).toBe(true);
        expect(response.results[0]?.stale).toBe(true);
    });

    it("refuses corrupt generations instead of partially searching them", async () => {
        mocks.status.mockResolvedValue({
            schemaVersion: 1,
            state: "corrupt",
            generation: null,
            modelFingerprint: "fingerprint",
            reason: "hash mismatch",
            meta: null,
        });
        await expect(semanticSearch("/repo", "query")).rejects.toThrow(/not queryable \(corrupt\)/);
        expect(mocks.loadIndex).not.toHaveBeenCalled();
    });
});
