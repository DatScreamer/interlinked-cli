import { describe, expect, it } from "vitest";
import { extractSpecFacts } from "./extract-facts.js";
import { computeXrefDrift, resolveRelativeTarget, type XrefContext } from "./ledger-xref.js";
import type { SpecFacts } from "./types.js";

function ctx(
	files: Record<string, string>,
	opts: { fileExists?: (abs: string) => boolean; skipped?: string[] } = {},
): XrefContext {
	const map = new Map<string, SpecFacts>();
	for (const [rel, content] of Object.entries(files)) {
		map.set(rel, extractSpecFacts(content, rel));
	}
	return {
		files: map,
		skippedPaths: new Set(opts.skipped ?? []),
		fileExists: opts.fileExists ?? ((): boolean => false),
		repoRoot: "/repo",
	};
}

describe("resolveRelativeTarget", () => {
	it("resolves ./ and nested source dirs to repo-relative form", () => {
		expect(resolveRelativeTarget("docs/a.md", "./b.md")).toBe("docs/b.md");
		expect(resolveRelativeTarget("docs/guide/a.md", "../b.md")).toBe("docs/b.md");
		expect(resolveRelativeTarget("a.md", "sub/c.md")).toBe("sub/c.md");
	});

	it("returns null when the path escapes the repo root", () => {
		expect(resolveRelativeTarget("a.md", "../../x.md")).toBeNull();
	});

	it("strips URL query/fragment and decodes %-escapes (sol-max #15)", () => {
		expect(resolveRelativeTarget("a.md", "guide.md?view=1#intro")).toBe("guide.md");
		expect(resolveRelativeTarget("a.md", "my%20file.md")).toBe("my file.md");
		// A malformed %-escape falls back to the raw (pre-decode) target.
		expect(resolveRelativeTarget("a.md", "bad%zz.md")).toBe("bad%zz.md");
	});
});

describe("computeXrefDrift", () => {
	it("flags a link to a heading the target file does not have", () => {
		const out = computeXrefDrift(
			ctx({
				"a.md": "# A\nSee [b](./b.md#target-heading).",
				"b.md": "# B\nno such heading",
			}),
		);
		expect(out).toEqual([
			expect.objectContaining({ kind: "xref_missing_anchor", file: "a.md" }),
		]);
	});

	it("stays silent when the anchor exists", () => {
		const out = computeXrefDrift(
			ctx({
				"a.md": "# A\nSee [b](./b.md#target-heading).",
				"b.md": "# B\n## Target Heading\ntext",
			}),
		);
		expect(out).toEqual([]);
	});

	it("reports a linked file that truly does not exist", () => {
		const out = computeXrefDrift(ctx({ "a.md": "# A\nSee [gone](./gone.md)." }));
		expect(out).toEqual([
			expect.objectContaining({ kind: "xref_missing_file", file: "a.md" }),
		]);
	});

	it("consults the filesystem predicate — an existing-but-unwalked target is not missing (sol-max #16)", () => {
		// gone from the ledger map, but fileExists says it is on disk (beyond the
		// walk's MAX_FILES / depth cap). Existence, not "did we walk it", decides.
		const out = computeXrefDrift(
			ctx(
				{ "a.md": "# A\nSee [guide](./vendor/guide.md)." },
				{ fileExists: (abs) => abs.endsWith("/vendor/guide.md") },
			),
		);
		expect(out).toEqual([]);
	});

	it("never reports a size/readability-skipped path as missing", () => {
		const out = computeXrefDrift(
			ctx({ "a.md": "# A\nSee [big](./big.md)." }, { skipped: ["big.md"] }),
		);
		expect(out).toEqual([]);
	});

	it("ignores links with no target file (bare anchors)", () => {
		const out = computeXrefDrift(ctx({ "a.md": "# A\nSee [here](#local)." }));
		expect(out).toEqual([]);
	});
});
