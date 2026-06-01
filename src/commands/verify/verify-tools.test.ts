// ===========================================
// verify-tools unit tests
// ===========================================
// Pins the external-tool spec table shape. The streaming runner
// (`streamExternalTools`) spawns real subprocesses, so it is exercised
// end-to-end by the verify integration tests rather than here; this file
// guards the declarative `TOOLS_TO_RUN` data that the runner walks.

import { describe, expect, it } from "vitest";
import { type ToolSpec, TOOLS_TO_RUN } from "./verify-tools.js";

describe("TOOLS_TO_RUN", () => {
	it("includes the core external verifiers", () => {
		const ids = TOOLS_TO_RUN.map((t) => t.id);
		expect(ids).toContain("tsc");
		expect(ids).toContain("biome");
		expect(ids).toContain("oxlint");
		expect(ids).toContain("semgrep");
		expect(ids).toContain("gitleaks");
		expect(ids).toContain("docs-check");
	});

	it("gives every tool a non-empty command vector and ANSI severity color", () => {
		for (const tool of TOOLS_TO_RUN) {
			expect(tool.cmd.length).toBeGreaterThan(0);
			expect(tool.cmd.every((arg) => typeof arg === "string")).toBe(true);
			// severity is a raw ANSI SGR code ("31" red / "33" yellow).
			expect(["31", "33"]).toContain(tool.severity);
			expect(tool.label.length).toBeGreaterThan(0);
			expect(tool.passLabel.length).toBeGreaterThan(0);
			expect(tool.noun.length).toBeGreaterThan(0);
		}
	});

	it("has unique tool ids", () => {
		const ids = TOOLS_TO_RUN.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("exposes a structurally-typed ToolSpec", () => {
		const sample: ToolSpec = TOOLS_TO_RUN[0];
		expect(sample).toHaveProperty("id");
		expect(sample).toHaveProperty("cmd");
	});
});
