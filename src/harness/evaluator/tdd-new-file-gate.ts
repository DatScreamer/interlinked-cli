// ===========================================
// TDD Gate: new-file creation
// ===========================================
// Blocks creation of a new non-test `.ts`/`.tsx` source file unless a companion
// test file already exists on disk OR was written earlier in the same session.
//
// Runs only when `structural_checks.test_first_mode === "enforce"` (the
// current default). Scope is intentionally narrow — existing files can still
// be Edit'd without a gate; we start with the gentler "new-files-only"
// rollout and will widen to all edits in a follow-up.
//
// Bypasses:
//   - Per-file directive `// interlinked-tdd: exempt` in the first ~400 bytes
//     of the Write content (meant for genuinely untestable surfaces — entry
//     points that only wire DI, generated bridges, etc.).
//   - Path is on the exemption list (tests, fixtures, generated artifacts,
//     type declarations, config files, standalone scripts).

import { existsSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type {
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";

/** The only mode in which this gate fires. Extracted so the conditional reads
 *  as intent; see `types.ts#GuardRulesConfig.structural_checks.test_first_mode`. */
const ENFORCE_MODE: "enforce" = "enforce";

const SOURCE_EXT_RE = /\.(ts|tsx)$/;

// Paths where a companion test isn't meaningful — skip the gate.
const EXEMPT_PATH_RES: readonly RegExp[] = [
	/\.d\.ts$/, // type-only declarations
	/\.test\.tsx?$/, // the tests themselves
	/\.spec\.tsx?$/,
	/(^|\/)__tests__\//,
	/(^|\/)__fixtures__\//,
	/(^|\/)__mocks__\//,
	/(^|\/)dist\//,
	/(^|\/)\.claude\//,
	/(^|\/)\.interlinked\//,
	/(^|\/)node_modules\//,
	/(^|\/)scripts\//, // one-off build/release scripts
	/\.config\.tsx?$/, // vite.config.ts / vitest.config.ts / tsup.config.ts / ...
	// Static-site / deploy-artifact directories — Workers, landing pages,
	// docs sites. These ship as deployed bundles, not as application source,
	// and a unit test for the entrypoint isn't meaningful.
	/(^|\/)landing\//,
	/(^|\/)web\//,
	/(^|\/)site\//,
];

const TDD_EXEMPT_DIRECTIVE_RE = /\/\/\s*interlinked-tdd:\s*exempt\b/;
const EXEMPT_DIRECTIVE_SCAN_BYTES = 400;

export interface TddNewFileGateArgs {
	filePath: string;
	cwd?: string;
	session: SessionTrajectory | undefined;
	content?: string;
	testFirstMode: "nudge" | "warn" | "enforce" | undefined;
}

/** Public API — consumed by `evaluator/pre-tool.ts` on every file-write event.
 *
 *  Returns `null` when the gate is not applicable (wrong mode, wrong ext, in
 *  an exempt path, existing file, or companion found). Returns a `block`
 *  decision when a new `.ts`/`.tsx` file is being created without a
 *  companion test. */
export function evaluateTddNewFileGate(args: TddNewFileGateArgs): HarnessDecision | null {
	if (args.testFirstMode !== ENFORCE_MODE) return null;
	if (!args.filePath) return null;
	if (!SOURCE_EXT_RE.test(args.filePath)) return null;
	if (isExemptPath(args.filePath)) return null;
	if (hasExemptDirective(args.content)) return null;

	const abs = toAbsolute(args.filePath, args.cwd);

	// Only fire on NEW files. Existing-file Edits are part of the later
	// "enforce_all" rollout.
	if (existsSync(abs)) return null;

	const candidates = companionTestCandidates(abs);
	for (const candidate of candidates) {
		if (existsSync(candidate)) return null;
	}
	if (args.session) {
		const writtenAbs = normalizedWrittenSet(args.session, args.cwd);
		for (const candidate of candidates) {
			if (writtenAbs.has(candidate)) return null;
		}
	}

	const hint = companionHintPath(args.filePath);
	const surface = extractPublicSurface(args.content);
	const surfaceLine = surface.length > 0
		? ` Public surface to test (extracted from your content): ${surface.join(", ")}.`
		: "";
	return {
		decision: "block",
		reason:
			`BLOCKED: new source file "${args.filePath}" has no companion test. ` +
			`Red/green TDD is enforced for new .ts/.tsx files. ` +
			`Create ${hint} first with a failing test, then write the implementation. ` +
			`(Searched: ${candidates.map((c) => shortest(c, args.cwd)).join(", ")}.)` +
			surfaceLine +
			` If this file has no testable surface, add "// interlinked-tdd: exempt" as the first line.`,
		rule_id: "tdd_new_file_gate",
		severity: "high",
		category: "tdd",
	};
}

// ===========================================
// Public surface extraction
// ===========================================
// When the gate fires we already have the impl content the agent was
// trying to write. Listing its top-level testable exports in the block
// message saves a Read round-trip when the agent then writes the test —
// they don't have to re-open the impl to remember what to assert against.
//
// We deliberately skip type-only exports (`type`, `interface`) because
// they don't survive to runtime and so can't be asserted on directly.
// Heuristic — regex-based, no AST. Good enough for triage; not a contract.

const EXPORT_FUNCTION_RE = /^\s*export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;
const EXPORT_CLASS_RE = /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/gm;
const EXPORT_VAR_RE = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/gm;
const EXPORT_ENUM_RE = /^\s*export\s+(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\b/gm;
const SURFACE_LIMIT = 10;

function extractPublicSurface(content: string | undefined): string[] {
	if (!content) return [];
	const names = new Set<string>();
	const patterns: readonly RegExp[] = [
		EXPORT_FUNCTION_RE,
		EXPORT_CLASS_RE,
		EXPORT_VAR_RE,
		EXPORT_ENUM_RE,
	];
	for (const re of patterns) {
		// Reset lastIndex because the same regex instance is reused.
		re.lastIndex = 0;
		let m: RegExpExecArray | null = re.exec(content);
		while (m !== null) {
			names.add(m[1]);
			if (names.size >= SURFACE_LIMIT) return [...names];
			m = re.exec(content);
		}
	}
	return [...names];
}

/** Public API — consumed by `evaluator/pre-tool.ts` as a thin event-level
 *  wrapper around `evaluateTddNewFileGate`. Extracts `file_path`/`content`
 *  from the raw tool input so the call site stays a one-liner. */
export function evaluateTddNewFileGateForEvent(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	session: SessionTrajectory | undefined,
): HarnessDecision | null {
	const toolInput = event.tool_input || {};
	return evaluateTddNewFileGate({
		filePath: (toolInput.file_path as string) || (toolInput.path as string) || "",
		cwd: event.cwd,
		session,
		content:
			(toolInput.content as string | undefined) ??
			(toolInput.new_string as string | undefined),
		testFirstMode: rules.structural_checks?.test_first_mode,
	});
}

function isExemptPath(p: string): boolean {
	return isTddExemptPath(p);
}

/**
 * Public re-export of the same path-exemption check used by the new-file
 * gate. Behavioral checks (`checkTddCycleViolation`, `checkTddRegression`)
 * share this list so a file under `landing/` doesn't trip the cycle check
 * after slipping past the new-file gate, and vice versa. Keep both consumers
 * pointed at this helper so the exempt set stays single-sourced.
 */
export function isTddExemptPath(p: string): boolean {
	for (const re of EXEMPT_PATH_RES) {
		if (re.test(p)) return true;
	}
	return false;
}

function hasExemptDirective(content: string | undefined): boolean {
	if (!content) return false;
	return TDD_EXEMPT_DIRECTIVE_RE.test(content.slice(0, EXEMPT_DIRECTIVE_SCAN_BYTES));
}

/**
 * Public re-export of the same exempt-directive scan, with a non-optional
 * `content` parameter for call-sites that already have a string in hand.
 * Behavioral checks (e.g., assertion-density) honor the same
 * `// interlinked-tdd: exempt` convention as this gate so users don't have
 * to learn two opt-out mechanisms — keep these in sync by going through
 * this helper.
 */
export function hasTddExemptDirective(content: string): boolean {
	return TDD_EXEMPT_DIRECTIVE_RE.test(content.slice(0, EXEMPT_DIRECTIVE_SCAN_BYTES));
}

function toAbsolute(filePath: string, cwd: string | undefined): string {
	if (isAbsolute(filePath)) return filePath;
	return resolve(cwd || process.cwd(), filePath);
}

/** The ordered list of companion test paths we look for. First hit wins. */
function companionTestCandidates(srcAbs: string): string[] {
	const dir = dirname(srcAbs);
	const ext = extname(srcAbs);
	const base = basename(srcAbs, ext);
	return [
		join(dir, `${base}.test${ext}`),
		join(dir, "__tests__", `${base}.test${ext}`),
		join(dir, `${base}.spec${ext}`),
		join(dir, "__tests__", `${base}.spec${ext}`),
	];
}

/** Agents see a friendly relative path, not the resolved absolute one. */
function companionHintPath(srcRaw: string): string {
	const ext = extname(srcRaw);
	const base = basename(srcRaw, ext);
	const dir = dirname(srcRaw);
	return dir && dir !== "."
		? `${dir}/${base}.test${ext}`
		: `${base}.test${ext}`;
}

function shortest(abs: string, cwd: string | undefined): string {
	if (!cwd) return abs;
	const cwdAbs = resolve(cwd);
	if (abs.startsWith(cwdAbs + "/")) return abs.slice(cwdAbs.length + 1);
	return abs;
}

/** `session.files_written` stores whatever path shape the tool sent. Normalize
 *  to absolute so the comparison with our absolute candidates is reliable. */
function normalizedWrittenSet(
	session: SessionTrajectory,
	cwd: string | undefined,
): Set<string> {
	const out = new Set<string>();
	for (const p of session.files_written) {
		out.add(toAbsolute(p, cwd));
	}
	return out;
}
