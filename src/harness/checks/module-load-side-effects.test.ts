import { describe, expect, it } from "vitest";
import { findTopLevelSideEffects } from "./module-load-side-effects.js";

const n = (s: string, f = "src/commands/foo.ts") => findTopLevelSideEffects(s, f).length;

describe("findTopLevelSideEffects", () => {
	// ── positives: I/O executed at module-load (top level) ───────────────────
	it("flags a top-level readFileSync", () => {
		expect(n('const data = readFileSync("./config.json", "utf8");')).toBeGreaterThanOrEqual(1);
	});
	it("flags a top-level server .listen()", () => {
		expect(n("appServer.listen(3000);")).toBeGreaterThanOrEqual(1);
	});
	it("flags a top-level await fetch", () => {
		expect(n('const res = await fetch("https://example.com/seed");')).toBeGreaterThanOrEqual(1);
	});

	// ── negatives: deferred / boundary / non-execution ───────────────────────
	it("does not flag the same call inside a function body", () => {
		expect(n("function load() {\n\treturn readFileSync(p);\n}")).toBe(0);
	});
	it("does not flag a function definition whose body calls I/O (deferred)", () => {
		expect(n("const load = () => readFileSync(p);")).toBe(0);
	});
	it("does not flag top-level I/O in an entrypoint module", () => {
		expect(n('const data = readFileSync("./c.json");', "src/index.ts")).toBe(0);
		expect(n("httpServer.listen(8080);", "src/harness/server.ts")).toBe(0);
	});
	it("does not flag I/O-call text inside a string literal", () => {
		expect(n('const note = "remember to call readFileSync at startup";')).toBe(0);
	});
});
