// ============================================================
// Interlinked Harness — Project-wide typecheck commit/push gate
// ============================================================
// Asserts the WHOLE PROJECT typechecks before allowing `git commit`
// or `git push`. Diff-UNaware on purpose — fires on pre-existing
// errors in untouched files too.
//
// Why a separate check from the per-edit tsgo runner:
//   - Per-edit checks are diff-aware (only flag issues caused by the
//     current edit). They keep the agent moving and avoid drowning it
//     in pre-existing issues outside its working set.
//   - This gate is diff-UNaware. It asserts CI will pass. Pre-existing
//     errors in untouched files MUST block commits because otherwise:
//       1. The commit lands locally with broken state in HEAD.
//       2. CI fails on push, burning runner minutes + reviewer attention.
//       3. The agent learns the wrong lesson — that broken HEAD is OK.
//   - These two checks coexist: per-edit is "as you type"; this is
//     "before you publish."
//
// Bypass: env var `INTERLINKED_SKIP_PROJECT_TYPECHECK=1`. Emitted as a
// warning entry so audit logs can find bypassed commits later.
//
// Discovery: prefers `npm run typecheck:stable` (matches CI exactly),
// falls back to `npm run typecheck`, then `node_modules/.bin/tsc
// --noEmit` if a tsconfig exists. Returns null (silent no-op) when the
// project has neither a TS script nor a locally-installed tsc — keeps
// the harness inert in non-TS projects AND avoids the `npx tsc` "this
// is not the tsc command" trap on fresh clones without `npm install`.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResultEntry } from "./types.js";

const TYPECHECK_TIMEOUT_MS = 60_000;
const MAX_DIAGS_REPORTED = 50;

export interface ResolvedTypecheckCommand {
	bin: string;
	args: string[];
	source: "typecheck:stable" | "typecheck" | "local-tsc";
}

/** Resolve the project's typecheck command. Null when the project has
 *  neither a typecheck script nor a locally-installed tsc — i.e., not a
 *  TS project (or fresh clone without `npm install`). Gate no-ops in
 *  that case rather than blocking commits we can't reliably verify. */
export function resolveTypecheckCommand(cwd: string): ResolvedTypecheckCommand | null {
	const pkgPath = join(cwd, "package.json");
	let pkg: { scripts?: Record<string, string> } | null = null;
	if (existsSync(pkgPath)) {
		try {
			pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		} catch {
			// Malformed package.json — fall through and check tsconfig directly.
		}
	}
	if (pkg?.scripts?.["typecheck:stable"]) {
		return {
			bin: "npm",
			args: ["run", "--silent", "typecheck:stable"],
			source: "typecheck:stable",
		};
	}
	if (pkg?.scripts?.typecheck) {
		return { bin: "npm", args: ["run", "--silent", "typecheck"], source: "typecheck" };
	}
	if (existsSync(join(cwd, "tsconfig.json"))) {
		const localTsc = join(cwd, "node_modules", ".bin", "tsc");
		if (existsSync(localTsc)) {
			return { bin: localTsc, args: ["--noEmit"], source: "local-tsc" };
		}
		// tsconfig present but TS not installed — can't reliably gate.
	}
	return null;
}

export interface TscDiagnostic {
	file: string;
	line: number;
	col: number;
	code: string;
	message: string;
}

/** Parse TypeScript's `path/to/file.ts(line,col): error TSxxxx: msg`
 *  format. Robust to interleaved noise (npm preamble, "Found N errors",
 *  blank lines). Returns diagnostics in source order. */
export function parseTscDiagnostics(stdout: string): TscDiagnostic[] {
	const diags: TscDiagnostic[] = [];
	for (const line of stdout.split("\n")) {
		const m = line.match(/^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/);
		if (!m) continue;
		diags.push({
			file: m[1],
			line: Number.parseInt(m[2], 10),
			col: Number.parseInt(m[3], 10),
			code: m[4],
			message: m[5].trim(),
		});
	}
	return diags;
}

/** Run the project's typecheck and return one CheckResultEntry per
 *  diagnostic (capped at 50). Empty array on success. Returns a single
 *  "skipped" warning entry when bypassed via env var so the audit log
 *  records the bypass. */
export function checkProjectTypecheckClean(cwd: string): CheckResultEntry[] {
	if (process.env.INTERLINKED_SKIP_PROJECT_TYPECHECK === "1") {
		return [
			{
				source: "structural",
				name: "project_typecheck_skipped",
				severity: "warning",
				message:
					"Project typecheck gate bypassed via INTERLINKED_SKIP_PROJECT_TYPECHECK=1. Verify CI manually before merging.",
				determinism: "fully_deterministic",
			},
		];
	}

	const cmd = resolveTypecheckCommand(cwd);
	if (!cmd) return [];

	const result = spawnSync(cmd.bin, cmd.args, {
		cwd,
		encoding: "utf-8",
		timeout: TYPECHECK_TIMEOUT_MS,
	});

	if (result.error) {
		return [
			{
				source: "structural",
				name: "project_typecheck_failed_to_run",
				severity: "warning",
				message: `Project typecheck (${cmd.source}) could not run: ${result.error.message}. Verify CI manually.`,
				determinism: "fully_deterministic",
			},
		];
	}

	if (result.signal === "SIGTERM" || result.status === null) {
		return [
			{
				source: "structural",
				name: "project_typecheck_timed_out",
				severity: "warning",
				message: `Project typecheck (${cmd.source}) exceeded ${TYPECHECK_TIMEOUT_MS / 1000}s timeout. Verify CI manually.`,
				determinism: "fully_deterministic",
			},
		];
	}

	if (result.status === 0) return [];

	const diags = parseTscDiagnostics(`${result.stdout || ""}\n${result.stderr || ""}`);
	if (diags.length === 0) {
		const raw = (result.stdout || result.stderr || "").trim().slice(0, 500);
		return [
			{
				source: "structural",
				name: "project_typecheck_clean",
				severity: "error",
				message: `Project typecheck (${cmd.source}) failed (exit ${result.status}) but no TS diagnostics parsed. Raw output: ${raw}`,
				determinism: "fully_deterministic",
			},
		];
	}

	return diags.slice(0, MAX_DIAGS_REPORTED).map((d) => ({
		source: "structural",
		name: "project_typecheck_clean",
		severity: "error" as const,
		message: `${d.file}:${d.line}:${d.col} — ${d.code}: ${d.message}`,
		file: d.file,
		determinism: "fully_deterministic",
	}));
}
