// Pins for the extracted structural-check defaults leaf (2026-08-17: pulled
// out of default-config.ts so browser-bundled surfaces — the onboarding demo
// via setup-wizard.ts — can read the check catalog without dragging in the
// Node-only resolver graph).

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./default-config.js";
import { DEFAULT_STRUCTURAL_CHECKS } from "./default-structural.js";

describe("DEFAULT_STRUCTURAL_CHECKS — positive (single source)", () => {
	// test-contract: invariant — the leaf IS the value default-config ships;
	// two diverging copies would be exactly the drift the extraction avoids
	it("P1: default-config ships this exact object", () => {
		expect(DEFAULT_CONFIG.structural_checks).toBe(DEFAULT_STRUCTURAL_CHECKS);
	});

	it("P2: the dead-code checks and their action default stay on/flag", () => {
		expect(DEFAULT_STRUCTURAL_CHECKS.dead_imports).toBe(true);
		expect(DEFAULT_STRUCTURAL_CHECKS.dead_exports).toBe(true);
		expect(DEFAULT_STRUCTURAL_CHECKS.dead_code_action).toBe("flag");
	});
});

describe("DEFAULT_STRUCTURAL_CHECKS — negative (must stay browser-safe)", () => {
	// test-contract: bug-class — the module must remain a pure data leaf; any
	// node: import re-breaks the onboarding-demo esbuild bundle
	it("N1: the module source has no imports beyond the type", async () => {
		const { readFileSync } = await import("node:fs");
		const src = readFileSync(new URL("./default-structural.ts", import.meta.url), "utf-8");
		const imports = src.match(/^import .+$/gm) ?? [];
		expect(imports.every((l) => l.includes("import type"))).toBe(true);
	});
});
