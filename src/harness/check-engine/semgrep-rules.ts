// ===========================================
// Interlinked semgrep starter rule pack
// ===========================================
//
// A small, committed set of polyglot AST patterns the harness's regex
// detectors can't express cleanly — SQL- and command-injection shapes across
// Go, Java, and Python that need real call/argument structure, not line
// regex. Shipped as an embedded object (JSON is valid YAML, so semgrep loads
// it directly AND we get native validation for free) and materialized to a
// memoized temp file at scan time, then handed to semgrep via a second
// `--config` alongside `p/default`. If it can't be written, semgrep still
// runs with the default ruleset — graceful, never an error.
//
// Keep this SMALL and high-signal: it complements semgrep's registry rules,
// it does not replace them, and it covers the gaps our hand-regex shouldn't
// (per the "lean on semgrep for language-semantic patterns" direction). All
// deterministic AST matching — no LLM.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const INTERLINKED_SEMGREP_RULES = {
	rules: [
		{
			id: "interlinked-go-sql-sprintf",
			languages: ["go"],
			severity: "WARNING",
			message:
				"SQL query built with fmt.Sprintf. Use parameterized queries (placeholders + args) — interpolating into the query string is a SQL-injection vector.",
			metadata: { category: "security", source: "interlinked", cwe: "CWE-89" },
			patterns: [
				{
					"pattern-either": [
						{ pattern: "$DB.Query(fmt.Sprintf(...), ...)" },
						{ pattern: "$DB.QueryContext($CTX, fmt.Sprintf(...), ...)" },
						{ pattern: "$DB.Exec(fmt.Sprintf(...), ...)" },
						{ pattern: "$DB.ExecContext($CTX, fmt.Sprintf(...), ...)" },
					],
				},
			],
		},
		{
			id: "interlinked-go-exec-shell-sprintf",
			languages: ["go"],
			severity: "WARNING",
			message:
				"exec invokes a shell with an fmt.Sprintf-built command string. Pass argv directly instead of `sh -c <built string>` to avoid command injection.",
			metadata: { category: "security", source: "interlinked", cwe: "CWE-78" },
			patterns: [
				{
					"pattern-either": [
						{ pattern: 'exec.Command("sh", "-c", fmt.Sprintf(...))' },
						{ pattern: 'exec.Command("bash", "-c", fmt.Sprintf(...))' },
						{ pattern: 'exec.CommandContext($CTX, "sh", "-c", fmt.Sprintf(...))' },
						{ pattern: 'exec.CommandContext($CTX, "bash", "-c", fmt.Sprintf(...))' },
					],
				},
			],
		},
		{
			id: "interlinked-java-sql-concat",
			languages: ["java"],
			severity: "WARNING",
			message:
				"SQL built by string concatenation passed to a Statement. Use PreparedStatement with bind parameters instead of concatenating user input.",
			metadata: { category: "security", source: "interlinked", cwe: "CWE-89" },
			patterns: [
				{
					"pattern-either": [
						{ pattern: '$STMT.executeQuery("..." + ...)' },
						{ pattern: '$STMT.executeUpdate("..." + ...)' },
						{ pattern: '$STMT.execute("..." + ...)' },
					],
				},
			],
		},
		{
			id: "interlinked-python-os-system-fstring",
			languages: ["python"],
			severity: "WARNING",
			message:
				"os.system with an f-string interpolates into a shell command — command-injection risk. Use subprocess.run([...]) with an argv list.",
			metadata: { category: "security", source: "interlinked", cwe: "CWE-78" },
			patterns: [{ pattern: 'os.system(f"...")' }],
		},
	],
} as const;

/**
 * Materialize the embedded pack to a content-hashed temp file under
 * `baseDir/interlinked-semgrep/` and return its absolute path, or null if it
 * could not be written. The hashed filename makes this idempotent — the file
 * is written once and reused across scans/processes. `baseDir` is injectable
 * for tests; production callers use the OS temp dir.
 */
export function interlinkedSemgrepConfigPath(baseDir: string = tmpdir()): string | null {
	try {
		const json = JSON.stringify(INTERLINKED_SEMGREP_RULES);
		const hash = createHash("sha256").update(json).digest("hex").slice(0, 16);
		const dir = join(baseDir, "interlinked-semgrep");
		const file = join(dir, `rules-${hash}.yml`);
		if (!existsSync(file)) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, json);
		}
		return file;
	} catch {
		return null;
	}
}

/**
 * Semgrep `--config` arguments for the embedded pack: `["--config", <path>]`,
 * or `[]` when the pack could not be materialized (so `p/default` still runs).
 * Spread into the semgrep argv in `tool-runners/generic.ts`.
 */
export function interlinkedSemgrepConfigArgs(baseDir: string = tmpdir()): string[] {
	const p = interlinkedSemgrepConfigPath(baseDir);
	return p ? ["--config", p] : [];
}
