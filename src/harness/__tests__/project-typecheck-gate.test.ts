// Tests for the project-wide typecheck commit/push gate. The gate runs
// the project's typecheck script (matches CI exactly) and surfaces ALL
// diagnostics — pre-existing or not. This is the safety net that
// prevents an agent from ignoring tsc errors in untouched files.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkProjectTypecheckClean,
	parseTscDiagnostics,
	resolveTypecheckCommand,
} from "../project-typecheck-gate.js";

let tmp: string;
let savedEnv: string | undefined;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-tcgate-"));
	savedEnv = process.env.INTERLINKED_SKIP_PROJECT_TYPECHECK;
	delete process.env.INTERLINKED_SKIP_PROJECT_TYPECHECK;
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	if (savedEnv === undefined) delete process.env.INTERLINKED_SKIP_PROJECT_TYPECHECK;
	else process.env.INTERLINKED_SKIP_PROJECT_TYPECHECK = savedEnv;
});

describe("resolveTypecheckCommand", () => {
	it("prefers `typecheck:stable` because that's what CI runs", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					typecheck: "tsgo --noEmit",
					"typecheck:stable": "tsc --noEmit",
				},
			}),
		);
		const cmd = resolveTypecheckCommand(tmp);
		expect(cmd?.source).toBe("typecheck:stable");
		expect(cmd?.bin).toBe("npm");
		expect(cmd?.args).toEqual(["run", "--silent", "typecheck:stable"]);
	});

	it("falls back to `typecheck` when `typecheck:stable` is absent", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }),
		);
		const cmd = resolveTypecheckCommand(tmp);
		expect(cmd?.source).toBe("typecheck");
	});

	it("falls back to local node_modules/.bin/tsc when only tsconfig.json is present", () => {
		writeFileSync(join(tmp, "package.json"), JSON.stringify({}));
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
		mkdirSync(join(tmp, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(tmp, "node_modules", ".bin", "tsc"), "#!/bin/sh\nexit 0\n");
		const cmd = resolveTypecheckCommand(tmp);
		expect(cmd?.source).toBe("local-tsc");
		expect(cmd?.bin).toBe(join(tmp, "node_modules", ".bin", "tsc"));
		expect(cmd?.args).toEqual(["--noEmit"]);
	});

	it("returns null when tsconfig exists but tsc isn't installed (fresh clone)", () => {
		// The "fresh clone with no `npm install`" case. We can't reliably
		// gate without tsc, so we MUST no-op rather than block — blocking
		// would prevent any commit until the user runs `npm install`.
		writeFileSync(join(tmp, "package.json"), JSON.stringify({}));
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
		expect(resolveTypecheckCommand(tmp)).toBeNull();
	});

	it("returns null for non-TS projects (no scripts, no tsconfig)", () => {
		// Python repo, Go repo, doc-only repo, etc. The gate should be
		// silent there — never block, never warn.
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "py-repo" }));
		expect(resolveTypecheckCommand(tmp)).toBeNull();
	});

	it("returns null for a directory with neither package.json nor tsconfig.json", () => {
		expect(resolveTypecheckCommand(tmp)).toBeNull();
	});

	it("survives a malformed package.json by falling back to tsconfig+local-tsc probe", () => {
		writeFileSync(join(tmp, "package.json"), "{ this is not json");
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
		mkdirSync(join(tmp, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(tmp, "node_modules", ".bin", "tsc"), "#!/bin/sh\nexit 0\n");
		expect(resolveTypecheckCommand(tmp)?.source).toBe("local-tsc");
	});
});

describe("parseTscDiagnostics", () => {
	it("parses one diagnostic per error line", () => {
		const out = [
			"src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
			"src/bar.ts(7,1): error TS2783: 'x' is specified more than once.",
		].join("\n");
		const diags = parseTscDiagnostics(out);
		expect(diags).toHaveLength(2);
		expect(diags[0]).toEqual({
			file: "src/foo.ts",
			line: 10,
			col: 5,
			code: "TS2322",
			message: "Type 'string' is not assignable to type 'number'.",
		});
		expect(diags[1].code).toBe("TS2783");
	});

	it("ignores npm-script preamble and 'Found N errors' summary lines", () => {
		const out = [
			"> interlinked-cli@0.1.0 typecheck:stable",
			"> tsc --noEmit",
			"",
			"src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
			"",
			"Found 1 error in src/foo.ts:10",
		].join("\n");
		const diags = parseTscDiagnostics(out);
		expect(diags).toHaveLength(1);
		expect(diags[0].file).toBe("src/foo.ts");
	});

	it("handles paths with spaces and unicode", () => {
		const out =
			"src/with space/héllo.ts(1,1): error TS9999: Custom check failed — see docs.";
		const diags = parseTscDiagnostics(out);
		expect(diags).toHaveLength(1);
		expect(diags[0].file).toBe("src/with space/héllo.ts");
		expect(diags[0].message).toContain("Custom check failed");
	});

	it("returns empty array on clean output", () => {
		expect(parseTscDiagnostics("")).toEqual([]);
		expect(parseTscDiagnostics("Found 0 errors.\n")).toEqual([]);
	});
});

describe("checkProjectTypecheckClean", () => {
	it("no-ops on a non-TS project (returns empty)", () => {
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "py-repo" }));
		expect(checkProjectTypecheckClean(tmp)).toEqual([]);
	});

	it("emits a warning entry (not an error) when bypassed via env var", () => {
		// Bypass should ALWAYS surface so an audit log can find it later.
		// But it must not block — that's the whole point of bypass.
		process.env.INTERLINKED_SKIP_PROJECT_TYPECHECK = "1";
		const results = checkProjectTypecheckClean(tmp);
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("project_typecheck_skipped");
		expect(results[0].severity).toBe("warning");
		expect(results[0].message).toContain("INTERLINKED_SKIP_PROJECT_TYPECHECK");
	});

	it("returns empty when the typecheck script exits clean", () => {
		// Stub `typecheck:stable` script that exits 0 with no output —
		// the success path. We test against the script wiring rather
		// than spinning up a real tsc subprocess in a temp dir; that
		// would force an `npm install typescript` per test (slow + flaky
		// in CI). The script wiring IS what production exercises.
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { "typecheck:stable": "node -e \"process.exit(0)\"" } }),
		);
		expect(checkProjectTypecheckClean(tmp)).toEqual([]);
	});

	it("returns one error entry per tsc diagnostic when the typecheck script fails", () => {
		// Stub script prints two tsc-format diagnostics on stdout and
		// exits 1. The gate must surface both as error entries with the
		// file reference threaded through.
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					"typecheck:stable":
						'node -e "console.log(\\"src/foo.ts(10,5): error TS2322: bad type.\\");console.log(\\"src/bar.ts(7,1): error TS2783: dup key.\\");process.exit(1)"',
				},
			}),
		);

		const results = checkProjectTypecheckClean(tmp);
		expect(results).toHaveLength(2);
		expect(results.every((r) => r.severity === "error")).toBe(true);
		expect(results.every((r) => r.name === "project_typecheck_clean")).toBe(true);
		expect(results[0].file).toBe("src/foo.ts");
		expect(results[1].file).toBe("src/bar.ts");
		expect(results.every((r) => r.determinism === "fully_deterministic")).toBe(true);
	});

	it("flags pre-existing errors in untouched files — the whole point of the gate", () => {
		// Failure mode: agent edits file A, doesn't touch file B, but
		// file B has a tsc error. Per-edit (diff-aware) checks won't
		// surface it. THIS gate must — that's the contract.
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					"typecheck:stable":
						'node -e "console.log(\\"src/untouched-broken.ts(3,1): error TS2322: pre-existing.\\");process.exit(1)"',
				},
			}),
		);
		const results = checkProjectTypecheckClean(tmp);
		expect(results.some((r) => r.file?.includes("untouched-broken.ts"))).toBe(true);
	});

	it("surfaces unparseable failure output rather than silently allowing", () => {
		// Defensive: if the typecheck script exits non-zero but produces
		// no parseable diagnostics (malformed output, runtime crash,
		// SIGSEGV, etc.), the gate must still BLOCK with a raw-output
		// fallback message. Silent-allow on parse failure would defeat
		// the gate entirely.
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					"typecheck:stable":
						'node -e "console.error(\\"compiler crashed: stack overflow\\");process.exit(2)"',
				},
			}),
		);
		const results = checkProjectTypecheckClean(tmp);
		expect(results).toHaveLength(1);
		expect(results[0].severity).toBe("error");
		expect(results[0].name).toBe("project_typecheck_clean");
		expect(results[0].message).toContain("compiler crashed");
	});
});
