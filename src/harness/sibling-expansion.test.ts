import { describe, expect, it } from "vitest";
import {
	DEFAULT_TRIGGERS,
	type FileReader,
	type SiblingTrigger,
	type TrigramIndexLike,
	expandSiblings,
} from "./sibling-expansion.js";

function makeIndex(byAnchor: Record<string, string[]>): TrigramIndexLike {
	return {
		queryCandidatePaths(_required) {
			// Test fake: ignore trigrams, return all paths the test pre-staged.
			return Object.values(byAnchor).flat();
		},
	};
}

function makeReader(files: Record<string, string>): FileReader {
	return {
		read(path) {
			return files[path];
		},
	};
}

describe("expandSiblings", () => {
	it("returns no siblings when there are no triggers", () => {
		const out = expandSiblings({
			triggers: [],
			index: makeIndex({ "as any": ["src/a.ts"] }),
			reader: makeReader({ "src/a.ts": "const x = foo as any;" }),
			cwd: "/repo",
		});
		expect(out).toEqual([]);
	});

	it("ignores triggers with no matching spec", () => {
		const out = expandSiblings({
			triggers: [{ name: "unknown_check", file: "/repo/src/origin.ts" }],
			index: makeIndex({ "as any": ["src/sibling.ts"] }),
			reader: makeReader({ "src/sibling.ts": "const y = a as any;" }),
			cwd: "/repo",
		});
		expect(out).toEqual([]);
	});

	it("emits sibling rows for as_any_ratchet matches in other files", () => {
		const out = expandSiblings({
			triggers: [{ name: "as_any_ratchet", file: "/repo/src/origin.ts" }],
			index: makeIndex({ "as any": ["src/foo.ts", "src/bar.ts"] }),
			reader: makeReader({
				"src/foo.ts": "const f = thing as any;\n",
				"src/bar.ts": "const b = other as any;\nconst c = 1;\n",
			}),
			cwd: "/repo",
		});
		expect(out.length).toBe(2);
		const files = out.map((s) => s.file).sort();
		expect(files).toEqual(["src/bar.ts", "src/foo.ts"]);
		expect(out.every((s) => s.siblingRuleId === "as_any_sibling")).toBe(true);
	});

	it("excludes the originating file from sibling rows", () => {
		const out = expandSiblings({
			triggers: [{ name: "as_any_ratchet", file: "/repo/src/origin.ts" }],
			index: makeIndex({ "as any": ["src/origin.ts", "src/sibling.ts"] }),
			reader: makeReader({
				"src/origin.ts": "const x = foo as any;\n",
				"src/sibling.ts": "const y = bar as any;\n",
			}),
			cwd: "/repo",
		});
		expect(out.length).toBe(1);
		expect(out[0].file).toBe("src/sibling.ts");
	});

	it("caps siblings per trigger to maxSiblingsPerTrigger", () => {
		const candidates = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
		const files: Record<string, string> = {};
		for (const c of candidates) files[c] = "const x = z as any;";
		const out = expandSiblings({
			triggers: [{ name: "as_any_ratchet", file: "/repo/src/origin.ts" }],
			index: makeIndex({ "as any": candidates }),
			reader: makeReader(files),
			cwd: "/repo",
			maxSiblingsPerTrigger: 2,
		});
		expect(out.length).toBe(2);
	});

	it("dedupes triggers with the same name across multiple findings", () => {
		const out = expandSiblings({
			triggers: [
				{ name: "as_any_ratchet", file: "/repo/src/origin1.ts" },
				{ name: "as_any_ratchet", file: "/repo/src/origin2.ts" },
			],
			index: makeIndex({ "as any": ["src/sibling.ts"] }),
			reader: makeReader({ "src/sibling.ts": "const z = q as any;\n" }),
			cwd: "/repo",
		});
		// Only one sibling row, even though two triggers fired.
		expect(out.length).toBe(1);
	});

	it("skips candidates whose content the regex does not actually match", () => {
		const out = expandSiblings({
			triggers: [{ name: "as_any_ratchet", file: "/repo/src/origin.ts" }],
			index: makeIndex({ "as any": ["src/false-positive.ts"] }),
			reader: makeReader({
				// String contains "as any" but inside a comment / string —
				// expandSiblings runs the literal regex so this does match;
				// we test the *non-matching* case where trigram says "maybe"
				// but the regex says "no".
				"src/false-positive.ts": "const note = 'previously cast';",
			}),
			cwd: "/repo",
		});
		expect(out).toEqual([]);
	});

	it("supports custom triggers via triggerSpecs", () => {
		const custom: SiblingTrigger = {
			triggerName: "custom_test_check",
			anchor: "danger",
			pattern: /\bdanger\b/g,
			siblingRuleId: "custom_sibling",
			messageTemplate: (file, line) => `custom finding at ${file}:${line}`,
		};
		const out = expandSiblings({
			triggers: [{ name: "custom_test_check", file: "/repo/src/origin.ts" }],
			index: makeIndex({ danger: ["src/risky.ts"] }),
			reader: makeReader({ "src/risky.ts": "const x = danger;\n" }),
			cwd: "/repo",
			triggerSpecs: [custom],
		});
		expect(out.length).toBe(1);
		expect(out[0].siblingRuleId).toBe("custom_sibling");
	});

	it("DEFAULT_TRIGGERS contains as_any_ratchet and unvalidated_json_boundary", () => {
		const names = DEFAULT_TRIGGERS.map((t) => t.triggerName);
		expect(names).toContain("as_any_ratchet");
		expect(names).toContain("unvalidated_json_boundary");
	});

	// FP refinement (2026-05): the trigram index covers the whole repo, so
	// a `JSON.parse(...)` / `as any` shown inside a fenced code block in a
	// design doc (`docs/design/*.md`) was returned as a sibling candidate
	// and flagged. Doc-file snippets are illustration, not lintable source.

	it("does NOT emit a sibling for JSON.parse inside a .md doc", () => {
		const out = expandSiblings({
			triggers: [{ name: "unvalidated_json_boundary", file: "/repo/src/origin.ts" }],
			index: makeIndex({ "JSON.parse": ["docs/design/data-flow.md"] }),
			reader: makeReader({
				"docs/design/data-flow.md": "```ts\nconst x = JSON.parse(raw);\n```",
			}),
			cwd: "/repo",
		});
		expect(out).toEqual([]);
	});

	it("does NOT emit a sibling for as any inside a .mdx / .markdown doc", () => {
		const out = expandSiblings({
			triggers: [{ name: "as_any_ratchet", file: "/repo/src/origin.ts" }],
			index: makeIndex({
				"as any": ["docs/plans/roadmap.mdx", "docs/notes.markdown"],
			}),
			reader: makeReader({
				"docs/plans/roadmap.mdx": "const x = thing as any;",
				"docs/notes.markdown": "const y = other as any;",
			}),
			cwd: "/repo",
		});
		expect(out).toEqual([]);
	});

	it("excludes doc files but STILL emits siblings for real source files", () => {
		// Mixed candidate list: the .md must be skipped, the .ts must fire.
		const out = expandSiblings({
			triggers: [{ name: "unvalidated_json_boundary", file: "/repo/src/origin.ts" }],
			index: makeIndex({
				"JSON.parse": ["docs/design/foo.md", "src/parser.ts"],
			}),
			reader: makeReader({
				"docs/design/foo.md": "```js\nJSON.parse(snippet);\n```",
				"src/parser.ts": "const cfg = JSON.parse(body);\n",
			}),
			cwd: "/repo",
		});
		expect(out.length).toBe(1);
		expect(out[0].file).toBe("src/parser.ts");
	});

	it("doc-file exclusion is case-insensitive (.MD / .Markdown)", () => {
		const out = expandSiblings({
			triggers: [{ name: "as_any_ratchet", file: "/repo/src/origin.ts" }],
			index: makeIndex({ "as any": ["docs/README.MD", "docs/Notes.Markdown"] }),
			reader: makeReader({
				"docs/README.MD": "const x = a as any;",
				"docs/Notes.Markdown": "const y = b as any;",
			}),
			cwd: "/repo",
		});
		expect(out).toEqual([]);
	});

	it("STILL emits siblings for non-doc source even when path contains 'docs'", () => {
		// A .ts file living under a docs/ directory is still source code —
		// only the doc-file *extension* triggers the exclusion, not the path.
		const out = expandSiblings({
			triggers: [{ name: "as_any_ratchet", file: "/repo/src/origin.ts" }],
			index: makeIndex({ "as any": ["docs/examples/sample.ts"] }),
			reader: makeReader({ "docs/examples/sample.ts": "const x = z as any;\n" }),
			cwd: "/repo",
		});
		expect(out.length).toBe(1);
		expect(out[0].file).toBe("docs/examples/sample.ts");
	});
});
