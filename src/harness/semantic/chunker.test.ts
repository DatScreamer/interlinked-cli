import { describe, expect, it } from "vitest";
import type { FunctionEmbeddingInput, LocalEmbeddingRuntime } from "./types.js";
import { chunkFunctionInput } from "./chunker.js";
import { EMBEDDING_MODEL_REGISTRY } from "./model-registry.js";

const baseManifest = EMBEDDING_MODEL_REGISTRY[0];
if (baseManifest === undefined) throw new Error("semantic test requires a registry model");

const runtime: LocalEmbeddingRuntime = {
    fingerprint: "test",
    async countTokens(input) {
        return input.length;
    },
    async embed(inputs) {
        return inputs.map(() => Float32Array.from([1, 0]));
    },
};

function input(code: string): FunctionEmbeddingInput {
    const prefix = "search_document: language: typescript\nsymbol: alpha\nkind: function\nsignature:\nalpha()\ndocumentation:\n\ncode:\n";
    return {
        language: "typescript",
        qualifiedName: "alpha",
        declarationKind: "function",
        signature: "alpha()",
        documentation: "",
        code,
        text: `${prefix}${code}`,
        inputHash: "input",
        contentHash: "content",
    };
}

describe("semantic function chunking", () => {
    it("uses one complete model input when it fits", async () => {
        const value = input("return 1;");
        const result = await chunkFunctionInput(value, { ...baseManifest, maxInputTokens: 500 }, runtime);
        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0]?.text).toBe(value.text);
        expect(result.chunks[0]?.nonOverlapStart).toBe(0);
        expect(result.chunks[0]?.nonOverlapEnd).toBe(value.code.length);
    });

    it("chunks over-context functions with exact non-overlap coverage", async () => {
        const code = Array.from({ length: 18 }, (_, index) => `statement_${index}();\n`).join("");
        const result = await chunkFunctionInput(input(code), { ...baseManifest, maxInputTokens: 150 }, runtime);
        expect(result.chunks.length).toBeGreaterThan(1);
        let expectedStart = 0;
        for (const chunk of result.chunks) {
            expect(chunk.modelTokens).toBeLessThanOrEqual(150);
            expect(chunk.nonOverlapStart).toBe(expectedStart);
            expect(chunk.sourceStart).toBeLessThanOrEqual(chunk.nonOverlapStart);
            expectedStart = chunk.nonOverlapEnd;
        }
        expect(expectedStart).toBe(code.length);
    });
});
