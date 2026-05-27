// Tests for `ubs_torch_unsafe_load` — torch.load without weights_only=True.

import { describe, expect, it } from "vitest";
import { checkTorchUnsafeLoad } from "../checks/ubs-language-specific.js";

describe("checkTorchUnsafeLoad — positive cases", () => {
	it("flags `torch.load(path)` with no kwargs", () => {
		expect(checkTorchUnsafeLoad("model = torch.load(path)", "src/m.py").length).toBeGreaterThan(0);
	});

	it("flags `torch.load(path, map_location='cpu')` without weights_only", () => {
		const code = "model = torch.load(path, map_location='cpu')";
		expect(checkTorchUnsafeLoad(code, "src/m.py").length).toBeGreaterThan(0);
	});

	it("flags explicit `torch.load(path, weights_only=False)`", () => {
		const code = "model = torch.load(path, weights_only=False)";
		expect(checkTorchUnsafeLoad(code, "src/m.py").length).toBeGreaterThan(0);
	});
});

describe("checkTorchUnsafeLoad — negative cases", () => {
	it("does NOT flag `torch.load(path, weights_only=True)`", () => {
		const code = "model = torch.load(path, weights_only=True)";
		expect(checkTorchUnsafeLoad(code, "src/m.py")).toEqual([]);
	});

	it("does NOT flag `torch.load(path, weights_only = True)` (whitespace)", () => {
		const code = "model = torch.load(path, weights_only = True)";
		expect(checkTorchUnsafeLoad(code, "src/m.py")).toEqual([]);
	});

	it("does NOT fire on JS files", () => {
		expect(checkTorchUnsafeLoad("torch.load(p)", "src/m.ts")).toEqual([]);
	});

	it("skips test files", () => {
		expect(checkTorchUnsafeLoad("torch.load(p)", "tests/test_m.py")).toEqual([]);
	});
});
