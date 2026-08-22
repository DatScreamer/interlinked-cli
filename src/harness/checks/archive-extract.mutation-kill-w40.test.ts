import { describe, expect, it } from "vitest";
import { checkArchiveExtractTraversal } from "./archive-extract.js";

describe("checkArchiveExtractTraversal — mutation-kill w40", () => {
	// test-contract: boundary — an unlisted extension must stay excluded from
	// the JS/TS extension check even when a Node extract call is present.
	it("does NOT fire on an unlisted extension even with a Node tar.x call", () => {
		const code = "tar.x({ file: 'a.tgz', cwd: dest });";
		expect(checkArchiveExtractTraversal(code, "src/a.rs")).toEqual([]);
	});

	// test-contract: boundary — each JS/TS extension in the allow-list must
	// independently gate the Node-extract check on.
	it("fires for .tsx files", () => {
		const code = "tar.x({ file: 'a.tgz', cwd: dest });";
		expect(checkArchiveExtractTraversal(code, "src/a.tsx")).toHaveLength(1);
	});

	// test-contract: boundary — each JS/TS extension in the allow-list must
	// independently gate the Node-extract check on.
	it("fires for .jsx files", () => {
		const code = "tar.x({ file: 'a.tgz', cwd: dest });";
		expect(checkArchiveExtractTraversal(code, "src/a.jsx")).toHaveLength(1);
	});

	// test-contract: boundary — each JS/TS extension in the allow-list must
	// independently gate the Node-extract check on.
	it("fires for .mjs files", () => {
		const code = "tar.x({ file: 'a.tgz', cwd: dest });";
		expect(checkArchiveExtractTraversal(code, "src/a.mjs")).toHaveLength(1);
	});

	// test-contract: boundary — each JS/TS extension in the allow-list must
	// independently gate the Node-extract check on.
	it("fires for .cts files", () => {
		const code = "tar.x({ file: 'a.tgz', cwd: dest });";
		expect(checkArchiveExtractTraversal(code, "src/a.cts")).toHaveLength(1);
	});

	// test-contract: boundary — each JS/TS extension in the allow-list must
	// independently gate the Node-extract check on.
	it("fires for .mts files", () => {
		const code = "tar.x({ file: 'a.tgz', cwd: dest });";
		expect(checkArchiveExtractTraversal(code, "src/a.mts")).toHaveLength(1);
	});

	// test-contract: boundary — each JS/TS extension in the allow-list must
	// independently gate the Node-extract check on.
	it("fires for .cjs files", () => {
		const code = "tar.x({ file: 'a.tgz', cwd: dest });";
		expect(checkArchiveExtractTraversal(code, "src/a.cjs")).toHaveLength(1);
	});

	// test-contract: public-api — matched line text is line-based, not
	// per-character.
	it("captures the exact matched line text and line number, not per-character", () => {
		const code = "const x = 1;\ntf.extractall(dest)\n";
		const matches = checkArchiveExtractTraversal(code, "src/a.py");
		expect(matches).toEqual([{ line: 2, text: "tf.extractall(dest)" }]);
	});

	// test-contract: boundary — the match cap is exactly 10, not unbounded
	// and not 11.
	it("caps at exactly 10 matches even when 15 unguarded calls exist", () => {
		const lines = Array.from({ length: 15 }, () => "tf.extractall(dest)");
		const code = lines.join("\n");
		const matches = checkArchiveExtractTraversal(code, "src/many.py");
		expect(matches).toHaveLength(10);
	});

	// test-contract: public-api — the filter= sanitizer guard is a literal
	// "filter" then only whitespace then "=", not any lookalike identifier.
	it("flags extractall when the filter-lookalike arg isn't literally 'filter='", () => {
		const code = "tf.extractall(dest, filterXYZ=1)";
		expect(checkArchiveExtractTraversal(code, "src/a.py")).toHaveLength(1);
	});

	// test-contract: public-api — captured text is trimmed of surrounding
	// whitespace.
	it("trims whitespace from the captured match text", () => {
		const code = "   tf.extractall(dest)   ";
		const matches = checkArchiveExtractTraversal(code, "src/a.py");
		expect(matches[0]?.text).toBe("tf.extractall(dest)");
	});

	// test-contract: public-api — captured text is truncated to 150 chars.
	it("truncates captured text to 150 characters", () => {
		const padding = "x".repeat(200);
		const code = `tf.extractall(dest)  # ${padding}`;
		const matches = checkArchiveExtractTraversal(code, "src/a.py");
		expect(matches[0]?.text.length).toBe(150);
	});

	// test-contract: public-api — PY_EXTRACTALL_RE allows whitespace (not
	// only non-whitespace) between "extractall" and the opening paren.
	it("matches extractall with whitespace before the opening paren", () => {
		const code = "tf.extractall (dest)";
		expect(checkArchiveExtractTraversal(code, "src/a.py")).toHaveLength(1);
	});

	// test-contract: public-api — NODE_EXTRACT_RE allows whitespace between
	// "tar" and the following dot.
	it("matches tar with whitespace between the identifier and the dot", () => {
		const code = "tar .x({ file });";
		expect(checkArchiveExtractTraversal(code, "src/a.ts")).toHaveLength(1);
	});

	// test-contract: public-api — NODE_EXTRACT_RE allows whitespace between
	// the dot and the x/extract method name.
	it("matches tar with whitespace before the x/extract method name", () => {
		const code = "tar. x({ file });";
		expect(checkArchiveExtractTraversal(code, "src/a.ts")).toHaveLength(1);
	});

	// test-contract: public-api — NODE_EXTRACT_RE allows whitespace between
	// the x/extract method name and the opening paren.
	it("matches tar.x with whitespace before the opening paren", () => {
		const code = "tar.x ({ file });";
		expect(checkArchiveExtractTraversal(code, "src/a.ts")).toHaveLength(1);
	});

	// test-contract: public-api — the extractAllTo alternative allows
	// whitespace before its opening paren too.
	it("matches extractAllTo with whitespace before the opening paren", () => {
		const code = "zip.extractAllTo (dest, true);";
		expect(checkArchiveExtractTraversal(code, "src/a.ts")).toHaveLength(1);
	});
});
