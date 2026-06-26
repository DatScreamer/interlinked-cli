// Regression test for the test-file detection scoping fix flagged in the
// Plan 08 review.
//
// Background: `isTestFile` exempted any path containing `/harness/rules/`,
// `/harness/check-registry/`, etc. Those substrings are common enough that
// a real user project with similarly-named directories had its checks
// silently disabled — the harness internals exemption "leaked" into user
// code. The fix scopes those exemptions to interlinked-cli's own resolved
// package root: a path must start with the package root AND match the
// existing tail substrings to qualify.

import { afterEach, describe, expect, it } from "vitest";
import { __setPackageRootForTesting, isTestFile } from "../shared.js";

describe("isTestFile harness-internals scoping (Plan 08 review fix)", () => {
	afterEach(() => {
		// Reset cache so subsequent tests pick up the real package root.
		__setPackageRootForTesting(undefined);
	});

	it("exempts harness internals when path is under interlinked-cli's package root", () => {
		__setPackageRootForTesting("/path/to/interlinked-cli");
		expect(
			isTestFile("/path/to/interlinked-cli/src/harness/rules/builtin-rules.ts"),
		).toBe(true);
		expect(
			isTestFile(
				"/path/to/interlinked-cli/src/harness/check-registry/entries-warnings.ts",
			),
		).toBe(true);
		expect(
			isTestFile("/path/to/interlinked-cli/src/harness/check-metadata.ts"),
		).toBe(true);
		expect(
			isTestFile(
				"/path/to/interlinked-cli/src/harness/checks/ubs-language-specific.ts",
			),
		).toBe(true);
		// The decomposed write-content-guards-*.ts family — each guard module holds
		// detection patterns (chmod / CORS / eval / JSON.parse) AS DATA. Both the
		// orchestrator AND its `-content-quality` sibling must be exempt (regression:
		// the old pattern ended in a `.` so it matched only write-content-guards.ts).
		expect(
			isTestFile("/path/to/interlinked-cli/src/harness/evaluator/write-content-guards.ts"),
		).toBe(true);
		expect(
			isTestFile(
				"/path/to/interlinked-cli/src/harness/evaluator/write-content-guards-content-quality.ts",
			),
		).toBe(true);
	});

	it("does NOT exempt harness-named directories in user projects", () => {
		__setPackageRootForTesting("/path/to/interlinked-cli");
		// User project with its own /harness/rules/ — must not inherit the
		// exemption. Without scoping, this would return true and silently
		// disable checks on the user's source.
		expect(
			isTestFile("/Users/alice/my-project/src/harness/rules/policy.ts"),
		).toBe(false);
		expect(
			isTestFile("/Users/alice/my-project/harness/check-registry/all.ts"),
		).toBe(false);
		expect(
			isTestFile("/var/www/app/harness/check-metadata.ts"),
		).toBe(false);
		// A user project with its own write-content-guards-content-quality.ts is
		// real code, not interlinked's detector source — it must still be scanned.
		expect(
			isTestFile(
				"/Users/alice/my-project/src/harness/evaluator/write-content-guards-content-quality.ts",
			),
		).toBe(false);
	});

	it("does NOT exempt anything when package root resolution failed (fail-closed)", () => {
		__setPackageRootForTesting(null);
		expect(
			isTestFile("/path/to/interlinked-cli/src/harness/rules/builtin-rules.ts"),
		).toBe(false);
	});

	it("still exempts ordinary test paths (the existing behavior is unchanged)", () => {
		// Unrelated to harness-internals scoping — verify the existing test-
		// path branches still fire regardless of the package-root cache.
		__setPackageRootForTesting(null);
		expect(isTestFile("/Users/alice/proj/src/foo.test.ts")).toBe(true);
		expect(isTestFile("/Users/alice/proj/src/foo.spec.ts")).toBe(true);
		expect(isTestFile("/Users/alice/proj/src/__tests__/foo.ts")).toBe(true);
		expect(isTestFile("/Users/alice/proj/tests/foo.ts")).toBe(true);
	});

	it("treats source-like paths in user projects as non-test", () => {
		__setPackageRootForTesting("/path/to/interlinked-cli");
		expect(isTestFile("/Users/alice/my-project/src/index.ts")).toBe(false);
		expect(isTestFile("/Users/alice/my-project/lib/auth.ts")).toBe(false);
	});
});
