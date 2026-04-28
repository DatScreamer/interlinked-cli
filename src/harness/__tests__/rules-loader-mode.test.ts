// ===========================================
// Phase C — mode preset enablement integration
// ===========================================
// `rules/modes.ts` defines `quality_checks_enabled` per preset, but until
// the rules-loader applies that map onto the loaded config, switching to
// `budget` only lowered the hook timeout while still running structural /
// semgrep / prompt-injection at their built-in defaults. These tests pin
// the loader's mode-application behavior so the regression doesn't
// resurface — and so user overrides keep winning over the preset.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRules } from "../rules-loader.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "rules-loader-mode-"));
	mkdirSync(join(tmp, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function writeSharedConfig(mode: string | null): void {
	const path = join(tmp, ".interlinked", "config.json");
	const body = mode === null ? {} : { mode };
	writeFileSync(path, JSON.stringify(body));
}

function writeLocal(content: object): void {
	writeFileSync(
		join(tmp, ".interlinked", "guard-rules.local.json"),
		JSON.stringify(content),
	);
}

describe("loadRules — Phase C mode preset enablement", () => {
	it("budget mode disables structural_checks + heavy quality checks", () => {
		writeSharedConfig("budget");
		const config = loadRules(tmp);
		expect(config.structural_checks?.enabled).toBe(false);
		expect(config.quality_checks.semgrep?.enabled).toBe(false);
		expect(config.quality_checks.prompt_injection?.enabled).toBe(false);
		expect(config.quality_checks.affected_tests?.enabled).toBe(false);
	});

	it("quality mode enables structural_checks, semgrep, affected_tests", () => {
		writeSharedConfig("quality");
		const config = loadRules(tmp);
		expect(config.structural_checks?.enabled).toBe(true);
		expect(config.quality_checks.semgrep?.enabled).toBe(true);
		expect(config.quality_checks.affected_tests?.enabled).toBe(true);
		// quality leaves prompt_injection off (CI-only)
		expect(config.quality_checks.prompt_injection?.enabled).toBe(false);
	});

	it("ci mode enables prompt_injection + every other heavy check", () => {
		writeSharedConfig("ci");
		const config = loadRules(tmp);
		expect(config.structural_checks?.enabled).toBe(true);
		expect(config.quality_checks.semgrep?.enabled).toBe(true);
		expect(config.quality_checks.affected_tests?.enabled).toBe(true);
		expect(config.quality_checks.prompt_injection?.enabled).toBe(true);
	});

	it("local override beats the mode preset (user remains authoritative)", () => {
		// budget normally disables semgrep; the user explicitly turning it
		// back on in local config must win.
		writeSharedConfig("budget");
		writeLocal({ quality_checks: { semgrep: { enabled: true } } });
		const config = loadRules(tmp);
		expect(config.quality_checks.semgrep?.enabled).toBe(true);
		// other budget gates still apply
		expect(config.structural_checks?.enabled).toBe(false);
	});

	it("absent mode field falls through to defaults (no mode override applied)", () => {
		writeSharedConfig(null);
		const config = loadRules(tmp);
		// We don't assert specific defaults here — only that the loader
		// produced a workable config without crashing.
		expect(config.quality_checks).toBeDefined();
		expect(config.rules.length).toBeGreaterThan(0);
	});

	it("malformed config.json is treated as no-mode, not a crash", () => {
		writeFileSync(join(tmp, ".interlinked", "config.json"), "{not-json");
		expect(() => loadRules(tmp)).not.toThrow();
	});

	it("unknown mode strings migrate to quality (safe default)", () => {
		writeSharedConfig("strict-banana");
		const config = loadRules(tmp);
		// strict-banana migrates → quality, so structural_checks should be on.
		expect(config.structural_checks?.enabled).toBe(true);
	});
});
