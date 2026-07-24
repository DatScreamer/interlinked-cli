// Baseline-integrity gate (test-integrity guard, §9.1b of
// docs/design/test-category-adoption-from-the-wild.md).
//
// PreToolUse BLOCK: an agent Write/Edit/MultiEdit that *loosens* a committed
// ratchet water-line under `.interlinked/` is the canonical gate-gaming move —
// lower the bar instead of meeting it, and every ratchet (coverage / mutation /
// per-edit-coverage / large-file cap / untested-file floor / metric caps) falls
// at once. Water-lines may only move in the tightening direction. The harness's
// OWN raises go through internal fs writes (coverage-ratchet.ts, mutation-gate.ts,
// …), never the Write/Edit tool, so they never reach this gate — only a hand-edit
// does. Pure disk-vs-proposed numeric diff; no execution, no LLM, near-zero FP.
//
// The "before" water-line is the current ON-DISK baseline (not git HEAD): most
// baselines are gitignored local state, and the PreToolUse hook fires before the
// write lands, so disk still holds the pre-edit value. Reuses the disk-read /
// Edit-reconstruction helpers from config-loosening-gate.ts.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import {
	readDiskContent,
	reconstructEditContent,
	safeJsonParse,
} from "./config-loosening-gate.js";

export interface BaselineGamingFinding {
	file: string;
	rule: string;
	before: unknown;
	after: unknown;
	message: string;
}

type BaselineKind =
	| "coverage"
	| "coverage-edit"
	| "mutation"
	| "large-files"
	| "untested-files"
	| "metric-caps"
	| "mutation-manifest"
	| "skipped-tests";

const BASELINE_RE =
	/(?:^|\/)\.interlinked\/(coverage-baseline|coverage-edit-baseline|mutation-baseline|mutation-manifest|large-files-baseline|untested-files-baseline|metric-caps|skipped-tests-baseline)\.json$/;

const KIND_MAP: Record<string, BaselineKind> = {
	"coverage-baseline": "coverage",
	"coverage-edit-baseline": "coverage-edit",
	"mutation-baseline": "mutation",
	"large-files-baseline": "large-files",
	"untested-files-baseline": "untested-files",
	"metric-caps": "metric-caps",
	"mutation-manifest": "mutation-manifest",
	"skipped-tests-baseline": "skipped-tests",
};

function baselineKind(filePath: string): BaselineKind | null {
	const m = BASELINE_RE.exec(filePath.replace(/\\/g, "/"));
	const key = m?.[1];
	if (!key) return null;
	return KIND_MAP[key] ?? null;
}

function isNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function asObj(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Default predicate: does the repo-relative `rel` source still exist on disk?
 *  Repo root is the path component preceding `/.interlinked/` in the baseline path. */
function makeDefaultSourceExists(baselineFile: string): (rel: string) => boolean {
	const norm = baselineFile.replace(/\\/g, "/");
	const root = norm.slice(0, norm.lastIndexOf("/.interlinked/"));
	return (rel: string) => existsSync(resolve(root, rel));
}

function fmt(
	file: string,
	rule: string,
	before: unknown,
	after: unknown,
	message: string,
): BaselineGamingFinding {
	return { file, rule, before, after, message };
}

// ---- per-file detectors (pure) ------------------------------------------

// Shared shape: a `files` map of {path: {<metric>: number}} whose metrics may
// only rise, and whose entries may only be removed when the source is gone.
function detectRisingMetricMap(
	file: string,
	beforeFiles: Record<string, unknown>,
	afterFiles: Record<string, unknown>,
	metrics: string[],
	label: string,
	exists: (rel: string) => boolean,
): BaselineGamingFinding[] {
	const out: BaselineGamingFinding[] = [];
	for (const [path, bRaw] of Object.entries(beforeFiles)) {
		const b = asObj(bRaw);
		const aRaw = afterFiles[path];
		if (aRaw === undefined) {
			if (exists(path)) {
				out.push(
					fmt(
						file,
						`${label}:${path}`,
						bRaw,
						undefined,
						`${label}-baseline entry for ${path} removed while the source file still exists. Restore it — the harness raises baselines via internal writes, not hand-edits.`,
					),
				);
			}
			continue;
		}
		const a = asObj(aRaw);
		for (const metric of metrics) {
			const bv = b[metric];
			const av = a[metric];
			if (isNum(bv) && isNum(av) && av < bv) {
				out.push(
					fmt(
						file,
						`${label}:${path}:${metric}`,
						bv,
						av,
						`${label}-baseline ${metric} for ${path} lowered ${bv}→${av}. This water-line may only rise; meet the bar or set INTERLINKED_DISABLE_BASELINE_GUARD=1 for an intentional reset.`,
					),
				);
			}
		}
	}
	return out;
}

/** A coverage-edit baseline value in either shape: a legacy bare fraction, or
 *  a scoped `{f, scope}` object (mirrors coverage-obligation-ledger). */
function decodeCovValue(value: unknown): { f: number; scope: string | null } | null {
	if (isNum(value)) return { f: value, scope: null };
	const obj = asObj(value);
	const f = obj.f;
	if (isNum(f)) return { f, scope: typeof obj.scope === "string" ? obj.scope : null };
	return null;
}

function detectCoverageEdit(
	file: string,
	before: unknown,
	after: unknown,
	exists: (rel: string) => boolean,
): BaselineGamingFinding[] {
	const out: BaselineGamingFinding[] = [];
	const b = asObj(before);
	const a = asObj(after);
	for (const [path, bRaw] of Object.entries(b)) {
		const bv = decodeCovValue(bRaw);
		if (bv === null) continue;
		const aRaw = a[path];
		if (aRaw === undefined) {
			if (exists(path)) {
				out.push(
					fmt(file, `coverage-edit:${path}`, bv.f, undefined, `coverage-edit-baseline entry for ${path} removed while the source still exists.`),
				);
			}
			continue;
		}
		const av = decodeCovValue(aRaw);
		// A DIFFERENT measuring scope is a legitimate re-anchor (the reseed the
		// runtime performs when affected-test selection changes), not gaming — only
		// a SAME-SCOPE fraction drop is a lowered water-line. Legacy null==null
		// (both scope-less) still enforces exactly as before.
		if (av !== null && av.scope === bv.scope && av.f < bv.f) {
			out.push(
				fmt(file, `coverage-edit:${path}`, bv.f, av.f, `coverage-edit-baseline for ${path} lowered ${bv.f}→${av.f} within the same test scope. Per-edit coverage may only rise (a scope change re-anchors automatically).`),
			);
		}
	}
	return out;
}

function detectLargeFiles(file: string, before: unknown, after: unknown): BaselineGamingFinding[] {
	const out: BaselineGamingFinding[] = [];
	const b = asObj(before);
	const a = asObj(after);
	const bMax = b.max_lines;
	const aMax = a.max_lines;
	if (isNum(bMax) && isNum(aMax) && aMax > bMax) {
		out.push(fmt(file, "max_lines", bMax, aMax, `large-files max_lines raised ${bMax}→${aMax}. The line cap may only tighten.`));
	}
	const effMax = isNum(aMax) ? aMax : Number.POSITIVE_INFINITY;
	const bFiles = asObj(b.files);
	const aFiles = asObj(a.files);
	for (const [path, bcRaw] of Object.entries(bFiles)) {
		const ac = aFiles[path];
		if (isNum(bcRaw) && isNum(ac) && ac > bcRaw) {
			out.push(fmt(file, `grandfather:${path}`, bcRaw, ac, `grandfather high-water for ${path} raised ${bcRaw}→${ac}. A grandfathered file may shrink or hold, never grow.`));
		}
	}
	for (const [path, acRaw] of Object.entries(aFiles)) {
		if (!(path in bFiles) && isNum(acRaw) && acRaw > effMax) {
			out.push(fmt(file, `grandfather-new:${path}`, undefined, acRaw, `new grandfather entry ${path}=${acRaw} exceeds the cap (${effMax}). That pre-authorizes an over-cap file — decompose it instead.`));
		}
	}
	return out;
}

// The skipped-tests water-line (docs/design/test-oracle-integrity.md §4.2):
// the test suite is the oracle every other ratchet depends on, and skips are
// how an agent quietly erodes it. Same directions as large-files: the global
// cap may only tighten, a grandfather ceiling may only shrink, and a NEW
// grandfather entry above the cap pre-authorizes new skips — blocked.
function detectSkippedTests(file: string, before: unknown, after: unknown): BaselineGamingFinding[] {
	const out: BaselineGamingFinding[] = [];
	const b = asObj(before);
	const a = asObj(after);
	const bMax = b.max_skipped;
	const aMax = a.max_skipped;
	if (isNum(bMax) && isNum(aMax) && aMax > bMax) {
		out.push(
			fmt(
				file,
				"max_skipped",
				bMax,
				aMax,
				`skipped-tests max_skipped raised ${bMax}→${aMax}. The skip cap may only tighten — fix or delete the skipped test instead.`,
			),
		);
	}
	const effMax = isNum(aMax) ? aMax : Number.POSITIVE_INFINITY;
	const bFiles = asObj(b.files);
	const aFiles = asObj(a.files);
	for (const [path, bcRaw] of Object.entries(bFiles)) {
		const ac = aFiles[path];
		if (isNum(bcRaw) && isNum(ac) && ac > bcRaw) {
			out.push(
				fmt(
					file,
					`grandfather:${path}`,
					bcRaw,
					ac,
					`skipped-tests grandfather for ${path} raised ${bcRaw}→${ac}. A grandfathered file may re-enable tests, never skip more.`,
				),
			);
		}
	}
	for (const [path, acRaw] of Object.entries(aFiles)) {
		if (!(path in bFiles) && isNum(acRaw) && acRaw > effMax) {
			out.push(
				fmt(
					file,
					`grandfather-new:${path}`,
					undefined,
					acRaw,
					`new skipped-tests grandfather entry ${path}=${acRaw} exceeds the cap (${effMax}). That pre-authorizes new skips — re-enable the tests instead.`,
				),
			);
		}
	}
	return out;
}

function detectUntestedFiles(file: string, before: unknown, after: unknown): BaselineGamingFinding[] {
	const out: BaselineGamingFinding[] = [];
	const b = asObj(before);
	const a = asObj(after);
	const bMin = b.min_coverage_pct;
	const aMin = a.min_coverage_pct;
	if (isNum(bMin) && isNum(aMin) && aMin < bMin) {
		out.push(fmt(file, "min_coverage_pct", bMin, aMin, `untested-files min_coverage_pct lowered ${bMin}→${aMin}. The coverage floor may only rise.`));
	}
	const bSet = new Set(Array.isArray(b.files) ? b.files : []);
	const aFiles = Array.isArray(a.files) ? a.files : [];
	for (const p of aFiles) {
		if (typeof p === "string" && !bSet.has(p)) {
			out.push(fmt(file, `exempt-added:${p}`, undefined, p, `${p} added to the untested-files exemption list — that exempts a new file from the coverage floor. Cover it instead.`));
		}
	}
	return out;
}

function detectMetricCaps(file: string, before: unknown, after: unknown): BaselineGamingFinding[] {
	const out: BaselineGamingFinding[] = [];
	const b = asObj(before);
	const a = asObj(after);
	for (const k of ["max_lines", "max_cyclomatic", "max_cognitive", "crap_threshold"]) {
		const bv = b[k];
		const av = a[k];
		if (isNum(bv) && isNum(av) && av > bv) {
			out.push(fmt(file, k, bv, av, `metric-caps ${k} raised ${bv}→${av}. Caps may only tighten.`));
		}
	}
	const bMin = b.min_coverage;
	const aMin = a.min_coverage;
	if (isNum(bMin) && isNum(aMin) && aMin < bMin) {
		out.push(fmt(file, "min_coverage", bMin, aMin, `metric-caps min_coverage lowered ${bMin}→${aMin}. The coverage floor may only rise.`));
	}
	return out;
}

// The mutation-manifest's accepted-survivor set (mutants with status survived /
// equivalent) may only SHRINK across a hand-edit (spec §7 of
// docs/design/per-edit-cloud-mutation-testing.md). A mutation run / the reviewed
// `interlinked mutation` CLI records survivors via internal fs writes (bypassing
// this gate); a hand-edit that ADDS one is the gate-gaming move.
function acceptedSurvivorSet(manifest: unknown): Set<string> {
	const out = new Set<string>();
	for (const symbolsRaw of Object.values(asObj(asObj(manifest).files))) {
		for (const symRaw of Object.values(asObj(symbolsRaw))) {
			for (const [mutantId, mRaw] of Object.entries(asObj(asObj(symRaw).mutants))) {
				const status = asObj(mRaw).status;
				if (status === "survived" || status === "equivalent") out.add(mutantId);
			}
		}
	}
	return out;
}

export function detectMutationManifest(file: string, before: unknown, after: unknown): BaselineGamingFinding[] {
	const out: BaselineGamingFinding[] = [];
	const beforeAccepted = acceptedSurvivorSet(before);
	for (const mutantId of acceptedSurvivorSet(after)) {
		if (!beforeAccepted.has(mutantId)) {
			out.push(
				fmt(
					file,
					`accepted-survivor-added:${mutantId}`,
					undefined,
					mutantId,
					`mutant ${mutantId} was hand-added to the accepted-survivor set. New survivors/equivalents may only enter via a mutation run or the reviewed \`interlinked mutation\` CLI (internal writes); a hand-edit silences the gate. The accepted set may only shrink.`,
				),
			);
		}
	}
	return out;
}

/**
 * Public API — pure detector. Returns the loosening findings for a proposed
 * edit to a `.interlinked/` ratchet baseline (empty for non-baseline files,
 * new baselines, unparseable JSON, or safe-direction moves).
 */
export function detectBaselineGaming(
	filePath: string,
	beforeText: string,
	afterText: string,
	sourceExists?: (rel: string) => boolean,
): BaselineGamingFinding[] {
	const kind = baselineKind(filePath);
	if (!kind) return [];
	if (!beforeText) return [];
	const before = safeJsonParse(beforeText);
	const after = safeJsonParse(afterText);
	if (before === null || after === null) return [];
	const exists = sourceExists ?? makeDefaultSourceExists(filePath);
	switch (kind) {
		case "coverage":
			return detectRisingMetricMap(filePath, asObj(asObj(before).files), asObj(asObj(after).files), ["lines_pct", "branches_pct"], "coverage", exists);
		case "mutation":
			return detectRisingMetricMap(filePath, asObj(asObj(before).files), asObj(asObj(after).files), ["score", "killed"], "mutation", exists);
		case "coverage-edit":
			return detectCoverageEdit(filePath, before, after, exists);
		case "large-files":
			return detectLargeFiles(filePath, before, after);
		case "untested-files":
			return detectUntestedFiles(filePath, before, after);
		case "metric-caps":
			return detectMetricCaps(filePath, before, after);
		case "mutation-manifest":
			return detectMutationManifest(filePath, before, after);
		case "skipped-tests":
			return detectSkippedTests(filePath, before, after);
	}
}

interface BaselineGateDeps {
	getDisk?: (file: string, cwd: string | undefined) => string | null;
}

/**
 * Public API — PreToolUse entry point (wired in pre-tool-guards.ts). Blocks a
 * Write/Edit/MultiEdit that loosens a committed baseline. Fails open (returns
 * null) on anything it can't conclude: non-baseline file, disable-bypass,
 * unreconstructable edit, or a not-yet-existing baseline. Disk is the source of
 * truth (most baselines are gitignored local state); the hook fires before the
 * write lands, so disk still holds the pre-edit water-line. `deps` is injectable.
 */
export function evaluateBaselineIntegrityForEvent(
	event: HarnessEvent,
	deps: BaselineGateDeps = {},
): HarnessDecision | null {
	if (process.env.INTERLINKED_DISABLE_BASELINE_GUARD === "1") return null;
	const toolInput = event.tool_input || {};
	const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
	if (!filePath || !baselineKind(filePath)) return null;

	const getDisk = deps.getDisk ?? readDiskContent;
	const before = getDisk(filePath, event.cwd);
	if (before === null) return null; // baseline doesn't exist yet — creating it isn't loosening

	let proposed: string | null = null;
	const content = toolInput.content as string | undefined;
	if (typeof content === "string") {
		proposed = content;
	} else if (Array.isArray(toolInput.edits)) {
		let cur: string | null = before;
		for (const e of toolInput.edits as Array<{ old_string?: string; new_string?: string }>) {
			if (cur === null) break;
			if (typeof e.old_string === "string" && typeof e.new_string === "string") {
				cur = reconstructEditContent(cur, e.old_string, e.new_string);
			}
		}
		proposed = cur;
	} else {
		const oldString = toolInput.old_string as string | undefined;
		const newString = toolInput.new_string as string | undefined;
		if (typeof oldString === "string" && typeof newString === "string") {
			proposed = reconstructEditContent(before, oldString, newString);
		}
	}
	if (proposed === null) return null;

	const findings = detectBaselineGaming(filePath, before, proposed);
	if (findings.length === 0) return null;

	const messages = findings.map((f) => `[${f.rule}] ${f.message}`).join("\n  ");
	return {
		decision: "block",
		reason:
			`BLOCKED: this edit loosens a ratchet baseline in ${filePath}:\n  ${messages}\n\n` +
			"Ratchet water-lines may only move in the tightening direction. The harness raises them itself via internal writes; an agent hand-lowering one defeats every ratchet at once. If this is an intentional reset, set INTERLINKED_DISABLE_BASELINE_GUARD=1.",
		rule_id: "baseline_integrity_gate",
		severity: "high",
		category: "config",
	};
}
