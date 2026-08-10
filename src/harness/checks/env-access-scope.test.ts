import { describe, expect, it } from "vitest";
import { findProcessEnvOutsideConfig } from "./env-access-scope.js";

const n = (s: string, f = "src/commands/foo.ts") => findProcessEnvOutsideConfig(s, f).length;

describe("findProcessEnvOutsideConfig", () => {
	// ── positives: process.env read outside the config boundary ──────────────
	it("flags a process.env.X read in a command module", () => {
		expect(n("const region = process.env.AWS_REGION;")).toBeGreaterThanOrEqual(1);
	});
	it("flags process.env in a conditional in a harness module", () => {
		expect(n("if (process.env.DEBUG) enableVerbose();", "src/harness/server.ts")).toBeGreaterThanOrEqual(1);
	});
	it("flags bracket-style process.env access", () => {
		expect(n('const v = process.env["BAR"];')).toBeGreaterThanOrEqual(1);
	});

	// ── negatives: legitimate boundary reads / non-reads ─────────────────────
	it("does not flag reads inside the config module", () => {
		expect(n("const url = process.env.SERVER_URL;", "src/lib/config.ts")).toBe(0);
		expect(n("const dir = process.env.HOME;", "src/lib/config-paths.ts")).toBe(0);
	});
	it("does not flag reads in a *.config.ts file", () => {
		expect(n("const port = process.env.PORT;", "vite.config.ts")).toBe(0);
	});
	it("does not flag reads in a test file", () => {
		expect(n("const ci = process.env.CI;", "src/harness/__tests__/x.test.ts")).toBe(0);
	});
	it("does not flag process.env-like text inside a string literal", () => {
		expect(n('const help = "set process.env.FOO before running";')).toBe(0);
	});
	it("N1: does not flag reads in a bootstrap-named module (boundary allowlist)", () => {
		expect(n("const url = process.env.SERVER_URL;", "src/bootstrap.ts")).toBe(0);
	});
	it("N2: does not flag files inside a setup directory (test-setup/ is a setup boundary)", () => {
		expect(n("process.env.HOME = sandbox;", "src/test-setup/home-sandbox.ts")).toBe(0);
	});
	it("P1: still flags a non-setup directory whose file merely mentions setup in its name tail", () => {
		expect(n("const t = process.env.TOKEN;", "src/commands/account-setup-helpers.ts")).toBeGreaterThan(0);
	});
});
