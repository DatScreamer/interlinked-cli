import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { QualityCheckConfig } from "../../types.js";
import { autoTuneQualityChecks, detectProjectLanguages } from "../language-detection.js";
import { nonNull } from "../../../lib/non-null.js";

function mkTmp(): string {
	return mkdtempSync(join(tmpdir(), "interlinked-lang-detect-"));
}

describe("detectProjectLanguages", () => {
	it("defaults to typescript when no markers found", () => {
		const dir = mkTmp();
		const langs = detectProjectLanguages(dir);
		expect(langs.has("typescript")).toBe(true);
		expect(langs.size).toBe(1);
	});

	it("detects rust from Cargo.toml", () => {
		const dir = mkTmp();
		writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = 'test'\n");
		const langs = detectProjectLanguages(dir);
		expect(langs.has("rust")).toBe(true);
	});

	it("detects go from go.mod", () => {
		const dir = mkTmp();
		writeFileSync(join(dir, "go.mod"), "module example.com/m\n");
		const langs = detectProjectLanguages(dir);
		expect(langs.has("go")).toBe(true);
	});

	it("detects python from pyproject.toml", () => {
		const dir = mkTmp();
		writeFileSync(join(dir, "pyproject.toml"), "[project]\nname = 'x'\n");
		const langs = detectProjectLanguages(dir);
		expect(langs.has("python")).toBe(true);
	});

	it("detects multiple languages in polyglot projects", () => {
		const dir = mkTmp();
		writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = 'x'\n");
		writeFileSync(join(dir, "pyproject.toml"), "[project]\nname = 'x'\n");
		const langs = detectProjectLanguages(dir);
		expect(langs.has("rust")).toBe(true);
		expect(langs.has("python")).toBe(true);
	});

	it("detects java from pom.xml", () => {
		const dir = mkTmp();
		writeFileSync(join(dir, "pom.xml"), "<project/>");
		const langs = detectProjectLanguages(dir);
		expect(langs.has("java")).toBe(true);
	});

	it("detects c_cpp from CMakeLists.txt", () => {
		const dir = mkTmp();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "CMakeLists.txt"), "project(x)");
		const langs = detectProjectLanguages(dir);
		expect(langs.has("c_cpp")).toBe(true);
	});
});

describe("autoTuneQualityChecks", () => {
	function makeCheck(enabled = true): QualityCheckConfig {
		return {
			enabled,
			file_types: [".ts"],
			timeout_ms: 5_000,
			severity: "warning",
		};
	}

	it("disables rust-only checks when rust is not detected", () => {
		const checks: Record<string, QualityCheckConfig> = {
			cargo_check: makeCheck(),
			cargo_clippy: makeCheck(),
			typescript: makeCheck(),
		};
		autoTuneQualityChecks(checks, new Set(["typescript"]));
		expect(nonNull(checks.cargo_check).enabled).toBe(false);
		expect(nonNull(checks.cargo_clippy).enabled).toBe(false);
		expect(nonNull(checks.typescript).enabled).toBe(true);
	});

	it("leaves language-agnostic checks enabled", () => {
		const checks: Record<string, QualityCheckConfig> = {
			unknown_check: makeCheck(),
		};
		autoTuneQualityChecks(checks, new Set(["typescript"]));
		// Language-agnostic check stays enabled
		expect(nonNull(checks.unknown_check).enabled).toBe(true);
	});

	it("keeps affected_tests enabled across supported languages", () => {
		const checks: Record<string, QualityCheckConfig> = {
			affected_tests: makeCheck(),
		};
		autoTuneQualityChecks(checks, new Set(["python"]));
		expect(nonNull(checks.affected_tests).enabled).toBe(true);
	});
});
