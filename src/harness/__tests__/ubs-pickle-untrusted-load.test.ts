// Tests for `ubs_pickle_untrusted_load` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkPickleUntrustedLoad } from "../checks/ubs-language-specific.js";

describe("checkPickleUntrustedLoad", () => {
	it("flags `pickle.load(f)`", () => {
		const code = "import pickle\nobj = pickle.load(f)\n";
		const matches = checkPickleUntrustedLoad(code, "src/foo.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `pickle.loads(payload)`", () => {
		const code = "import pickle\nobj = pickle.loads(payload)\n";
		const matches = checkPickleUntrustedLoad(code, "src/foo.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `cPickle.load(f)`", () => {
		const code = "import cPickle\nobj = cPickle.load(f)\n";
		const matches = checkPickleUntrustedLoad(code, "src/foo.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `json.load(f)` (not pickle)", () => {
		const code = "import json\nobj = json.load(f)\n";
		expect(checkPickleUntrustedLoad(code, "src/foo.py")).toEqual([]);
	});

	it("does NOT fire on JS files", () => {
		const code = "pickle.load(f);";
		expect(checkPickleUntrustedLoad(code, "src/foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "pickle.load(f)";
		expect(checkPickleUntrustedLoad(code, "tests/test_foo.py")).toEqual([]);
	});
});
