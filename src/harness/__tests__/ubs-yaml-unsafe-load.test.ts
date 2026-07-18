// Tests for `ubs_yaml_unsafe_load` — PyYAML unsafe load detector.

import { describe, expect, it } from "vitest";
import { checkYamlUnsafeLoad } from "../checks/ubs-language-specific.js";

describe("checkYamlUnsafeLoad — positive cases", () => {
	it("flags bare `yaml.load(f)`", () => {
		const code = "import yaml\ncfg = yaml.load(f)";
		expect(checkYamlUnsafeLoad(code, "src/cfg.py").length).toBeGreaterThan(0);
	});

	it("flags explicit `yaml.unsafe_load(f)`", () => {
		const code = "import yaml\ncfg = yaml.unsafe_load(f)";
		expect(checkYamlUnsafeLoad(code, "src/cfg.py").length).toBeGreaterThan(0);
	});

	it("flags `yaml.load(stream, Loader=yaml.FullLoader)`", () => {
		const code = "cfg = yaml.load(stream, Loader=yaml.FullLoader)";
		expect(checkYamlUnsafeLoad(code, "src/cfg.py").length).toBeGreaterThan(0);
	});

	it("flags the multi-document `yaml.load_all(f)` (DW P0.5 load_all parity)", () => {
		const code = "import yaml\ndocs = list(yaml.load_all(f))";
		expect(checkYamlUnsafeLoad(code, "src/cfg.py").length).toBeGreaterThan(0);
	});
});

describe("checkYamlUnsafeLoad — negative cases", () => {
	it("does NOT flag `yaml.safe_load(f)`", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.safe_load(f)", "src/cfg.py")).toEqual([]);
	});

	it("does NOT flag the safe multi-document `yaml.safe_load_all(f)`", () => {
		expect(checkYamlUnsafeLoad("docs = list(yaml.safe_load_all(f))", "src/cfg.py")).toEqual([]);
	});

	it("does NOT flag `yaml.load(f, Loader=yaml.SafeLoader)`", () => {
		expect(
			checkYamlUnsafeLoad("cfg = yaml.load(f, Loader=yaml.SafeLoader)", "src/cfg.py"),
		).toEqual([]);
	});

	it("does NOT flag `yaml.load(f, yaml.CSafeLoader)`", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f, yaml.CSafeLoader)", "src/cfg.py")).toEqual([]);
	});

	it("does NOT fire on JS files", () => {
		expect(checkYamlUnsafeLoad("yaml.load(f)", "src/cfg.ts")).toEqual([]);
	});

	it("skips test files", () => {
		expect(checkYamlUnsafeLoad("yaml.load(f)", "tests/test_cfg.py")).toEqual([]);
	});
});
