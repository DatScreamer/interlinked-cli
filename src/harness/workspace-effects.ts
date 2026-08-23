// ===========================================
// Tool-independent workspace effect capture
// ===========================================
//
// Tool names describe intent. The repository bytes describe effects. This
// module snapshots every Git-visible tracked/untracked file plus standalone
// ignored local files (while keeping ignored directory trees collapsed) before
// a tool call, then compares the snapshot after it completes. Including that
// bounded ignored layer matters for paths such as .env that Git intentionally
// hides without recursively hashing scratch/build trees. The resulting
// ChangeSet is the canonical input to PostToolUse file gates, regardless of
// whether the write came from Edit, apply_patch, Bash, a formatter, or an
// unknown MCP tool.
//
// The snapshot is deliberately local and bounded. It is not a hostile-process
// trust boundary: an agent with unrestricted host access can race or tamper
// with any user-space observer. It does close the ordinary "use Bash instead"
// gap and gives Stop a residue backstop when a runner drops a PostToolUse event.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { WATER_LINE_PATHS } from "./evaluator/water-line-files.js";
import {
	EFFECT_ATTRIBUTION_STORE_REL,
	initEffectAttributionStore,
	partitionResidueByAttribution,
	recordReconciledEffects,
} from "./workspace-effect-attribution.js";

const MAX_FILES = 25_000;
const MAX_HASH_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_HASH_BYTES = 64 * 1024 * 1024;
const MAX_GIT_LIST_BYTES = 16 * 1024 * 1024;
const FALLBACK_SKIP_DIRS = new Set([
	".git",
	".interlinked",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".wrangler",
	".stryker-tmp",
	"stryker-tmp",
	".scratch",
	"scratch",
	"tmp",
]);
/** Control paths that are NOT ratchet water-lines. The water-line subset is
 *  derived from WATER_LINE_PATHS below, so this snapshot set is a strict
 *  superset of the guard set and the two cannot drift apart. */
const NON_WATER_LINE_CONTROL_PATHS = [
	".interlinked/check-policy.json",
	".interlinked/check-policy.local.json",
	".interlinked/config.json",
	".interlinked/config.local.json",
	".interlinked/distilled-rules.json",
	".interlinked/distilled-rules.overrides.json",
	".interlinked/guard-rules.json",
	".interlinked/guard-rules.local.json",
	".interlinked/package-allowlist.json",
	".interlinked/security-config.json",
	".interlinked/suite-baseline.json",
	".interlinked/verify-suppressions.json",
];
const EXPLICIT_CONTROL_PATHS = new Set([
	...NON_WATER_LINE_CONTROL_PATHS,
	...WATER_LINE_PATHS,
]);

export type WorkspaceEffectKind = "created" | "modified" | "deleted";

export interface WorkspaceFileFingerprint {
	sha256: string;
	size: number;
	mode: number;
}

export interface WorkspaceSnapshot {
	root: string;
	captured_at: string;
	/** False when any path class was collapsed, capped, unreadable, or metadata-only. */
	complete: boolean;
	files: Readonly<Record<string, WorkspaceFileFingerprint>>;
}

export interface WorkspaceFileEffect {
	path: string;
	kind: WorkspaceEffectKind;
	before_sha256: string | null;
	after_sha256: string | null;
	/** Present on locally observed effects; optional for older/remote payload compatibility. */
	before_mode?: number | null;
	/** Present on locally observed effects; optional for older/remote payload compatibility. */
	after_mode?: number | null;
}

export interface WorkspaceChangeSet {
	source: "filesystem-observation";
	complete: boolean;
	before_captured_at: string;
	after_captured_at: string;
	files: WorkspaceFileEffect[];
	/** Residue only: effects dropped because their observed content hash exactly
	 *  matched a DIFFERENT session's reconciled PostToolUse write — that work
	 *  belongs to the other session and must not be charged to this one. */
	attributed_to_other_sessions?: number;
}

interface PendingSnapshot {
	sessionId: string;
	snapshot: WorkspaceSnapshot;
	seededReconciled: boolean;
}

const pendingByToolId = new Map<string, PendingSnapshot>();
const pendingAnonymous = new Map<string, PendingSnapshot[]>();
const lastReconciledBySession = new Map<string, WorkspaceSnapshot>();
const PENDING_CEILING = 128;
const READ_ONLY_TOOLS = new Set([
	"Read",
	"Glob",
	"Grep",
	"WebFetch",
	"WebSearch",
	"TodoRead",
	"NotebookRead",
	"ListFiles",
]);

/**
 * Unknown tools are observed by default. A new runner/tool must earn a
 * read-only exemption; otherwise renaming a write-capable tool would reopen
 * the exact bypass this layer exists to close.
 */
export function shouldObserveWorkspaceEffects(toolName: string | undefined): boolean {
	return !toolName || !READ_ONLY_TOOLS.has(toolName);
}

function pendingToolKey(sessionId: string, toolUseId: string): string {
	return `${sessionId}\0${toolUseId}`;
}

/** Runtime policy files observed even though the noisy `.interlinked/` tree is collapsed. */
export function isWorkspaceControlPath(path: string): boolean {
	return EXPLICIT_CONTROL_PATHS.has(path.replaceAll("\\", "/"));
}

function sha256(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isInside(root: string, path: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

function fingerprint(path: string, contentBudget: number): WorkspaceFileFingerprint | null {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			const target = readlinkSync(path);
			return { sha256: sha256(`symlink:${target}`), size: stat.size, mode: stat.mode & 0o7777 };
		}
		if (!stat.isFile()) return null;
		// Large files use a bounded metadata fingerprint. Marking the enclosing
		// snapshot incomplete prevents callers from overstating this as proof.
		const digest =
			stat.size <= MAX_HASH_BYTES && stat.size <= contentBudget
				? sha256(readFileSync(path))
				: sha256(`large:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
		return { sha256: digest, size: stat.size, mode: stat.mode & 0o7777 };
	} catch {
		return null;
	}
}

function gitVisiblePaths(root: string): string[] | null {
	try {
		const raw = execFileSync(
			"git",
			["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
			{
				cwd: root,
				encoding: "utf8",
				maxBuffer: MAX_GIT_LIST_BYTES,
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		return [...new Set(raw.split("\0").filter(Boolean))];
	} catch {
		return null;
	}
}

function gitStandaloneIgnoredPaths(root: string): { paths: string[]; complete: boolean } {
	try {
		const raw = execFileSync(
			"git",
			["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
			{
				cwd: root,
				encoding: "utf8",
				maxBuffer: MAX_GIT_LIST_BYTES,
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		// `--directory` deliberately collapses wholly ignored trees to `dir/`.
		// Skip those markers; standalone ignored files (for example `.env` or
		// `.claude/settings.local.json`) retain concrete paths and are observed.
		const entries = raw.split("\0").filter(Boolean);
		const paths = [...new Set(entries.filter((path) => {
			if (!path || path.endsWith("/")) return false;
			const parentSegments = path.split(/[\\/]/).slice(0, -1);
			return !parentSegments.some((segment) => FALLBACK_SKIP_DIRS.has(segment));
		}))];
		return { paths, complete: !entries.some((path) => path.endsWith("/")) };
	} catch {
		return { paths: [], complete: false };
	}
}

function fallbackVisiblePaths(root: string): { paths: string[]; complete: boolean } {
	const paths: string[] = [];
	const queue = [root];
	let complete = true;
	while (queue.length > 0 && paths.length < MAX_FILES) {
		const dir = queue.pop();
		if (!dir) break;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			complete = false;
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory() && FALLBACK_SKIP_DIRS.has(entry.name)) continue;
			const absolute = resolve(dir, entry.name);
			if (!isInside(root, absolute)) continue;
			if (entry.isDirectory()) queue.push(absolute);
			else if (entry.isFile() || entry.isSymbolicLink()) paths.push(relative(root, absolute));
			if (paths.length >= MAX_FILES) {
				complete = false;
				break;
			}
		}
	}
	if (queue.length > 0) complete = false;
	return { paths, complete };
}

function discoverSnapshotPaths(root: string): { paths: string[]; complete: boolean } {
	const gitPaths = gitVisiblePaths(root);
	if (gitPaths === null) {
		const fallback = fallbackVisiblePaths(root);
		return {
			paths: [...new Set([...fallback.paths, ...EXPLICIT_CONTROL_PATHS])],
			complete: fallback.complete,
		};
	}
	const ignored = gitStandaloneIgnoredPaths(root);
	return {
		paths: [...new Set([...gitPaths, ...ignored.paths, ...EXPLICIT_CONTROL_PATHS])],
		complete: ignored.complete,
	};
}

/** Capture the repository state visible to normal source-control workflows. */
export function captureWorkspaceSnapshot(rootInput: string): WorkspaceSnapshot {
	const root = resolve(rootInput);
	const discovered = discoverSnapshotPaths(root);
	const { paths } = discovered;
	let { complete } = discovered;
	if (paths.length > MAX_FILES) complete = false;
	const files: Record<string, WorkspaceFileFingerprint> = {};
	let hashedBytes = 0;
	for (const rel of paths.slice(0, MAX_FILES)) {
		// The attribution registry's own write-through file must never read as
		// a workspace effect, or every reconcile would self-generate residue.
		if (rel.replaceAll("\\", "/") === EFFECT_ATTRIBUTION_STORE_REL) continue;
		const absolute = isAbsolute(rel) ? resolve(rel) : resolve(root, rel);
		if (!isInside(root, absolute) || !existsSync(absolute)) continue;
		const found = fingerprint(absolute, MAX_TOTAL_HASH_BYTES - hashedBytes);
		if (!found) continue;
		files[relative(root, absolute)] = found;
		if (found.size > MAX_HASH_BYTES || hashedBytes + found.size > MAX_TOTAL_HASH_BYTES) {
			complete = false;
		} else {
			hashedBytes += found.size;
		}
	}
	return {
		root,
		captured_at: new Date().toISOString(),
		complete,
		files,
	};
}

/** Compare two snapshots into the canonical, tool-independent ChangeSet. */
export function diffWorkspaceSnapshots(
	before: WorkspaceSnapshot,
	after: WorkspaceSnapshot,
): WorkspaceChangeSet {
	const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
	const files: WorkspaceFileEffect[] = [];
	for (const path of [...paths].sort()) {
		const oldFile = before.files[path];
		const newFile = after.files[path];
		if (!oldFile && newFile) {
			files.push({
				path,
				kind: "created",
				before_sha256: null,
				after_sha256: newFile.sha256,
				before_mode: null,
				after_mode: newFile.mode,
			});
			continue;
		}
		if (oldFile && !newFile) {
			files.push({
				path,
				kind: "deleted",
				before_sha256: oldFile.sha256,
				after_sha256: null,
				before_mode: oldFile.mode,
				after_mode: null,
			});
			continue;
		}
		if (oldFile && newFile && (oldFile.sha256 !== newFile.sha256 || oldFile.mode !== newFile.mode)) {
			files.push({
				path,
				kind: "modified",
				before_sha256: oldFile.sha256,
				after_sha256: newFile.sha256,
				before_mode: oldFile.mode,
				after_mode: newFile.mode,
			});
		}
	}
	return {
		source: "filesystem-observation",
		complete: before.complete && after.complete,
		before_captured_at: before.captured_at,
		after_captured_at: after.captured_at,
		files,
	};
}

function pendingSize(): number {
	let total = pendingByToolId.size;
	for (const queue of pendingAnonymous.values()) total += queue.length;
	return total;
}

function clearPendingOnly(): void {
	pendingByToolId.clear();
	pendingAnonymous.clear();
}

/** Remember the pre-call state. Anonymous runners use a per-session stack. */
export function rememberWorkspaceSnapshot(opts: {
	toolUseId?: string | undefined;
	sessionId: string;
	root: string;
}): void {
	if (pendingSize() >= PENDING_CEILING) clearPendingOnly();
	const pending: PendingSnapshot = {
		sessionId: opts.sessionId,
		snapshot: captureWorkspaceSnapshot(opts.root),
		seededReconciled: !lastReconciledBySession.has(opts.sessionId),
	};
	if (pending.seededReconciled) {
		lastReconciledBySession.set(opts.sessionId, pending.snapshot);
	}
	if (opts.toolUseId) {
		pendingByToolId.set(pendingToolKey(opts.sessionId, opts.toolUseId), pending);
		return;
	}
	const queue = pendingAnonymous.get(opts.sessionId) ?? [];
	queue.push(pending);
	pendingAnonymous.set(opts.sessionId, queue);
}

function takePending(toolUseId: string | undefined, sessionId: string): PendingSnapshot | null {
	if (toolUseId) {
		const key = pendingToolKey(sessionId, toolUseId);
		const hit = pendingByToolId.get(key) ?? null;
		pendingByToolId.delete(key);
		return hit;
	}
	const queue = pendingAnonymous.get(sessionId);
	const hit = queue?.pop() ?? null;
	if (queue?.length === 0) pendingAnonymous.delete(sessionId);
	return hit;
}

/** Drop a pre-call snapshot when the final PreToolUse decision blocks execution. */
export function discardWorkspaceSnapshot(opts: {
	toolUseId?: string | undefined;
	sessionId: string;
}): void {
	const discarded = takePending(opts.toolUseId, opts.sessionId);
	if (
		discarded?.seededReconciled &&
		lastReconciledBySession.get(opts.sessionId) === discarded.snapshot
	) {
		lastReconciledBySession.delete(opts.sessionId);
	}
}

/** Consume the matching pre-call snapshot and observe what actually changed. */
export function consumeWorkspaceSnapshot(opts: {
	toolUseId?: string | undefined;
	sessionId: string;
	root: string;
}): WorkspaceChangeSet | null {
	const pending = takePending(opts.toolUseId, opts.sessionId);
	if (!pending) return null;
	const after = captureWorkspaceSnapshot(opts.root);
	lastReconciledBySession.set(opts.sessionId, after);
	const changeSet = diffWorkspaceSnapshots(pending.snapshot, after);
	// Feed the cross-session attribution registry so Stop residue can tell
	// "this session's unreconciled write" from "another session's work".
	initEffectAttributionStore(opts.root);
	recordReconciledEffects(opts.sessionId, changeSet.files);
	return changeSet;
}

/**
 * Stop-time backstop: return file effects that occurred after the last
 * reconciled PostToolUse, or since an unconsumed PreToolUse snapshot. This is
 * advisory evidence; it cannot retroactively make an irreversible call safe.
 */
export function consumeWorkspaceResidue(sessionId: string, root: string): WorkspaceChangeSet | null {
	const candidates: WorkspaceSnapshot[] = [];
	const reconciled = lastReconciledBySession.get(sessionId);
	if (reconciled) candidates.push(reconciled);
	for (const pending of pendingByToolId.values()) {
		if (pending.sessionId === sessionId) candidates.push(pending.snapshot);
	}
	for (const pending of pendingAnonymous.get(sessionId) ?? []) candidates.push(pending.snapshot);
	clearWorkspaceEffectSession(sessionId);
	if (candidates.length === 0) return null;
	const oldest = candidates.reduce((a, b) =>
		a.captured_at <= b.captured_at ? a : b,
	);
	const raw = diffWorkspaceSnapshots(oldest, captureWorkspaceSnapshot(root));
	// The diff is time-scoped; drop effects proven to be another session's
	// reconciled work so they are not folded into THIS session's rescan.
	const { own, attributedElsewhere } = partitionResidueByAttribution(sessionId, raw.files);
	return { ...raw, files: own, attributed_to_other_sessions: attributedElsewhere };
}

/** Render a bounded Stop warning for writes whose PostToolUse was missed. */
export function formatWorkspaceResidueWarning(changeSet: WorkspaceChangeSet): string | null {
	if (changeSet.files.length === 0) return null;
	const shown = changeSet.files.slice(0, 8).map((effect) => `${effect.kind}:${effect.path}`);
	const more = changeSet.files.length > shown.length
		? ` (+${changeSet.files.length - shown.length} more)`
		: "";
	const completeness = changeSet.complete ? "complete" : "bounded/incomplete";
	const attributed = changeSet.attributed_to_other_sessions ?? 0;
	const attributedNote = attributed > 0
		? ` ${attributed} further effect(s) matched another session's reconciled writes and were excluded.`
		: "";
	return (
		`[interlinked:effect-residue] Stop observed ${changeSet.files.length} filesystem effect(s) ` +
		`that were not reconciled by PostToolUse (${completeness} snapshot): ${shown.join(", ")}${more}.` +
		`${attributedNote} ` +
		"The files were added to the touched-file rescan; this is a backstop, not rollback of the originating command."
	);
}

/** Release all in-memory evidence for a completed session. */
export function clearWorkspaceEffectSession(sessionId: string): void {
	lastReconciledBySession.delete(sessionId);
	pendingAnonymous.delete(sessionId);
	for (const [key, pending] of pendingByToolId) {
		if (pending.sessionId === sessionId) pendingByToolId.delete(key);
	}
}
