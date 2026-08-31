import { describe, expect, it } from "vitest";
import { aggregateFunctionVectors, normalizeVector } from "./embed-function.js";

describe("semantic vector validation and aggregation", () => {
    it("normalizes a finite direct vector", () => {
        const vector = normalizeVector(Float32Array.from([3, 4]));
        expect(vector[0]).toBeCloseTo(0.6);
        expect(vector[1]).toBeCloseTo(0.8);
    });

    it("rejects zero-norm and non-finite vectors", () => {
        expect(() => normalizeVector(Float32Array.from([0, 0]))).toThrow(/zero or invalid norm/);
        expect(() => normalizeVector(Float32Array.from([1, Number.NaN]))).toThrow(/non-finite/);
        expect(() => normalizeVector(Float32Array.from([1, Number.POSITIVE_INFINITY]))).toThrow(/non-finite/);
    });

    it("rejects missing, extra, and dimension-mismatched chunk vectors", () => {
        expect(() => aggregateFunctionVectors([], [{ weightTokens: 1 }], 2)).toThrow(/omitted/);
        expect(() => aggregateFunctionVectors([Float32Array.from([1, 0])], [], 2)).toThrow(/omitted/);
        expect(() => aggregateFunctionVectors([Float32Array.from([1])], [{ weightTokens: 1 }], 2)).toThrow(/dimension/);
    });

    it("produces a normalized token-weighted centroid", () => {
        const vector = aggregateFunctionVectors(
            [Float32Array.from([1, 0]), Float32Array.from([0, 1])],
            [{ weightTokens: 3 }, { weightTokens: 4 }],
            2,
        );

        expect(vector[0]).toBeCloseTo(0.6);
        expect(vector[1]).toBeCloseTo(0.8);
        expect(Math.hypot(...vector)).toBeCloseTo(1);
    });
});
