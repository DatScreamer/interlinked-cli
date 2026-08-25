// ===========================================
// Bash-edit obligations — the Ring-2 equalizer (gap 6, 2026-08-25 audit)
// ===========================================
// For Write/Edit the pre_block registry judges content BEFORE disk. For the
// bash channel the bytes do not exist until the command runs, so Ring 2 could
// only warn — a structural asymmetry an agent could route through. This module
// converts that warning into a real gate with enforcement delayed by exactly
// one step: when a bash-edited file's post-state INTRODUCES a pre_block-class
// finding (vs its git-index baseline — the last content that passed a gated
// channel), an obligation opens. While any obligation is open, write-class
// tool calls to OTHER files are refused; edits to the obligated file (the fix
// path) and read-class tools stay allowed. The gate self-discharges: every
// evaluation re-runs the same registry checks on current disk content, so
// fixing the finding — through any channel — closes the obligation.
//
// Portability: nothing here is repo-specific. The registry checks are the
// same multi-language set the Write/Edit gates run; the baseline comes from
// git (index, then HEAD, then strict for untracked files).
//
// Persistence: write-through JSON under `.interlinked/`, lazily reloaded — a
// daemon restart must not amnesty an open obligation (the effect-attribution
// lesson, 2026-08-23). `dry_run` never persists (CLAUDE.md rule).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runPreBlockRegistryGate } from "./pre-block-gate.js";
import type { HarnessDecision, HarnessEvent } from "./types.js";

const STORE_REL = join(".interlinked", "bash-edit-obligations.json");
const GIT_SHOW_MAX_BUFFER = 8 * 1024 * 1024;

export interface BashEditObligation {
	file: string;
	checkIds: string[];
	opened_at: string;
	session_id: string;
}

/** Tool names whose calls are refused while an obligation is open. Reads and
 *  Bash stay allowed: reads are how the agent inspects the problem, and bash
 *  misuse re-opens obligations through the same recorder anyway. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const cache = new Map<string, Map<string, BashEditObligation>>();
const loadedRoots = new Set<string>();

function storePath(cwd: string): string {
	return join(cwd, STORE_REL);
}

function decodeObligationRow(rel: string, value: unknown): BashEditObligation | null {
	if (typeof value !== "object" || value === null) return null;
	const ob = value as Partial<BashEditObligation>;
	if (!Array.isArray(ob.checkIds) || ob.checkIds.length === 0) return null;
	return {
		file: rel,
		checkIds: ob.checkIds.filter((c): c is string => typeof c === "string"),
		opened_at: typeof ob.opened_at === "string" ? ob.opened_at : "",
		session_id: typeof ob.session_id === "string" ? ob.session_id : "",
	};
}

function readStoreRows(file: string): Record<string, unknown> {
	try {
		if (!existsSync(file)) return {};
		const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch (err) {
		void err; // corrupt store — in-memory-only until the next persist
	}
	return {};
}

function loadOnce(cwd: string): Map<string, BashEditObligation> {
	let map = cache.get(cwd);
	if (map && loadedRoots.has(cwd)) return map;
	map = map ?? new Map();
	cache.set(cwd, map);
	loadedRoots.add(cwd);
	for (const [rel, value] of Object.entries(readStoreRows(storePath(cwd)))) {
		if (map.has(rel)) continue; // live rows outrank disk
		const decoded = decodeObligationRow(rel, value);
		if (decoded) map.set(rel, decoded);
	}
	return map;
}

function persist(cwd: string, map: Map<string, BashEditObligation>): void {
	try {
		const file = storePath(cwd);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(Object.fromEntries(map))}\n`, "utf-8");
	} catch (err) {
		void err; // best-effort persistence; the in-memory gate still holds
	}
}

/** The last content that passed a GATED channel: the git index version, then
 *  HEAD, then null (untracked ⇒ strict — everything counts as introduced). */
function gitBaseline(cwd: string, rel: string): string | null {
	for (const ref of [`:0:${rel}`, `HEAD:${rel}`]) {
		try {
			return execFileSync("git", ["show", ref], {
				cwd,
				encoding: "utf-8",
				maxBuffer: GIT_SHOW_MAX_BUFFER,
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch (err) {
			void err; // not staged / not tracked — try the next ref
		}
	}
	return null;
}

/** pre_block check ids the file's CURRENT content introduces vs its baseline. */
function introducedCheckIds(cwd: string, rel: string, abs: string): string[] {
	let content: string;
	try {
		content = readFileSync(abs, "utf-8");
	} catch {
		return []; // deleted/unreadable — nothing to hold an obligation against
	}
	const outcomes = runPreBlockRegistryGate({
		content,
		filePath: abs,
		baselineContent: gitBaseline(cwd, rel),
		projectRoot: cwd,
	});
	return outcomes.filter((o) => o.introduced.length > 0).map((o) => o.checkId);
}

/** All open obligations for a repo root (test/inspection surface). */
export function openBashEditObligations(cwd: string): BashEditObligation[] {
	return [...loadOnce(resolve(cwd)).values()];
}

/** Test seam: drop all in-memory state (the JSON store survives). */
export function resetBashEditObligationsForTesting(): void {
	cache.clear();
	loadedRoots.clear();
}

/**
 * Ring-2 recorder: judge a bash-edited file's post-state and open (or
 * discharge) its obligation. Returns the warning to attach to the PostToolUse
 * decision, or null. `dryRun` evaluates but never persists.
 */
export function recordBashEditObligations(opts: {
	cwd: string;
	sessionId: string;
	filePath: string;
	dryRun: boolean;
}): string | null {
	const cwd = resolve(opts.cwd);
	const abs = isAbsolute(opts.filePath) ? opts.filePath : resolve(cwd, opts.filePath);
	const rel = relative(cwd, abs).replace(/\\/g, "/");
	if (rel.startsWith("..")) return null;
	const ids = introducedCheckIds(cwd, rel, abs);
	const map = loadOnce(cwd);
	if (ids.length === 0) {
		if (map.delete(rel) && !opts.dryRun) persist(cwd, map);
		return null;
	}
	const warning =
		`[interlinked:bash-edit-obligation] ${rel} was changed through the bash channel and its ` +
		`post-state INTRODUCES pre_block-class finding(s): ${ids.join(", ")}. The same rules the ` +
		`Write/Edit gates enforce now hold delayed: until ${rel} is fixed, write-class tool calls ` +
		`to other files are refused (edits to ${rel} itself and reads stay allowed).`;
	if (opts.dryRun) return warning;
	map.set(rel, {
		file: rel,
		checkIds: ids,
		opened_at: new Date().toISOString(),
		session_id: opts.sessionId,
	});
	persist(cwd, map);
	return warning;
}

/** Post-tool convenience: record every bash-edited path and attach the
 *  obligation warnings to the decision. No-op for direct edits (those were
 *  judged pre-write by the content gates). */
export function appendBashEditObligationWarnings(
	event: HarnessEvent,
	fallbackCwd: string,
	isDirectFileEdit: boolean,
	editedFilePaths: string[],
	postDecision: { warnings?: string[] | undefined },
): void {
	if (isDirectFileEdit) return;
	for (const filePath of editedFilePaths) {
		const warning = recordBashEditObligations({
			cwd: event.cwd || fallbackCwd,
			sessionId: event.session_id,
			filePath,
			dryRun: event.dry_run === true,
		});
		if (warning) (postDecision.warnings ??= []).push(warning);
	}
}

function targetRel(event: HarnessEvent, cwd: string): string | null {
	const raw = event.tool_input?.file_path ?? event.tool_input?.path;
	if (typeof raw !== "string" || raw.length === 0) return null;
	const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
	return relative(cwd, abs).replace(/\\/g, "/");
}

/** Re-verify every open obligation against current disk; drop the fixed ones. */
function dischargeFixedObligations(
	cwd: string,
	map: Map<string, BashEditObligation>,
	dryRun: boolean | undefined,
): void {
	let changed = false;
	for (const [rel] of [...map]) {
		if (introducedCheckIds(cwd, rel, resolve(cwd, rel)).length === 0) {
			map.delete(rel);
			changed = true;
		}
	}
	if (changed && !dryRun) persist(cwd, map);
}

/**
 * PreToolUse gate: refuse write-class tool calls to files OTHER than an open
 * obligation's target. Self-discharging — every evaluation re-verifies each
 * obligation against current disk content first, so a fixed finding releases
 * the gate without any explicit close step.
 */
export function evaluateBashEditObligationGate(
	event: HarnessEvent,
	toolName: string,
	warnings: string[],
): HarnessDecision | null {
	const cwd = event.cwd ? resolve(event.cwd) : null;
	if (!cwd) return null;
	const map = loadOnce(cwd);
	if (map.size === 0) return null;
	dischargeFixedObligations(cwd, map, event.dry_run);
	if (map.size === 0 || !WRITE_TOOLS.has(toolName)) return null;
	const target = targetRel(event, cwd);
	if (target !== null && map.has(target)) return null;
	const summary = [...map.values()]
		.map((o) => `${o.file} (${o.checkIds.join(", ")})`)
		.join("; ");
	return {
		decision: "block",
		reason:
			`BLOCKED: a bash-channel edit left pre_block-class finding(s) on disk and its obligation ` +
			`is still open: ${summary}. The bash channel cannot be judged before execution, so the ` +
			`same rule holds one step later — fix the listed file(s) first (edits to them and reads ` +
			`are allowed), then this call proceeds. The gate re-checks on every call and releases ` +
			`itself the moment the finding is gone.`,
		warnings,
		rule_id: "bash-edit-obligation",
		severity: "high",
		category: "harness-integrity",
	};
}
