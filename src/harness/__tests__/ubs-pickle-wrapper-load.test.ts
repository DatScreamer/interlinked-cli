// Tests for `ubs_pickle_wrapper_load` — joblib / pandas / numpy pickle-wrapper.

import { describe, expect, it } from "vitest";
import { checkPickleWrapperLoad } from "../checks/ubs-language-specific.js";

describe("checkPickleWrapperLoad — positive cases", () => {
	it("flags `joblib.load(path)`", () => {
		expect(checkPickleWrapperLoad("m = joblib.load(p)", "src/m.py").length).toBeGreaterThan(0);
	});

	it("flags `pandas.read_pickle(p)`", () => {
		expect(checkPickleWrapperLoad("df = pandas.read_pickle(p)", "src/m.py").length).toBeGreaterThan(
			0,
		);
	});

	it("flags `pd.read_pickle(p)`", () => {
		expect(checkPickleWrapperLoad("df = pd.read_pickle(p)", "src/m.py").length).toBeGreaterThan(0);
	});

	it("flags `numpy.load(p, allow_pickle=True)`", () => {
		const code = "arr = numpy.load(p, allow_pickle=True)";
		expect(checkPickleWrapperLoad(code, "src/m.py").length).toBeGreaterThan(0);
	});

	it("flags `np.load(p, allow_pickle=True)`", () => {
		const code = "arr = np.load(p, allow_pickle=True)";
		expect(checkPickleWrapperLoad(code, "src/m.py").length).toBeGreaterThan(0);
	});
});

describe("checkPickleWrapperLoad — negative cases", () => {
	it("does NOT flag `np.load(p)` without allow_pickle", () => {
		expect(checkPickleWrapperLoad("arr = np.load(p)", "src/m.py")).toEqual([]);
	});

	it("does NOT flag `np.load(p, allow_pickle=False)`", () => {
		expect(checkPickleWrapperLoad("arr = np.load(p, allow_pickle=False)", "src/m.py")).toEqual([]);
	});

	it("does NOT flag unrelated `load` like `json.load(f)`", () => {
		expect(checkPickleWrapperLoad("obj = json.load(f)", "src/m.py")).toEqual([]);
	});

	it("does NOT fire on JS files", () => {
		expect(checkPickleWrapperLoad("joblib.load(p)", "src/m.ts")).toEqual([]);
	});

	it("skips test files", () => {
		expect(checkPickleWrapperLoad("joblib.load(p)", "tests/test_m.py")).toEqual([]);
	});
});
