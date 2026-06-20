// ===========================================
// Per-Language Test Dispatchers for `affected_tests`
// ===========================================
// Dispatches the affected_tests quality check to a language-appropriate
// test runner (vitest, pytest, cargo test, go test). Each dispatcher owns
// its own invocation shape and pre-existing-failure classification.
//
// Keeps the runQualityChecks main body lean: the dispatch loop in
// quality-checks.ts just looks up the dispatcher by LanguageId and calls it.

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import type { LanguageId, LanguageProfile } from "../types.js";
import { buildTestCandidates, classifyTestFailure } from "./test-classifier.js";

export interface TestDispatcherInput {
	/** Path as reported by the agent (may be relative) */
	filePath: string;
	/** Absolute filesystem path of the edited file */
	absPath: string;
	/** Project root resolved by findProjectRoot() */
	checkCwd: string;
	/** LanguageProfile for the edited file's language */
	profile: LanguageProfile;
	/** Per-check timeout from config */
	timeoutMs: number;
	/** Configured severity (forwarded into every result) */
	severity: "error" | "warning";
	/** Check name to stamp on results (usually "affected_tests") */
	checkName: string;
}

export interface TestDispatcherResult {
	name: string;
	severity: "error" | "warning";
	message: string;
	file: string;
	detail: string;
}

/**
 * Dispatch an affected_tests run for the given language. Returns zero or
 * more results to append to the check pipeline's findings. Must never
 * throw; all errors become "silent skip" so a missing toolchain doesn't
 * spam the agent.
 */
type TestDispatcher = (input: TestDispatcherInput) => TestDispatcherResult[];

/** Public API — consumed by quality-checks.runQualityChecks. */
export const TEST_DISPATCHERS: Partial<Record<LanguageId, TestDispatcher>> = {
	typescript: runVitestDispatcher,
	python: runPytestDispatcher,
	rust: runCargoTestDispatcher,
	go: runGoTestDispatcher,
};

// ===========================================
// Shared helpers
// ===========================================

function truncateTail(output: string, lines = 8): string {
	return output.split("\n").slice(-lines).join("\n");
}

function combinedOutput(result: SpawnSyncReturns<string>): string {
	const stdout = (result.stdout || "").trim();
	const stderr = (result.stderr || "").trim();
	if (stdout && stderr) return `${stderr}\n${stdout}`;
	return stdout || stderr;
}

function isToolNotInstalled(result: SpawnSyncReturns<string>): boolean {
	return !!result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT";
}

// ===========================================
// TypeScript / JavaScript (vitest)
// ===========================================
// Extracted verbatim from the pre-refactor quality-checks.ts block.
// First tries `vitest --related` for module-graph-aware discovery, then
// falls back to filename-convention test lookup.

function runVitestDispatcher(input: TestDispatcherInput): TestDispatcherResult[] {
	const { filePath, absPath, profile, checkCwd, timeoutMs, severity, checkName } = input;
	const results: TestDispatcherResult[] = [];
	const runnerCmd = profile.test_runner?.command || "npx vitest run";
	if (!runnerCmd.includes("vitest")) return [];

	// 1) vitest --related
	const relatedResult = spawnSync(
		"npx",
		["vitest", "run", "--related", absPath, "--reporter=verbose"],
		{
			shell: false,
			timeout: timeoutMs,
			cwd: checkCwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	const relatedOutput = combinedOutput(relatedResult);
	const unknownOption = /unknown option/i.test(relatedOutput);
	let ranViaRelated = false;

	if (!relatedResult.error && relatedResult.status !== null && !unknownOption) {
		ranViaRelated = true;
		if (relatedResult.status !== 0) {
			const classification = classifyTestFailure(
				`related:${absPath}`,
				relatedOutput,
				"typescript",
			);
			if (classification !== "pre-existing") {
				results.push({
					name: checkName,
					severity,
					message: `Tests failed for ${filePath} (vitest --related)`,
					file: filePath,
					detail: truncateTail(relatedOutput),
				});
			}
		}
	}

	// 2) Convention fallback
	if (!ranViaRelated) {
		const ext = extname(absPath);
		const base = absPath.slice(0, -ext.length);
		const dir = dirname(absPath);
		const baseName = absPath.slice(dir.length + 1, -ext.length);
		const candidates = buildTestCandidates(absPath, ext, base, dir, baseName, profile);
		const testFile = candidates.find((t) => existsSync(t));
		if (testFile) {
			const relTest = testFile.startsWith(checkCwd)
				? testFile.slice(checkCwd.length + 1)
				: testFile;
			const runnerParts = runnerCmd.split(/\s+/).filter(Boolean);
			const result = spawnSync(
				nonNull(runnerParts[0]),
				[...runnerParts.slice(1), relTest, "--reporter=verbose"],
				{
					shell: false,
					timeout: timeoutMs,
					cwd: checkCwd,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			if (isToolNotInstalled(result)) return results;
			if (result.status !== 0 && result.status !== null) {
				const output = combinedOutput(result);
				const classification = classifyTestFailure(`conv:${relTest}`, output, "typescript");
				if (classification !== "pre-existing") {
					results.push({
						name: checkName,
						severity,
						message: `Tests failed for ${filePath} (${relTest})`,
						file: filePath,
						detail: truncateTail(output),
					});
				}
			}
		}
	}

	return results;
}

// ===========================================
// Python (pytest)
// ===========================================
// Uses filename convention via LANG_TEST_CANDIDATE_EMITTERS.python. Runs
// `python -m pytest <testfile> -x --tb=short -q` so the test runner doesn't
// collect the whole project — we only care about tests related to the
// edited source file.

function runPytestDispatcher(input: TestDispatcherInput): TestDispatcherResult[] {
	const testFile = findFirstExistingCandidate(input.absPath, input.profile);
	if (!testFile) return [];
	const rel = relativizeFromRoot(testFile, input.checkCwd);
	const result = spawnSync(
		"python",
		["-m", "pytest", "-x", "--tb=short", "-q", rel],
		{
			shell: false,
			timeout: input.timeoutMs,
			cwd: input.checkCwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	if (isToolNotInstalled(result)) return [];
	if (result.status === 0 || result.status === null) return [];

	const output = combinedOutput(result);
	const classification = classifyTestFailure(`pytest:${rel}`, output, "python");
	if (classification === "pre-existing") return [];

	return [
		{
			name: input.checkName,
			severity: input.severity,
			message: `Tests failed for ${input.filePath} (pytest ${rel})`,
			file: input.filePath,
			detail: truncateTail(output),
		},
	];
}

// ===========================================
// Rust (cargo test --no-run)
// ===========================================
// Cargo tests are project-wide; no per-file scoping. We compile-check with
// `--no-run` to catch test build breakage without the cost of actual
// execution. The whole-project nature means we must be strict about
// classifying pre-existing (unresolved imports, missing manifest) — a
// false-positive here silently hides a real regression.

function runCargoTestDispatcher(input: TestDispatcherInput): TestDispatcherResult[] {
	const result = spawnSync(
		"cargo",
		["test", "--no-run", "--message-format=short"],
		{
			shell: false,
			timeout: input.timeoutMs,
			cwd: input.checkCwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	if (isToolNotInstalled(result)) return [];
	if (result.status === 0 || result.status === null) return [];

	const output = combinedOutput(result);
	const classification = classifyTestFailure(`cargo:${input.checkCwd}`, output, "rust");
	if (classification === "pre-existing") return [];

	return [
		{
			name: input.checkName,
			severity: input.severity,
			message: `Tests failed to compile for ${input.filePath} (cargo test --no-run)`,
			file: input.filePath,
			detail: truncateTail(output),
		},
	];
}

// ===========================================
// Go (go test ./<pkgdir>)
// ===========================================
// Scopes to the edited file's package. Running `go test ./...` on every
// edit is too slow and pollutes output with failures in unrelated packages.

function runGoTestDispatcher(input: TestDispatcherInput): TestDispatcherResult[] {
	const pkgDir = dirname(input.absPath);
	const relPkg = relative(input.checkCwd, pkgDir) || ".";
	// Prepend ./ to avoid accidental module-path interpretation.
	const pkgArg = relPkg.startsWith(".") ? relPkg : `./${relPkg.split(sep).join("/")}`;

	const result = spawnSync("go", ["test", "-count=1", pkgArg], {
		shell: false,
		timeout: input.timeoutMs,
		cwd: input.checkCwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (isToolNotInstalled(result)) return [];
	if (result.status === 0 || result.status === null) return [];

	const output = combinedOutput(result);
	const classification = classifyTestFailure(`gotest:${pkgArg}`, output, "go");
	if (classification === "pre-existing") return [];

	return [
		{
			name: input.checkName,
			severity: input.severity,
			message: `Tests failed for ${input.filePath} (go test ${pkgArg})`,
			file: input.filePath,
			detail: truncateTail(output),
		},
	];
}

// ===========================================
// Small local helpers
// ===========================================

function findFirstExistingCandidate(
	absPath: string,
	profile: LanguageProfile,
): string | null {
	const ext = extname(absPath);
	const base = absPath.slice(0, -ext.length);
	const dir = dirname(absPath);
	const baseName = absPath.slice(dir.length + 1, -ext.length);
	const candidates = buildTestCandidates(absPath, ext, base, dir, baseName, profile);
	return candidates.find((t) => existsSync(t)) ?? null;
}

function relativizeFromRoot(absPath: string, root: string): string {
	if (absPath.startsWith(root)) {
		const rest = absPath.slice(root.length);
		return rest.startsWith(sep) ? rest.slice(1) : rest;
	}
	return absPath;
}

// Exported helpers for tests. Dispatcher internals stay private otherwise.
export const __test_only__ = {
	runVitestDispatcher,
	runPytestDispatcher,
	runCargoTestDispatcher,
	runGoTestDispatcher,
	relativizeFromRoot,
};

// Keep the TestDispatcher type reachable by tests/extensions without
// re-exporting it publicly — prevents accidental consumer-side coupling
// while giving us a symbol for docs and future extension points.
export type __TestDispatcher = TestDispatcher;
