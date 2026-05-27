// Tests for `ubs_marshal_load` — Python marshal.load(s) detector.

import { describe, expect, it } from "vitest";
import { checkMarshalLoad } from "../checks/ubs-language-specific.js";

describe("checkMarshalLoad", () => {
	it("flags `marshal.load(f)`", () => {
		const code = "import marshal\nobj = marshal.load(f)\n";
		expect(checkMarshalLoad(code, "src/foo.py").length).toBeGreaterThan(0);
	});

	it("flags `marshal.loads(payload)`", () => {
		const code = "import marshal\nobj = marshal.loads(payload)\n";
		expect(checkMarshalLoad(code, "src/foo.py").length).toBeGreaterThan(0);
	});

	it("flags marshal.loads buried inside an expression", () => {
		const code = "data = decode(marshal.loads(buf))\n";
		expect(checkMarshalLoad(code, "src/foo.py").length).toBeGreaterThan(0);
	});

	it("does NOT flag `json.loads(payload)` (not marshal)", () => {
		expect(checkMarshalLoad("obj = json.loads(payload)", "src/foo.py")).toEqual([]);
	});

	it("does NOT fire on JS files", () => {
		expect(checkMarshalLoad("marshal.loads(buf)", "src/foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		expect(checkMarshalLoad("marshal.load(f)", "tests/test_cache.py")).toEqual([]);
	});

	it("respects `# noqa: ubs_marshal_load`", () => {
		const code = "obj = marshal.loads(buf)  # noqa: ubs_marshal_load";
		expect(checkMarshalLoad(code, "src/cache.py")).toEqual([]);
	});
});
