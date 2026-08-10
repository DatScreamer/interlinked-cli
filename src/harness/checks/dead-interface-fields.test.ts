// ===========================================
// Cross-module dead-interface-field detector — unit + integration tests
// ===========================================

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDeadInterfaceFields } from "./dead-interface-fields.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "dead-fields-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("findDeadInterfaceFields", () => {
	it("flags an interface field that nothing reads outside its declaring file", () => {
		const decl = join(tmp, "src", "types.ts");
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(
			decl,
			`export interface Settings {\n  reachable: boolean;\n  isolatedField: number;\n}\n`,
		);
		// A consumer that only reads `reachable`.
		writeFileSync(
			join(tmp, "src", "consumer.ts"),
			`import { Settings } from "./types.js";\nexport function f(s: Settings) { return s.reachable; }\n`,
		);
		const findings = findDeadInterfaceFields(join(tmp, "src"), join(tmp, "src"));
		const dead = findings.map((f) => f.field);
		expect(dead).toContain("isolatedField");
		expect(dead).not.toContain("reachable");
	});

	it("does NOT flag a field that is destructured in a sibling file", () => {
		const dir = join(tmp, "src");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "types.ts"),
			`export interface Pair {\n  left: number;\n  right: number;\n}\n`,
		);
		writeFileSync(
			join(dir, "consumer.ts"),
			`import { Pair } from "./types.js";\nexport function sum({ left, right }: Pair) { return left + right; }\n`,
		);
		const findings = findDeadInterfaceFields(dir, dir);
		expect(findings.map((f) => f.field)).not.toContain("left");
		expect(findings.map((f) => f.field)).not.toContain("right");
	});

	it("ignores a colocated test that asserts the field's value (test-only consumer is dead)", () => {
		// This is the regression class: the only thing reading `quality_checks_enabled`
		// was the modes test that asserted its literal contents. Production code
		// never read it, so the field was dead spec.
		const dir = join(tmp, "src");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "types.ts"),
			`export interface Preset {\n  name: string;\n  qualityChecksEnabled: Record<string, boolean>;\n}\n`,
		);
		// Colocated test that reads the field but does nothing functional with it.
		writeFileSync(
			join(dir, "types.test.ts"),
			`import type { Preset } from "./types.js";\nimport { describe, it, expect } from "vitest";\nconst p: Preset = { name: "x", qualityChecksEnabled: { a: true } };\ndescribe("preset", () => { it("has a map", () => { expect(p.qualityChecksEnabled).toBeDefined(); }); });\n`,
		);
		// Consumer that reads `name` but NOT the map.
		writeFileSync(
			join(dir, "consumer.ts"),
			`import type { Preset } from "./types.js";\nexport function format(p: Preset) { return p.name; }\n`,
		);
		const findings = findDeadInterfaceFields(dir, dir);
		const dead = findings.map((f) => f.field);
		expect(dead).toContain("qualityChecksEnabled");
		expect(dead).not.toContain("name");
	});

	it("does NOT flag a field read in a non-colocated test (test is a real consumer)", () => {
		// e.g. an integration test in __tests__/ that exercises the full
		// loader → preset → output pipeline. That test counts as a
		// production-shaped consumer.
		const dir = join(tmp, "src");
		mkdirSync(join(dir, "__tests__"), { recursive: true });
		writeFileSync(
			join(dir, "types.ts"),
			`export interface Preset {\n  qualityChecksEnabled: Record<string, boolean>;\n}\n`,
		);
		writeFileSync(
			join(dir, "__tests__", "integration.test.ts"),
			`import type { Preset } from "../types.js";\nfunction loaderApplies(p: Preset) { for (const [k, v] of Object.entries(p.qualityChecksEnabled)) { void k; void v; } }\nloaderApplies({} as Preset);\n`,
		);
		const findings = findDeadInterfaceFields(dir, dir);
		expect(findings.map((f) => f.field)).not.toContain("qualityChecksEnabled");
	});

	it("returns the file:line of the dead field for a useful failure message", () => {
		const dir = join(tmp, "src");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "types.ts"),
			`export interface Settings {\n  // line 2 comment\n  unused: string;\n}\n`,
		);
		writeFileSync(
			join(dir, "consumer.ts"),
			`import type { Settings } from "./types.js";\nexport const s = {} as Settings;\n`,
		);
		const findings = findDeadInterfaceFields(dir, dir);
		expect(findings.length).toBeGreaterThan(0);
		const dead = findings.find((f) => f.field === "unused");
		expect(dead).toBeDefined();
		expect(dead?.line).toBe(3);
		expect(dead?.containerName).toBe("Settings");
	});

	it("ignores method signatures (not contract surface this check covers)", () => {
		const dir = join(tmp, "src");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "types.ts"),
			`export interface Logger {\n  log(message: string): void;\n  unusedField: string;\n}\n`,
		);
		writeFileSync(
			join(dir, "consumer.ts"),
			`import type { Logger } from "./types.js";\nexport const noop: Logger = { log: () => {}, unusedField: "" };\n`,
		);
		const findings = findDeadInterfaceFields(dir, dir);
		// `log` is a method — even if no caller, this check shouldn't flag
		// it (different concern: dead-method analysis lives elsewhere).
		expect(findings.map((f) => f.field)).not.toContain("log");
	});

	it("returns empty when the target directory has no interfaces", () => {
		const dir = join(tmp, "src");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "consumer.ts"), `export function f() { return 1; }\n`);
		expect(findDeadInterfaceFields(dir, dir)).toEqual([]);
	});

	it("returns empty when targetDir/searchRoot don't exist (walkSourceFiles readdirSync catch)", () => {
		const missing = join(tmp, "does-not-exist");
		expect(findDeadInterfaceFields(missing, missing)).toEqual([]);
	});

	it("skips a broken symlink entry while walking instead of throwing (walkSourceFiles statSync catch)", () => {
		const dir = join(tmp, "src");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "types.ts"),
			`export interface Settings {\n  isolatedField: number;\n}\n`,
		);
		// A dangling symlink is listed by readdirSync but statSync on it throws
		// ENOENT — the walk must skip it rather than crash.
		symlinkSync(join(dir, "ghost-target.ts"), join(dir, "broken-link.ts"));
		const findings = findDeadInterfaceFields(dir, dir);
		expect(findings.map((f) => f.field)).toContain("isolatedField");
	});

	it("skips an unreadable declaring file instead of throwing (extractInterfaceFields readFileSync catch)", () => {
		const dir = join(tmp, "src");
		mkdirSync(dir, { recursive: true });
		const declPath = join(dir, "secret.ts");
		writeFileSync(declPath, `export interface Settings {\n  isolatedField: number;\n}\n`);
		chmodSync(declPath, 0o000);
		try {
			// The file can't be read, so extractInterfaceFields returns [] for it —
			// no crash, and no finding for a field the detector never saw.
			const findings = findDeadInterfaceFields(dir, dir);
			expect(findings.map((f) => f.field)).not.toContain("isolatedField");
		} finally {
			chmodSync(declPath, 0o644);
		}
	});

	it("skips an unreadable corpus file while searching for reads instead of throwing (fieldIsReadElsewhere readFileSync catch)", () => {
		const dir = join(tmp, "src");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "types.ts"),
			`export interface Settings {\n  isolatedField: number;\n}\n`,
		);
		// This file DOES read isolatedField, but it's unreadable — the search
		// must fail open (treat it as "not a read") rather than throw, so the
		// field still comes back as dead-looking rather than crashing the run.
		const consumerPath = join(dir, "consumer.ts");
		writeFileSync(
			consumerPath,
			`import type { Settings } from "./types.js";\nexport function f(s: Settings) { return s.isolatedField; }\n`,
		);
		chmodSync(consumerPath, 0o000);
		try {
			const findings = findDeadInterfaceFields(dir, dir);
			expect(findings.map((f) => f.field)).toContain("isolatedField");
		} finally {
			chmodSync(consumerPath, 0o644);
		}
	});
});

describe("findDeadInterfaceFields — applied to src/harness/rules/", () => {
	// Integration check: run the detector against the live rules dir. Any
	// new dead field surfaces as a test failure. The current set of fields
	// is contractually expected to be all-live after the Phase C fix that
	// wired `quality_checks_enabled` into the loader.
	it("the harness/rules/ public surface contains no dead interface fields", () => {
		const repoRoot = join(__dirname, "..", "..", "..");
		const findings = findDeadInterfaceFields(
			join(repoRoot, "src", "harness", "rules"),
			join(repoRoot, "src"),
		);
		// Render a useful failure message — the field path is what a future
		// agent or reviewer needs to act on.
		const lines = findings.map(
			(f) => `  ${f.file}:${f.line}  ${f.containerName}.${f.field}`,
		);
		expect(
			findings,
			lines.length === 0
				? "no dead fields"
				: `dead-spec fields detected:\n${lines.join("\n")}`,
		).toEqual([]);
	});
});
