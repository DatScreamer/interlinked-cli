// Smoke tests for the split quality-checks helper modules. Behavior is
// covered by src/harness/__tests__/quality-checks.test.ts; these tests just
// verify each extracted module exports the expected symbols and handles a
// representative happy-path input.

import { describe, expect, it } from "vitest";
import { resolveDependencyAuditCommand } from "./dependency-audit.js";
import { TOOL_CHECK_INSTRUCTIONS } from "./instructions.js";
import { checkLockfileDrift, LOCKFILE_MAP } from "./lockfile-drift.js";
import { checkPackageJsonConsistency } from "./package-json.js";
import { ProjectWideSweepState } from "./project-wide.js";
import {
	countAsAnyCasts,
	countNonNullAssertions,
	countSuppressionDirectives,
} from "./ratchet-metrics.js";
import { containsSecrets } from "./secret-detection.js";
import { findAnyTypes, stripStringLiterals } from "./strong-typing.js";
import { classifyTestFailure, isLikelyTestFile } from "./test-classifier.js";

describe("quality-checks submodules (smoke)", () => {
	it("secret-detection finds known token formats", () => {
		// Build an AWS-access-key-shaped fixture from parts — a random 16-char
		// body so it clears the entropy floor — so this test file itself
		// doesn't read as a committed secret.
		const fixture = `AKIA${"J7QX2M9FD3KP1WZ8"}`;
		expect(containsSecrets(`const k = '${fixture}'`).length).toBeGreaterThan(0);
		expect(containsSecrets("const k = 'plain'")).toEqual([]);
	});

	it("ratchet-metrics counts suppressions, `as any`, and non-null assertions", () => {
		// Build the directive fixtures from parts so this test file itself does
		// not register as containing suppression directives.
		const ts = `// @ts${"-"}ignore`;
		const es = `// eslint${"-"}disable`;
		expect(countSuppressionDirectives(`${ts}\n${es}`)).toBe(2);
		expect(countAsAnyCasts("foo as any; bar as any")).toBe(2);
		expect(countNonNullAssertions("foo!.bar; x![0]")).toBe(2);
	});

	it("strong-typing finds explicit any and strips string literals", () => {
		const matches = findAnyTypes("const x: any = 1");
		expect(matches.length).toBeGreaterThan(0);
		expect(stripStringLiterals(`const s = "hello"`)).toContain('""');
	});

	it("dependency-audit maps manifest names to commands (osv opt-out)", () => {
		// Force the legacy per-ecosystem fallback so this test doesn't depend on
		// whether osv-scanner happens to be installed on the runner.
		const opts = { useOsvScanner: false };
		expect(resolveDependencyAuditCommand("package.json", opts)?.cmd[0]).toBe("npm");
		expect(resolveDependencyAuditCommand("package.json", opts)?.parser).toBe("npm-audit");
		expect(resolveDependencyAuditCommand("Cargo.toml", opts)?.cmd[0]).toBe("cargo");
		expect(resolveDependencyAuditCommand("Cargo.toml", opts)?.parser).toBe("cargo-audit");
		expect(resolveDependencyAuditCommand("go.mod", opts)?.cmd[0]).toBe("govulncheck");
		expect(resolveDependencyAuditCommand("requirements.txt", opts)?.cmd[0]).toBe("pip-audit");
		expect(resolveDependencyAuditCommand("unknown", opts)).toBeNull();
	});

	it("lockfile-drift exports LOCKFILE_MAP keyed by manifest name", () => {
		expect(LOCKFILE_MAP["package.json"]).toContain("package-lock.json");
		const res = checkLockfileDrift("/tmp/does-not-exist-package.json");
		expect(res).toHaveProperty("drifted");
	});

	it("package-json rejects invalid semver and duplicate deps", () => {
		const issues = checkPackageJsonConsistency(
			JSON.stringify({ dependencies: { foo: "zzzz" }, devDependencies: { foo: "1.0.0" } }),
		);
		expect(issues.some((i) => i.kind === "duplicate")).toBe(true);
		expect(issues.some((i) => i.kind === "invalid_semver")).toBe(true);
	});

	it("test-classifier isLikelyTestFile recognises standard patterns", () => {
		expect(isLikelyTestFile("foo.test", "/a/foo.test.ts")).toBe(true);
		expect(isLikelyTestFile("foo", "/a/__tests__/foo.ts")).toBe(true);
		expect(isLikelyTestFile("foo", "/a/foo.ts")).toBe(false);
	});

	it("test-classifier classifies pre-existing module-resolution failures", () => {
		const out = "Error: Cannot find module './missing'\n  at ...";
		expect(classifyTestFailure("t1", out)).toBe("pre-existing");
	});

	it("project-wide sweep state increments and resets", () => {
		const st = new ProjectWideSweepState();
		st.recordEdit({ edit_interval: 2 } as never);
		expect(st.editsSinceLastSweep).toBe(1);
		st.resetCounter();
		expect(st.editsSinceLastSweep).toBe(0);
	});

	it("instructions map has typescript entry", () => {
		expect(TOOL_CHECK_INSTRUCTIONS.typescript).toContain("Fix the type errors");
	});
});
