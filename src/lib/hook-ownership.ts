// ===========================================
// Interlinked hook ownership
// ===========================================
// One predicate, used by every install and clean path, that recognizes a
// hook command as Interlinked's — whether it is the legacy generated `.mjs`
// hook (interlinked-activity.mjs) or the adapter hook (`hook-entry.js` /
// `interlinked-hook`, invoked as `node ... --runner ... --event ...`).
//
// The bug it fixes: the legacy cleanup only matched the `interlinked-activity`
// marker and the adapter cleanup only knew its own command shape, so neither
// install system could recognise — or remove — the other's entries.

import type { JsonObject } from "./json-types.js";

/** Substrings that uniquely identify an Interlinked hook invocation. The
 *  legacy `.mjs` hook references `interlinked-activity`; the adapter hook
 *  invokes `hook-entry.js` (bundled) or the `interlinked-hook` bin. */
const HOOK_COMMAND_MARKERS = ["interlinked-activity", "hook-entry.js", "interlinked-hook"];

/** True when `command` is an Interlinked hook invocation — either entry
 *  point. Used by install to purge prior registrations and by every
 *  uninstall / clean path, so the two install systems can see each other. */
export function isInterlinkedHookCommand(command: string): boolean {
	return HOOK_COMMAND_MARKERS.some((marker) => command.includes(marker));
}

function isRecord(value: unknown): value is JsonObject {
	return value instanceof Object && !Array.isArray(value);
}

/**
 * A stable identity for one hook-array entry: canonical JSON with object keys
 * sorted, so two entries differing only in key order compare equal.
 *
 * Exists to answer the one question the ownership predicates below CANNOT: "is
 * this existing entry identical to the one I am about to write?" Ownership asks
 * *whose* hook an entry is; this asks whether it is *the same* hook.
 *
 * Why that distinction is load-bearing (measured 2026-08-08): a user-scope
 * install whose binary lives outside any project — the normal case for a
 * globally installed `interlinked` — produces a hook command containing no
 * project path. {@link isProjectOwnedHookEntry} therefore cannot attribute it,
 * correctly declines to claim it, and the installer spares it as another repo's
 * hook. The append that follows adds an identical copy, and every later install
 * adds one more, unbounded, until the runner refuses to read its own settings
 * file: 8,092 dead entries across 14 events on one machine, all pointing at a
 * single hook binary that never existed on disk.
 *
 * Removing an exact duplicate of what is about to be written is always safe —
 * the append restores it — and keeping one is never correct, since it only
 * makes the runner execute the same hook twice.
 */
/**
 * Public API — `existing` minus every entry identical to one in `incoming`.
 *
 * Runs BEFORE any ownership verdict, because an exact duplicate of what is
 * about to be written raises no ownership question at all. See
 * {@link hookEntryKey} for the unbounded-growth bug this closes.
 */
export function withoutIncomingDuplicates(existing: unknown[], incoming: unknown[]): unknown[] {
	const keys = new Set(incoming.map(hookEntryKey));
	return existing.filter((entry) => !keys.has(hookEntryKey(entry)));
}

export function hookEntryKey(entry: unknown): string {
	return JSON.stringify(entry, (_key, value: unknown) => {
		if (!isRecord(value)) return value;
		const sorted: JsonObject = {};
		for (const k of Object.keys(value).sort()) sorted[k] = value[k];
		return sorted;
	});
}

function pushIfString(out: string[], value: unknown): void {
	if (typeof value === "string") out.push(value);
}

/** Pull every shell command string out of a runner hook-array entry.
 *  Handles the shapes across supported runners: Claude Code's nested
 *  `{ hooks: [{ command }] }`, and the flatter `{ command }` / `{ bash }`
 *  forms. Unknown shapes yield an empty list. */
export function hookEntryCommands(entry: unknown): string[] {
	if (!isRecord(entry)) return [];
	const out: string[] = [];
	pushIfString(out, entry.command);
	pushIfString(out, entry.bash);
	if (Array.isArray(entry.hooks)) {
		for (const nested of entry.hooks) {
			if (isRecord(nested)) {
				pushIfString(out, nested.command);
				pushIfString(out, nested.bash);
			}
		}
	}
	return out;
}

/** True when a runner hook-array entry is (or contains) an Interlinked
 *  hook — across the legacy and adapter shapes and all supported runners. */
export function isInterlinkedHookEntry(entry: unknown): boolean {
	return hookEntryCommands(entry).some(isInterlinkedHookCommand);
}

/** True when an Interlinked hook entry was registered by the project rooted
 *  at `projectRoot` — i.e. one of its commands references a path inside that
 *  project. The installer bakes an absolute binary path (`<projectRoot>/…`)
 *  into every adapter hook command, so this distinguishes *this* project's
 *  registration from another repo's inside a shared user-scope settings file:
 *  a user-scope cleanup may purge the former but must leave the latter alone.
 *
 *  The legacy `$PWD`-relative hook command embeds no absolute project path,
 *  so it reads as not-owned here — the safe answer, leaving an ambiguous
 *  entry in place rather than removing another repo's hook. The legacy
 *  installer writes only project-scope files, so a relative command never
 *  lands in a shared user-scope file regardless. */
export function isProjectOwnedHookEntry(entry: unknown, projectRoot: string): boolean {
	if (projectRoot.length === 0) return false;
	// Match `<projectRoot>/` (with the separator) so a sibling repo whose path
	// is a string prefix — e.g. `/repo` vs `/repo-fork` — is not misattributed.
	const needle = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
	return hookEntryCommands(entry).some(
		(command) => isInterlinkedHookCommand(command) && command.includes(needle),
	);
}
