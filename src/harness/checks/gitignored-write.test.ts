import { describe, expect, it } from "vitest";
import { detectGitignoredWrites } from "./gitignored-write.js";

// ─── helpers ───────────────────────────────────────────────────────────────

const TS = "src/setup/init.ts";

/** isIgnored mock that returns true for any path under ".interlinked/" or "config/". */
function ignoredUnderTool(p: string): boolean {
	const norm = p.replace(/\\/g, "/");
	return norm.startsWith(".interlinked/") || norm.startsWith("config/");
}

/** isIgnored mock that always returns false (nothing is gitignored). */
function nothingIgnored(_p: string): boolean {
	return false;
}

/** isIgnored mock that always returns true (everything is gitignored). */
function everythingIgnored(_p: string): boolean {
	return true;
}

// ─── Positive cases — MUST fire ────────────────────────────────────────────

describe("detectGitignoredWrites — positive cases (must fire)", () => {
	it("flags writeFileSync with bare literal path under .interlinked/", () => {
		const code = `
import { writeFileSync } from "fs";
writeFileSync(".interlinked/metric-caps.json", JSON.stringify(data), "utf-8");
`;
		const results = detectGitignoredWrites(code, TS, ignoredUnderTool);
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	it("flags writeFileSync with join() of string literals (real-world pattern)", () => {
		const code = `
import { join } from "path";
import { writeFileSync } from "fs";
const cwd = process.cwd();
writeFileSync(join(cwd, ".interlinked", "metric-caps.json"), body, "utf-8");
`;
		// cwd is a variable, so join(cwd, ...) is NOT statically resolvable —
		// however the rule says if ANY segment is non-literal → skip.
		// This should NOT fire. The next test uses all-literal segments.
		const results = detectGitignoredWrites(code, TS, ignoredUnderTool);
		// Correct behaviour: opaque path (cwd variable) → no finding.
		expect(results).toEqual([]);
	});

	it("flags writeFileSync with all-literal path.join()", () => {
		const code = `
import { writeFileSync } from "fs";
writeFileSync(path.join(".interlinked", "metric-caps.json"), body);
`;
		const results = detectGitignoredWrites(code, TS, ignoredUnderTool);
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	it("flags appendFileSync with bare literal under config/", () => {
		const code = `
import { appendFileSync } from "fs";
appendFileSync("config/app.json", newLine, "utf-8");
`;
		const results = detectGitignoredWrites(code, TS, ignoredUnderTool);
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	it("flags writeFile (async) with bare literal path", () => {
		const code = `
import { writeFile } from "fs/promises";
await writeFile("config/settings.json", data);
`;
		const results = detectGitignoredWrites(code, TS, ignoredUnderTool);
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	it("flags appendFileSync with all-literal join under .tool/", () => {
		const code = `
appendFileSync(join(".tool", "policy.json"), entry);
`;
		const results = detectGitignoredWrites(
			code,
			TS,
			(p) => p.startsWith(".tool/"),
		);
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	it("reports the correct 1-based line number", () => {
		const code = [
			"import { writeFileSync } from 'fs';",
			"// some comment",
			'writeFileSync(".interlinked/caps.json", data);',
		].join("\n");
		const results = detectGitignoredWrites(code, TS, ignoredUnderTool);
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0]?.line).toBe(3);
	});

	it("truncates long lines to 150 chars in the text field", () => {
		const longComment = "x".repeat(200);
		const code = `writeFileSync(".interlinked/x.json", "${longComment}");`;
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect((results[0]?.text ?? "").length).toBeLessThanOrEqual(150);
	});

	it("caps findings at 10 per file", () => {
		const lines: string[] = [];
		for (let i = 0; i < 15; i++) {
			lines.push(`writeFileSync("config/file${i}.json", data);`);
		}
		const results = detectGitignoredWrites(lines.join("\n"), TS, ignoredUnderTool);
		expect(results.length).toBeLessThanOrEqual(10);
	});
});

// ─── Negative cases — MUST NOT fire ────────────────────────────────────────

describe("detectGitignoredWrites — negative cases (must NOT fire)", () => {
	it("does not flag when isIgnored returns false (path is committed)", () => {
		const code = `
import { writeFileSync } from "fs";
writeFileSync(".interlinked/metric-caps.json", data, "utf-8");
`;
		// Nothing is ignored → no finding.
		const results = detectGitignoredWrites(code, TS, nothingIgnored);
		expect(results).toEqual([]);
	});

	it("does not flag writeFileSync with opaque variable path", () => {
		const code = `
const outPath = buildOutputPath();
writeFileSync(outPath, data);
`;
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("does not flag join() when a segment is a variable (non-literal)", () => {
		const code = `
writeFileSync(join(root, ".interlinked", "caps.json"), data);
`;
		// root is a variable → unresolvable → skip.
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("does not flag log files even when isIgnored returns true (ephemeral)", () => {
		const code = `
writeFileSync(join("logs", "run.log"), entry, "utf-8");
`;
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("does not flag .tmp files (ephemeral extension)", () => {
		const code = `
writeFileSync("build/output.tmp", data);
`;
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("does not flag dist/ writes (ephemeral directory)", () => {
		const code = `
writeFileSync("dist/bundle.js", compiled);
`;
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("does not flag node_modules writes (ephemeral directory)", () => {
		const code = `
writeFileSync("node_modules/.cache/result.json", cached);
`;
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("does not fire on a non-JS/TS file extension", () => {
		const code = `
writeFileSync(".interlinked/caps.json", data);
`;
		// Even with everythingIgnored, a .py file should be skipped entirely.
		const results = detectGitignoredWrites(code, "scripts/setup.py", everythingIgnored);
		expect(results).toEqual([]);
	});

	it("does not flag absolute OS paths (determinism: skip, not flag)", () => {
		const code = `
writeFileSync("/tmp/out.json", data);
`;
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("does not flag .sock files (ephemeral extension)", () => {
		const code = `
createWriteStream(".interlinked/harness.sock");
`;
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("does not flag cache/ writes (ephemeral directory)", () => {
		const code = `
writeFileSync("cache/result.json", data);
`;
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});
});

// ─── Edge-case / precision tests ───────────────────────────────────────────

describe("detectGitignoredWrites — edge cases", () => {
	it("handles multiple write calls in the same file independently", () => {
		const code = `
writeFileSync("config/policy.json", a);      // should flag
writeFileSync("committed/schema.json", b);    // not ignored
writeFileSync(join("config", "caps.json"), c); // should flag
`;
		// Only paths starting with "config/" are ignored.
		const results = detectGitignoredWrites(code, TS, ignoredUnderTool);
		expect(results.length).toBe(2);
	});

	it("handles createWriteStream with bare literal", () => {
		const code = `
const ws = createWriteStream(".interlinked/output.json");
`;
		const results = detectGitignoredWrites(code, TS, ignoredUnderTool);
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	it("does not flag a join() call where one arg is a function call", () => {
		// path.join(getDir(), "caps.json") — getDir() is not a literal
		const code = `
writeFileSync(path.join(getDir(), "caps.json"), data);
`;
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("handles all-literal join with multiple segments", () => {
		const code = `
writeFileSync(join(".interlinked", "sub", "caps.json"), data);
`;
		const results = detectGitignoredWrites(
			code,
			TS,
			(p) => p.startsWith(".interlinked/"),
		);
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	it("does not flag a join() whose first literal segment is an absolute path root", () => {
		// join("/etc", "passwd") — the joined path starts with "/" even though
		// every segment is a literal; the belt-and-suspenders absolute-path
		// check inside the join branch must catch this (case 1's own
		// startsWith("/") guard only covers bare-literal paths, not joined ones).
		const code = `
writeFileSync(join("/etc", "caps.json"), data);
`;
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("skips an unterminated write call (unbalanced parens) without throwing", () => {
		// The string literal opened by writeFileSync( never closes and the
		// content ends mid-escape — extractFirstArg must fail closed (return
		// null) rather than throw or produce a bogus finding.
		const code = 'writeFileSync("abc\\';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("flags a bare literal path containing a mid-string escaped backslash", () => {
		// The path literal itself contains an escaped backslash (Windows-style
		// separator) that is NOT the last character — extractFirstArg's
		// escape-skip branch must fire and keep parsing past it.
		const code = 'writeFileSync(".interlinked\\\\caps.json", data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results.length).toBe(1);
		expect(results[0]?.text).toBe(code);
	});

	it("flags an all-literal join() where a segment contains a mid-string escaped backslash", () => {
		// Same escape-skip branch, but inside splitTopLevelArgs' scan of the
		// join(...) argument list rather than the outer extractFirstArg scan.
		const code = 'writeFileSync(join(".interlinked", "sub\\\\dir", "caps.json"), data);';
		const results = detectGitignoredWrites(
			code,
			TS,
			(p) => p.startsWith(".interlinked/"),
		);
		expect(results.length).toBe(1);
	});
});
