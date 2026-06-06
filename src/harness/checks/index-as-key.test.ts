// Behavioral tests for the React index-as-key detector.
// Asserts real outputs (matched lines + message text) and every skip branch.
// No tombstone assertions — every test pins concrete behavior.
//
// `checkIndexAsKey` itself does no fs / network / time access. The only
// indirect fs touch is via `isTestFile` -> `isHarnessInternalDataFile` ->
// `resolveInterlinkedCliPackageRoot`, which is driven deterministically here
// through the exported `__setPackageRootForTesting` seam (set to null in a
// beforeEach so the harness-internal-data exemption never fires and path-based
// test detection is the only thing in play). That keeps the suite hermetic
// without touching the real filesystem.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkIndexAsKey } from "./index-as-key.js";
import { __setPackageRootForTesting } from "./shared.js";

beforeEach(() => {
	// Pin the package-root cache to null so isHarnessInternalDataFile()
	// fail-closes (never exempts) and only genuine path-based test detection
	// influences the test-file branch. Deterministic, no fs reads.
	__setPackageRootForTesting(null);
});

afterEach(() => {
	// Reset the cache to "unresolved" so we don't leak state across files.
	__setPackageRootForTesting(undefined);
});

describe("checkIndexAsKey — file-gating branches", () => {
	it("returns [] for a strict test file (isTestFile true) even with a violation", () => {
		const content = `items.map((item, i) => <li key={i}>{item}</li>);`;
		// .test.tsx is a strict test file regardless of package root.
		expect(checkIndexAsKey(content, "src/components/List.test.tsx")).toEqual([]);
	});

	it("returns [] for a spec file", () => {
		const content = `items.map((item, idx) => <li key={idx}>{item}</li>);`;
		expect(checkIndexAsKey(content, "src/components/List.spec.jsx")).toEqual([]);
	});

	it("returns [] for files under a __tests__/ directory", () => {
		const content = `items.map((item, i) => <li key={i}>{item}</li>);`;
		expect(checkIndexAsKey(content, "src/__tests__/List.tsx")).toEqual([]);
	});

	it("returns [] for non-tsx/jsx extensions (.ts) even with a key={i}", () => {
		const content = `items.map((item, i) => <li key={i}>{item}</li>);`;
		expect(checkIndexAsKey(content, "src/components/List.ts")).toEqual([]);
	});

	it("returns [] for a .js file (not jsx)", () => {
		const content = `items.map((item, i) => <li key={i}>{item}</li>);`;
		expect(checkIndexAsKey(content, "src/components/List.js")).toEqual([]);
	});

	it("returns [] for a file with no extension", () => {
		const content = `items.map((item, i) => <li key={i}>{item}</li>);`;
		expect(checkIndexAsKey(content, "Makefile")).toEqual([]);
	});

	it("runs on .tsx files (positive control)", () => {
		const content = `items.map((item, i) => <li key={i}>{item}</li>);`;
		expect(checkIndexAsKey(content, "src/components/List.tsx")).toHaveLength(1);
	});

	it("runs on .jsx files (positive control)", () => {
		const content = `items.map((item, i) => <li key={i}>{item}</li>);`;
		expect(checkIndexAsKey(content, "src/components/List.jsx")).toHaveLength(1);
	});

	it("is case-insensitive on the extension (.TSX)", () => {
		// getExtension lowercases, so .TSX is treated as .tsx.
		const content = `items.map((item, i) => <li key={i}>{item}</li>);`;
		expect(checkIndexAsKey(content, "src/components/List.TSX")).toHaveLength(1);
	});
});

describe("checkIndexAsKey — direct variable pattern", () => {
	it.each([["i"], ["idx"], ["index"], ["k"]])(
		"fires on key={%s}",
		(variable) => {
			const content = `arr.map((x, ${variable}) => <li key={${variable}}>{x}</li>);`;
			const matches = checkIndexAsKey(content, "src/A.tsx");
			expect(matches).toHaveLength(1);
			expect(matches[0]?.line).toBe(1);
		},
	);

	it("does NOT fire on a stable identifier key={item.id}", () => {
		const content = `arr.map((item) => <li key={item.id}>{item.name}</li>);`;
		expect(checkIndexAsKey(content, "src/A.tsx")).toEqual([]);
	});

	it("does NOT fire on a multi-char identifier that merely starts with i (key={itemId})", () => {
		const content = `arr.map((item) => <li key={itemId}>{item.name}</li>);`;
		expect(checkIndexAsKey(content, "src/A.tsx")).toEqual([]);
	});

	it("reports the correct 1-based line number and includes the advisory text", () => {
		const content = [
			"export function List() {",
			"  return items.map((item, i) => (",
			"    <li key={i}>{item}</li>",
			"  ));",
			"}",
		].join("\n");
		const matches = checkIndexAsKey(content, "src/List.tsx");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(3); // the `<li key={i}>` line
		expect(matches[0]?.text).toContain(
			"index used as key — breaks reconciliation on reorder. Use a stable identifier",
		);
		// The trimmed source line is appended after the advisory bracket.
		expect(matches[0]?.text).toContain("<li key={i}>{item}</li>");
	});

	it("truncates the appended source line to 100 chars", () => {
		const padding = "x".repeat(200);
		// key={i} plus a long trailing comment, all on one trimmed line.
		const content = `<li key={i}>${padding}</li>`;
		const matches = checkIndexAsKey(content, "src/A.tsx");
		expect(matches).toHaveLength(1);
		const prefix = "[index used as key — breaks reconciliation on reorder. Use a stable identifier] ";
		const appended = matches[0]?.text.slice(prefix.length) ?? "";
		expect(appended).toHaveLength(100);
	});

	it("emits one match per offending line across the file", () => {
		const content = [
			"const a = list.map((x, i) => <li key={i}>{x}</li>);",
			"const placeholderText = 1;", // not a key, ignored
			"const b = other.map((y, idx) => <li key={idx}>{y}</li>);",
		].join("\n");
		const matches = checkIndexAsKey(content, "src/A.tsx");
		expect(matches).toHaveLength(2);
		expect(matches.map((m) => m.line)).toEqual([1, 3]);
	});
});

describe("checkIndexAsKey — template literal pattern", () => {
	it.each([["i"], ["idx"], ["index"], ["k"]])(
		"fires on key={`item-${%s}`}",
		(variable) => {
			const content = "rows.map((r, " + variable + ") => <li key={`item-${" + variable + "}`}>{r}</li>);";
			const matches = checkIndexAsKey(content, "src/A.tsx");
			expect(matches).toHaveLength(1);
			expect(matches[0]?.text).toContain("index used as key");
		},
	);

	it("fires when the index is embedded mid-template with prefix and suffix text", () => {
		const content = "rows.map((r, i) => <li key={`row-${i}-end`}>{r}</li>);";
		expect(checkIndexAsKey(content, "src/A.tsx")).toHaveLength(1);
	});

	it("does NOT fire on a template key built from a stable field", () => {
		const content = "rows.map((r) => <li key={`row-${r.id}`}>{r.name}</li>);";
		expect(checkIndexAsKey(content, "src/A.tsx")).toEqual([]);
	});
});

describe("checkIndexAsKey — static-list skip branches", () => {
	it("skips a literal numeric array .map() in the context window", () => {
		const content = "[0, 1, 2].map((_, i) => <li key={i}>dot</li>);";
		expect(checkIndexAsKey(content, "src/A.tsx")).toEqual([]);
	});

	it("skips when the literal-array .map() is up to 3 lines above the key", () => {
		const content = [
			"[1, 2, 3, 4].map((slot, i) => (",
			"  <div>",
			"    <span />",
			"    <li key={i}>{slot}</li>",
			"  </div>",
			"));",
		].join("\n");
		// key is on index 3 (0-based); the array .map is on index 0 -> within the
		// j = i-3..i context window, so it is treated as static and skipped.
		expect(checkIndexAsKey(content, "src/A.tsx")).toEqual([]);
	});

	it("does NOT skip when the literal-array .map() is MORE than 3 lines above", () => {
		const content = [
			"[1, 2, 3, 4].map((slot, i) => (", // index 0
			"  <div>", // 1
			"    <span />", // 2
			"    <em />", // 3
			"    <li key={i}>{slot}</li>", // 4 -> window is lines 1..4, array gone
			"  </div>",
			"));",
		].join("\n");
		// The static-array context only spans i-3..i, so by line 4 the array
		// literal has scrolled out and the violation fires.
		const matches = checkIndexAsKey(content, "src/A.tsx");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(5);
	});

	it("skips Array(n) constructions in the context window", () => {
		const content = [
			"Array(5).fill(null).map((_, i) => (",
			"  <li key={i}>cell</li>",
			"));",
		].join("\n");
		expect(checkIndexAsKey(content, "src/A.tsx")).toEqual([]);
	});

	it("skips Array( 12 ) with internal whitespace", () => {
		const content = "Array( 12 ).fill(0).map((_, i) => <li key={i}>x</li>);";
		expect(checkIndexAsKey(content, "src/A.tsx")).toEqual([]);
	});
});

describe("checkIndexAsKey — UI-placeholder skip branch", () => {
	it.each([["skeleton"], ["placeholder"], ["loading"], ["spacer"]])(
		"skips a line mentioning %s (case-insensitive)",
		(word) => {
			const content = `data.map((_, i) => <${word.toUpperCase()}Item key={i} />);`;
			expect(checkIndexAsKey(content, "src/A.tsx")).toEqual([]);
		},
	);

	it("skips a Skeleton placeholder even with a template-literal key", () => {
		const content = "data.map((_, i) => <Skeleton key={`sk-${i}`} />);";
		expect(checkIndexAsKey(content, "src/A.tsx")).toEqual([]);
	});

	it("the placeholder keyword must be on the SAME line as the key (trimmed scope)", () => {
		// "loading" appears 2 lines above; the placeholder check looks only at
		// `trimmed` (the key line itself), so this still fires.
		const content = [
			"// loading state below",
			"const rows = data.map((row, i) => (",
			"  <li key={i}>{row}</li>",
			"));",
		].join("\n");
		const matches = checkIndexAsKey(content, "src/A.tsx");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(3);
	});
});

describe("checkIndexAsKey — empty / no-match inputs", () => {
	it("returns [] for empty content", () => {
		expect(checkIndexAsKey("", "src/A.tsx")).toEqual([]);
	});

	it("returns [] for content with no key props at all", () => {
		const content = "export const x = 1;\nfunction f() { return 2; }";
		expect(checkIndexAsKey(content, "src/A.tsx")).toEqual([]);
	});
});
