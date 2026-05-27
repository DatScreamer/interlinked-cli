// Tests for `ubs_script_without_sri` — external <script src> without integrity.

import { describe, expect, it } from "vitest";
import { checkScriptWithoutSri } from "../checks/ubs-language-specific.js";

describe("checkScriptWithoutSri — positive cases", () => {
	it("flags `<script src=\"https://cdn/x.js\"></script>` in HTML", () => {
		const html = `<script src="https://cdn.example.com/lib.js"></script>`;
		expect(checkScriptWithoutSri(html, "index.html").length).toBeGreaterThan(0);
	});

	it("flags protocol-relative `<script src=\"//cdn/x.js\">`", () => {
		const html = `<script src="//cdn.example.com/lib.js"></script>`;
		expect(checkScriptWithoutSri(html, "index.html").length).toBeGreaterThan(0);
	});

	it("flags external script in .tsx", () => {
		const code = `<>\n  <script src="https://cdn.example.com/lib.js"></script>\n</>`;
		expect(checkScriptWithoutSri(code, "src/App.tsx").length).toBeGreaterThan(0);
	});
});

describe("checkScriptWithoutSri — negative cases", () => {
	it("does NOT flag script WITH integrity attribute", () => {
		const html = `<script src="https://cdn/lib.js" integrity="sha384-abc"></script>`;
		expect(checkScriptWithoutSri(html, "index.html")).toEqual([]);
	});

	it("does NOT flag relative-path src `<script src=\"./lib.js\">`", () => {
		const html = `<script src="./lib.js"></script>`;
		expect(checkScriptWithoutSri(html, "index.html")).toEqual([]);
	});

	it("does NOT flag inline `<script>` (no src)", () => {
		const html = `<script>const x = 1;</script>`;
		expect(checkScriptWithoutSri(html, "index.html")).toEqual([]);
	});

	it("does NOT fire on Markdown files (docs)", () => {
		const md = `\`\`\`html\n<script src="https://cdn/lib.js"></script>\n\`\`\``;
		expect(checkScriptWithoutSri(md, "README.md")).toEqual([]);
	});

	it("skips fixture paths", () => {
		const html = `<script src="https://cdn/lib.js"></script>`;
		expect(checkScriptWithoutSri(html, "src/fixtures/page.html")).toEqual([]);
	});
});
