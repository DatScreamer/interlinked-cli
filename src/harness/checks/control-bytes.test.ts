// Co-located tests for the raw-control-byte detector.
//
// Fixtures build the offending byte with String.fromCharCode rather than
// embedding it — a literal control byte in this file would make the test file
// itself unsearchable, which is the exact defect under test.

import { describe, expect, it } from "vitest";
import { checkRawControlBytes } from "./control-bytes.js";

const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);

describe("checkRawControlBytes — flags raw bytes", () => {
	it("flags a NUL used as a composite-key delimiter", () => {
		const src = `const key = \`\${file}${NUL}\${anchor}\`;\n`;
		expect(checkRawControlBytes(src, "src/x.ts")).toHaveLength(1);
	});

	it("flags a raw ESC in a regex literal", () => {
		const src = `const strip = /${ESC}\\[[0-9;]*m/g;\n`;
		expect(checkRawControlBytes(src, "src/x.ts")).toHaveLength(1);
	});

	it("flags a raw byte inside a comment", () => {
		const src = `/** Key = \`\${file}${NUL}\${anchor}\`. */\nexport const x = 1;\n`;
		expect(checkRawControlBytes(src, "src/x.ts")).toHaveLength(1);
	});

	it("flags DEL", () => {
		expect(checkRawControlBytes(`const a = "${DEL}";\n`, "src/x.ts")).toHaveLength(1);
	});

	it("reports the 1-based line and renders the byte as its escape", () => {
		const src = `const a = 1;\nconst b = "${NUL}";\n`;
		const [hit] = checkRawControlBytes(src, "src/x.ts");
		expect(hit?.line).toBe(2);
		expect(hit?.text).toContain("\\x00");
		// The rendered text must not carry the raw byte into the warning.
		expect(hit?.text).not.toContain(NUL);
	});

	it("caps the reported matches", () => {
		const src = Array.from({ length: 40 }, (_, i) => `const a${i} = "${NUL}";`).join("\n");
		expect(checkRawControlBytes(src, "src/x.ts").length).toBeLessThanOrEqual(10);
	});
});

describe("checkRawControlBytes — legitimate source is untouched", () => {
	it("N1: does not flag the correct escape form (near-miss: same byte, expressed as \\xNN instead of raw)", () => {
		const src = 'const key = `${file}\\x00${anchor}`;\n';
		expect(checkRawControlBytes(src, "src/x.ts")).toHaveLength(0);
	});

	it("N2: does not flag tab, newline, or carriage return (near-miss: the three C0 bytes the detector deliberately permits)", () => {
		const src = "const a = 1;\r\n\tconst b = 2;\n";
		expect(checkRawControlBytes(src, "src/x.ts")).toHaveLength(0);
	});

	it("does not flag ordinary source", () => {
		expect(checkRawControlBytes("export const x = 1;\n", "src/x.ts")).toHaveLength(0);
	});

	// Languages whose string forms can ALWAYS carry an escape (or which have no
	// string-literal concept at all) — a raw byte there is never the only way to
	// express the intent, so the finding stays zero-FP.
	it("covers non-JS/TS text formats where an escape always exists", () => {
		const src = `key = "${NUL}"\n`;
		for (const path of ["notes.md", "data.json", "script.py", "q.sql", "conf.yaml", "a.c"]) {
			expect(checkRawControlBytes(src, path), path).toHaveLength(1);
		}
	});

	// Excluded on purpose: each has a raw/single-quoted string form that cannot
	// carry an escape, so a literal byte could be the only expression available.
	// Shell is excluded because a literal ESC for terminal output is an idiom.
	it("N3: ignores languages with escape-less string forms (near-miss: same raw byte, an extension where it may be the only expression)", () => {
		const src = `key = "${NUL}"\n`;
		for (const path of ["main.go", "lib.rs", "app.rb", "run.sh"]) {
			expect(checkRawControlBytes(src, path), path).toHaveLength(0);
		}
	});

	it("N4: ignores binary and unknown extensions (near-miss: same raw byte, an extension outside TEXT_SOURCE_EXTS)", () => {
		const src = `key = "${NUL}"\n`;
		expect(checkRawControlBytes(src, "logo.png")).toHaveLength(0);
		expect(checkRawControlBytes(src, "archive.gz")).toHaveLength(0);
	});

	it("N5: ignores vendored and fixture paths (near-miss: same raw byte and extension, but the path is exempt on purpose)", () => {
		const src = `const a = "${NUL}";\n`;
		expect(checkRawControlBytes(src, "src/harness/checks/__fixtures__/x.ts")).toHaveLength(0);
		expect(checkRawControlBytes(src, "node_modules/pkg/index.js")).toHaveLength(0);
	});
});
