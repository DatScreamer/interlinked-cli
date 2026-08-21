import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/formatter.js", () => ({
    c: {
        bold: (value: string) => `<bold>${value}</bold>`,
        dim: (value: string) => `<dim>${value}</dim>`,
        green: (value: string) => `<green>${value}</green>`,
        yellow: (value: string) => `<yellow>${value}</yellow>`,
    },
    header: (value: string) => `<header>${value}</header>`,
    truncate: (value: string, maxLength: number) => value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`,
}));

import { renderFull, renderNormal } from "./search-render.js";
import type { SearchResult } from "./search-query.js";

function result(overrides: Partial<SearchResult> = {}): SearchResult {
    return {
        query: "alpha",
        engine: "native",
        matches: [{ file: "src/a.ts", line: 3, text: "alpha result" }],
        total: 1,
        truncated: false,
        searched_files: 2,
        elapsed_ms: 7,
        ...overrides,
    };
}

describe("search renderers", () => {
    // test-contract: singular match counts use the singular noun, while plural counts use the plural noun.
    it("renders singular and plural match counts", () => {
        expect(renderFull(result())).toContain("1 match · 2 files · 7ms");
        expect(renderFull(result({ total: 2 }))).toContain("2 matches · 2 files · 7ms");
        expect(renderNormal(result({ total: 2 }))).toContain("2 matches · 2 files · 7ms");
    });

    // test-contract: truncated results disclose exactly how many additional matches are omitted.
    it("renders truncation notices only for truncated results", () => {
        const truncated = renderFull(result({ total: 5, truncated: true }));
        expect(truncated).toContain("… 4 more matches (use --limit to see more)");
        expect(renderNormal(result({ total: 5, truncated: false }))).not.toContain("more matches");
    });

    // test-contract: ranking summaries classify exact 75% as high, exact 50% as medium, and lower percentages as dim.
    it("renders ranking threshold labels with their observable emphasis", () => {
        const rankings = [
            { file: "high.ts", termsMatched: 3, totalTerms: 4, matchedTerms: ["a"], matchCount: 1 },
            { file: "medium.ts", termsMatched: 1, totalTerms: 2, matchedTerms: ["a"], matchCount: 1 },
            { file: "low.ts", termsMatched: 1, totalTerms: 3, matchedTerms: ["a"], matchCount: 1 },
        ];
        const output = renderNormal(result(), rankings);
        expect(output).toContain("<green>75%</green> <bold>high.ts</bold>");
        expect(output).toContain("<yellow>50%</yellow> <bold>medium.ts</bold>");
        expect(output).toContain("<dim>33%</dim> <bold>low.ts</bold>");
    });
});
