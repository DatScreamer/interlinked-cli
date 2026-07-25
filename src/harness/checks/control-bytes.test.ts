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
	it("does not flag the correct escape form", () => {
		const src = 'const key = `${file}\\x00${anchor}`;\n';
		expect(checkRawControlBytes(src, "src/x.ts")).toHaveLength(0);
	});

	it("does not flag tab, newline, or carriage return", () => {
		const src = "const a = 1;\r\n\tconst b = 2;\n";
		expect(checkRawControlBytes(src, "src/x.ts")).toHaveLength(0);
	});

	it("does not flag ordinary source", () => {
		expect(checkRawControlBytes("export const x = 1;\n", "src/x.ts")).toHaveLength(0);
	});

	it("ignores non-JS/TS files", () => {
		const src = `key = "${NUL}"\n`;
		expect(checkRawControlBytes(src, "notes.md")).toHaveLength(0);
		expect(checkRawControlBytes(src, "data.json")).toHaveLength(0);
		expect(checkRawControlBytes(src, "script.py")).toHaveLength(0);
	});

	it("ignores vendored and fixture paths (binary payloads live there on purpose)", () => {
		const src = `const a = "${NUL}";\n`;
		expect(checkRawControlBytes(src, "src/harness/checks/__fixtures__/x.ts")).toHaveLength(0);
		expect(checkRawControlBytes(src, "node_modules/pkg/index.js")).toHaveLength(0);
	});
});
