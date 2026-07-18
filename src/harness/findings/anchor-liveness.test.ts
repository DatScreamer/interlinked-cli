// Companion tests for anchor-liveness.ts (LG-6). Positives prove each verdict
// class and the ingest→merge carry; negatives prove fail-open on legacy rows,
// ambiguity, and unreadable files — and that nothing here mutates state.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureAnchor, classifyAnchor } from "./anchor-liveness.js";
import { type Finding, makeFinding, upsertFinding } from "./corpus.js";

let dir: string;
let file: string;

const CONTENT = [
	"import { a } from './a';",
	"export function target(x: number) {",
	"  return x + 1;",
	"}",
	"export const other = 2;",
	"",
].join("\n");

function anchoredFinding(line: number): Finding {
	return makeFinding(
		{
			bug_class: "review_off_by_one",
			message: "off by one in target",
			file,
			line,
			source_runner: "test-reviewer",
			now: "2026-07-17T00:00:00.000Z",
		},
		dir,
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "anchor-live-"));
	file = join(dir, "mod.ts");
	writeFileSync(file, CONTENT);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("captureAnchor", () => {
	it("captures span hash + verbatim context around the line", () => {
		const f = captureAnchor(anchoredFinding(3), dir);
		expect(f.anchor_span_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(f.anchor_context).toEqual([
			"export function target(x: number) {",
			"  return x + 1;",
			"}",
		]);
	});

	it("no-ops for unanchored findings and lines past EOF", () => {
		const unanchored = makeFinding(
			{ bug_class: "review_x", message: "m", source_runner: "r" },
			dir,
		);
		expect(captureAnchor(unanchored, dir).anchor_span_sha256).toBeUndefined();
		expect(captureAnchor(anchoredFinding(999), dir).anchor_span_sha256).toBeUndefined();
	});

	it("upsert keeps an existing anchor over a re-ingested one (carryAnchor)", () => {
		const first = upsertFinding(captureAnchor(anchoredFinding(3), dir), dir, {
			mirrorGlobal: false,
		});
		// Same structural site re-ingested after the file changed — the merged
		// row must keep the ORIGINAL anchor, not the drifted re-capture.
		writeFileSync(file, CONTENT.replace("x + 1", "x + 2"));
		const merged = upsertFinding(captureAnchor(anchoredFinding(3), dir), dir, {
			mirrorGlobal: false,
		});
		expect(merged.anchor_span_sha256).toBe(first.anchor_span_sha256);
	});
});

describe("classifyAnchor", () => {
	it("live: content unchanged at the recorded line", () => {
		const f = captureAnchor(anchoredFinding(3), dir);
		expect(classifyAnchor(f, dir)).toEqual({ state: "live" });
	});

	it("moved: unique context relocated by insertions above", () => {
		const f = captureAnchor(anchoredFinding(3), dir);
		writeFileSync(file, `// new header\n// more header\n${CONTENT}`);
		expect(classifyAnchor(f, dir)).toEqual({ state: "moved", newLine: 5 });
	});

	it("moved: survives a reindent via whitespace-normalized relocation", () => {
		const f = captureAnchor(anchoredFinding(3), dir);
		const reindented = CONTENT.split("\n")
			.map((l) => (l.startsWith("  ") ? `    ${l.trim()}` : l))
			.join("\n");
		writeFileSync(file, `// header\n${reindented}`);
		expect(classifyAnchor(f, dir)).toEqual({ state: "moved", newLine: 4 });
	});

	it("drifted: the anchored content itself changed", () => {
		const f = captureAnchor(anchoredFinding(3), dir);
		writeFileSync(file, CONTENT.replace("return x + 1;", "return x - 1;"));
		expect(classifyAnchor(f, dir).state).toBe("drifted");
	});

	it("drifted: ambiguous relocation (context duplicated) stays conservative", () => {
		const f = captureAnchor(anchoredFinding(3), dir);
		const block = "export function target(x: number) {\n  return x + 1;\n}\n";
		// Two pad lines shift the first copy off the recorded line (no positional
		// hash match), and the duplicated block makes relocation two-way ambiguous.
		writeFileSync(file, `// pad\n// pad2\n${block}\n// pad3\n${block}`);
		expect(classifyAnchor(f, dir).state).toBe("drifted");
	});

	it("gone: the file was deleted", () => {
		const f = captureAnchor(anchoredFinding(3), dir);
		rmSync(file);
		expect(classifyAnchor(f, dir)).toEqual({ state: "gone" });
	});

	it("unverified: legacy rows without a captured anchor fail open", () => {
		expect(classifyAnchor(anchoredFinding(3), dir)).toEqual({ state: "unverified" });
	});
});
