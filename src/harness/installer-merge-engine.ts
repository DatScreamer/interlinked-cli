// interlinked-tdd: exempt
// -----------------------------------------------------------------------------
// Merge engine + JSON-pointer path helpers + low-level fs helpers
// -----------------------------------------------------------------------------
// Leaf utilities extracted verbatim from installer.ts to keep that file under
// the per-file line cap. No module-private state from installer.ts is read here.

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { JsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";

// Merge strategy literal compared in `mergeArrayField`.
const STRATEGY_REPLACE_KEY = "replace-key" as const;

// -----------------------------------------------------------------------------
// Merge engine — records every path it wrote so uninstall is exact
// -----------------------------------------------------------------------------

export function mergeSettings(
	target: JsonObject,
	fragment: unknown,
	strategy: "deep-merge" | "array-append" | "replace-key",
	parentPath: string,
	addedPaths: string[],
): JsonObject {
	if (fragment == null || typeof fragment !== "object" || Array.isArray(fragment)) return target;
	const frag = fragment as JsonObject;
	for (const key of Object.keys(frag)) {
		const childPath = joinPath(parentPath, key);
		const nextValue = frag[key];
		if (Array.isArray(nextValue)) {
			mergeArrayField(target, key, nextValue, strategy, childPath, addedPaths);
			continue;
		}
		if (nextValue != null && typeof nextValue === "object") {
			const existing = readObjectField(target, key);
			target[key] = mergeSettings(existing, nextValue, strategy, childPath, addedPaths);
			continue;
		}
		// Scalar: only write if absent (so we don't clobber user values).
		if (!(key in target)) {
			target[key] = nextValue;
			addedPaths.push(childPath);
		}
	}
	return target;
}

function mergeArrayField(
	target: JsonObject,
	key: string,
	next: unknown[],
	strategy: "deep-merge" | "array-append" | "replace-key",
	childPath: string,
	addedPaths: string[],
): void {
	const rawExisting = target[key];
	const existing: unknown[] = Array.isArray(rawExisting) ? rawExisting : [];
	if (strategy === STRATEGY_REPLACE_KEY) {
		target[key] = next;
		addedPaths.push(childPath);
		return;
	}
	// array-append / deep-merge: append items, recording indices we own. Prior
	// Interlinked entries are removed beforehand by `purgePriorEntries`, so the
	// append cannot stack duplicates — the recorded indices stay exact.
	const startIndex = existing.length;
	const merged = [...existing, ...next];
	target[key] = merged;
	for (let i = 0; i < next.length; i++) {
		addedPaths.push(`${childPath}[${startIndex + i}]`);
	}
}

function readObjectField(target: JsonObject, key: string): JsonObject {
	const existing = target[key];
	if (existing != null && typeof existing === "object" && !Array.isArray(existing)) {
		return existing as JsonObject;
	}
	const fresh: JsonObject = {};
	target[key] = fresh;
	return fresh;
}

// -----------------------------------------------------------------------------
// JSON-pointer-style path helpers for precise uninstall
// -----------------------------------------------------------------------------

function joinPath(parent: string, key: string): string {
	return parent ? `${parent}.${key}` : key;
}

export function removeJsonPath(target: unknown, path: string): boolean {
	if (target == null || typeof target !== "object") return false;
	const segments = parsePath(path);
	let cursor: unknown = target;
	for (let i = 0; i < segments.length - 1; i++) {
		cursor = step(cursor, nonNull(segments[i]));
		if (cursor == null) return false;
	}
	const last = segments[segments.length - 1];
	if (last === undefined) return false;
	if (cursor == null) return false;
	if (last.kind === "index") {
		if (!Array.isArray(cursor)) return false;
		if (last.value < 0 || last.value >= cursor.length) return false;
		cursor.splice(last.value, 1);
		return true;
	}
	if (typeof cursor !== "object" || Array.isArray(cursor)) return false;
	const obj = cursor as JsonObject;
	if (!Object.hasOwn(obj, last.value)) return false;
	delete obj[last.value];
	return true;
}

type PathSegment = { kind: "key"; value: string } | { kind: "index"; value: number };

/** Segments that reach the prototype chain instead of own data. A path
 *  carrying one is hostile or corrupt, never a hook location (review
 *  2026-08-30: `__proto__.toString` traversed to inherited properties). */
export const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function parsePath(path: string): PathSegment[] {
	const out: PathSegment[] = [];
	const parts = path.split(".");
	for (const part of parts) {
		const indexMatches = part.match(/\[(\d+)\]/g);
		const keyPart = part.replace(/\[\d+\]/g, "");
		if (FORBIDDEN_PATH_SEGMENTS.has(keyPart)) return [];
		if (keyPart.length > 0) out.push({ kind: "key", value: keyPart });
		if (indexMatches) {
			for (const idx of indexMatches) {
				const n = Number.parseInt(idx.slice(1, -1), 10);
				if (Number.isFinite(n)) out.push({ kind: "index", value: n });
			}
		}
	}
	return out;
}

function step(cursor: unknown, seg: PathSegment): unknown {
	if (cursor == null) return undefined;
	if (seg.kind === "index") {
		if (!Array.isArray(cursor)) return undefined;
		return cursor[seg.value];
	}
	if (typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
	// Own properties only — inherited members are never hook data.
	if (!Object.hasOwn(cursor, seg.value)) return undefined;
	return (cursor as JsonObject)[seg.value];
}

// -----------------------------------------------------------------------------
// Low-level fs helpers
// -----------------------------------------------------------------------------

export function readJson(path: string): JsonObject | null {
	if (!existsSync(path)) return {};
	let text = "";
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return {};
	}
	let parsed: unknown = {};
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (parsed == null || typeof parsed !== "object") return {};
	return parsed as JsonObject;
}

export function writeAtomic(path: string, payload: unknown): void {
	ensureDir(dirname(path));
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
	// Preserve the destination's file mode across the replacement.
	if (existsSync(path)) {
		try {
			chmodSync(tmp, statSync(path).mode);
		} catch (_err) {
			void _err; // best-effort: mode preservation must not fail the write
		}
	}
	// rename() REPLACES atomically on POSIX. NEVER unlink first (review
	// 2026-08-30): the old delete-then-rename left a crash window with NO
	// destination at all — the opposite of atomic replacement.
	renameSync(tmp, path);
}

/** Atomic text sibling of {@link writeAtomic}, used for managed provider
 * plugins/extensions whose native install artifact is source code, not JSON. */
export function writeTextAtomic(path: string, content: string): void {
	ensureDir(dirname(path));
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content);
	if (existsSync(path)) {
		try {
			chmodSync(tmp, statSync(path).mode);
		} catch (modeError) {
			void modeError;
		}
	}
	renameSync(tmp, path);
}

export function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Resolve an adapter-relative settings path against the install root.
 *  Lives in this leaf module (moved from installer.ts 2026-08-30) so the
 *  manifest validator can bind stored paths to adapter derivations without
 *  an import cycle. env-first: os.homedir() reads the process environ via
 *  libuv, which per-thread process.env.HOME writes never reach — under
 *  Stryker's worker-threads pool a test HOME redirect resolved to the REAL
 *  home. */
export function resolveSettingsPath(cwd: string, relPath: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
	if (relPath.startsWith("~/")) return join(home, relPath.slice(2));
	if (relPath.startsWith("/")) return relPath;
	return join(cwd, relPath);
}
