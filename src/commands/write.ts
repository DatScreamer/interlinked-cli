// ===========================================
// interlinked write — Gate-aware file writes from Bash / automation
// ===========================================
// This command lets an agent write to tracked source files from Bash while
// STILL running the full content-quality pipeline (pre_block registry,
// biome diff-overlay, tsc diff-overlay) that normally gates the Edit/Write
// tools. Without this escape hatch, coordinated multi-site edits (adding an
// import AND using it in two files) trip the diff-overlay on the first
// Edit call, because the intermediate state has an unused-import or
// missing-name error. See `docs/design/bash-writes-through-content-gates.md`.
//
// Modes:
//   - `interlinked write <path> --stdin`                   — single file, content via stdin
//   - `interlinked write <path> --from-file <src>`          — single file, content from another file
//   - `interlinked write --batch <manifest.json>`          — multi-file atomic batch
//
// Transactional semantics: the gate sees ALL files before any are written.
// If any file fails, NO file is written. Successful batches commit via
// temp-file + rename so partial-write states are never observable.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	formatGateResult,
	GATE_SEVERITY_ERROR,
	type GateFailure,
	type GateInputEntry,
	type GateResult,
	gateProposedContent,
} from "../harness/content-gate.js";
import { c } from "../lib/formatter.js";

/** Options accepted by `interlinked write`. */
export interface WriteCommandOptions {
	stdin?: boolean;
	fromFile?: string;
	batch?: string;
	json?: boolean;
	/** Allow writes outside the project root. Same intent as the design doc's `--unsafe-outside-repo`. */
	unsafeOutsideRepo?: boolean;
}

/** Manifest shape accepted by `--batch <manifest.json>`. */
interface BatchManifest {
	version: 1;
	writes: Array<{ path: string; content: string }>;
}

/** Exit-code sentinel for unrecoverable input errors (no batch processed). */
const EXIT_USAGE = 2;
/** Exit-code sentinel for a gate failure. */
const EXIT_GATE_FAIL = 1;

/**
 * Read stdin until EOF. Returns the full string content.
 */
async function readStdin(): Promise<string> {
	return new Promise<string>((res, rej) => {
		const chunks: Buffer[] = [];
		process.stdin.on("data", (ch: Buffer) => chunks.push(ch));
		process.stdin.on("end", () => res(Buffer.concat(chunks).toString("utf-8")));
		process.stdin.on("error", rej);
	});
}

/**
 * Load the single-file entry (from stdin or --from-file) into a
 * `GateInputEntry`. Throws an Error with a usage-level message the caller
 * should surface to the user.
 */
async function resolveSingleFileEntry(
	targetPath: string,
	opts: WriteCommandOptions,
): Promise<GateInputEntry> {
	if (opts.stdin) {
		const content = await readStdin();
		return { path: targetPath, content };
	}
	if (opts.fromFile) {
		if (!existsSync(opts.fromFile)) {
			throw new Error(`Source file not found: ${opts.fromFile}`);
		}
		const content = readFileSync(opts.fromFile, "utf-8");
		return { path: targetPath, content };
	}
	throw new Error("Provide --stdin or --from-file <src> (or use --batch for multi-file writes).");
}

/**
 * Load a batch manifest from disk. Validates shape defensively — malformed
 * manifests are the most common failure mode for this command.
 */
function loadBatchManifest(manifestPath: string): GateInputEntry[] {
	if (!existsSync(manifestPath)) {
		throw new Error(`Batch manifest not found: ${manifestPath}`);
	}
	let raw: string;
	try {
		raw = readFileSync(manifestPath, "utf-8");
	} catch (err) {
		throw new Error(
			`Could not read batch manifest: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`Batch manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Batch manifest must be a JSON object { version: 1, writes: [...] }.");
	}
	const manifest = parsed as Partial<BatchManifest>;
	if (manifest.version !== 1) {
		throw new Error(
			`Batch manifest version must be 1 (got: ${JSON.stringify(manifest.version)}).`,
		);
	}
	if (!Array.isArray(manifest.writes) || manifest.writes.length === 0) {
		throw new Error("Batch manifest must include a non-empty 'writes' array.");
	}
	const entries: GateInputEntry[] = [];
	for (const [i, w] of manifest.writes.entries()) {
		if (!w || typeof w !== "object") {
			throw new Error(`Batch writes[${i}] must be an object { path, content }.`);
		}
		const { path, content } = w as { path?: unknown; content?: unknown };
		if (typeof path !== "string" || path.length === 0) {
			throw new Error(`Batch writes[${i}].path must be a non-empty string.`);
		}
		if (typeof content !== "string") {
			throw new Error(`Batch writes[${i}].content must be a string.`);
		}
		entries.push({ path, content });
	}
	return entries;
}

/**
 * Validate that a target path is safe to write to. Unless the caller explicitly
 * opted into `--unsafe-outside-repo`, reject paths outside the current project
 * root and obvious system directories. Same trust boundary as Edit/Write.
 */
function validateTargetPath(targetPath: string, unsafeOutsideRepo: boolean): void {
	const absolute = resolve(targetPath);
	if (unsafeOutsideRepo) return;
	const root = process.cwd();
	if (!absolute.startsWith(`${root}/`) && absolute !== root) {
		throw new Error(
			`Refusing to write outside project root (${root}): ${absolute}. Pass --unsafe-outside-repo to override.`,
		);
	}
	// Hard-block a handful of system-critical prefixes even if inside cwd
	// (unlikely, but e.g. cwd=/ would allow them otherwise).
	if (
		absolute.startsWith("/etc/") ||
		absolute.startsWith("/usr/") ||
		absolute.startsWith("/bin/") ||
		absolute.startsWith("/sbin/")
	) {
		throw new Error(`Refusing to write to system path: ${absolute}.`);
	}
}

/**
 * Atomically write each entry: write to a sibling temp file, then rename into
 * place. Renames on the same filesystem are POSIX-atomic. If a write or
 * rename fails partway through, we attempt to remove any temp files we
 * created so the disk state stays clean.
 */
function atomicWriteAll(entries: GateInputEntry[]): void {
	const tmpPaths: string[] = [];
	try {
		// Phase 1: write all temps.
		for (const { path, content } of entries) {
			const tmp = `${path}.interlinked-write-${randomUUID().slice(0, 8)}.tmp`;
			writeFileSync(tmp, content, { encoding: "utf-8" });
			tmpPaths.push(tmp);
		}
		// Phase 2: rename all temps into place.
		for (let i = 0; i < entries.length; i++) {
			renameSync(tmpPaths[i], entries[i].path);
		}
	} catch (err) {
		// Best-effort cleanup of any temps left behind.
		for (const tmp of tmpPaths) {
			try {
				if (existsSync(tmp)) unlinkSync(tmp);
			} catch {
				/* intentional: cleanup is best-effort */
			}
		}
		throw err;
	}
}

/**
 * Build the machine-readable JSON payload matching the design doc's shape
 * exactly:
 *   { ok, failures: [{ path, tool, code, line, message }] }
 */
function toJsonPayload(result: GateResult): {
	ok: boolean;
	elapsedMs: number;
	failures: Array<{
		path: string;
		tool: string;
		code: string;
		line: number;
		column?: number;
		message: string;
		severity: GateFailure["severity"];
	}>;
} {
	return {
		ok: result.ok,
		elapsedMs: result.elapsedMs,
		failures: result.failures.map((f) => ({
			path: f.path,
			tool: f.tool,
			code: f.code,
			line: f.line,
			column: f.column,
			message: f.message,
			severity: f.severity,
		})),
	};
}

/**
 * Entry point wired into `src/index.ts`. Thin: parses options, dispatches to
 * single-file or batch mode, runs the gate, writes atomically on success.
 */
export async function writeCommand(
	targetPath: string | undefined,
	opts: WriteCommandOptions,
): Promise<void> {
	const useJson = opts.json === true;

	// Resolve entries from the supplied mode.
	let entries: GateInputEntry[];
	try {
		if (opts.batch) {
			if (targetPath) {
				throw new Error("Do not pass a path positional argument when --batch is used.");
			}
			entries = loadBatchManifest(opts.batch);
		} else {
			if (!targetPath) {
				throw new Error(
					"Provide a <path> argument (with --stdin or --from-file) or use --batch.",
				);
			}
			const entry = await resolveSingleFileEntry(targetPath, opts);
			entries = [entry];
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (useJson) {
			console.log(JSON.stringify({ ok: false, error: message }, null, 2));
		} else {
			console.error(c.red(`interlinked write: ${message}`));
		}
		process.exit(EXIT_USAGE);
	}

	// Validate each target path before the gate runs — paths outside the
	// project root or system directories get rejected early, no gate work.
	try {
		for (const { path } of entries) {
			validateTargetPath(path, opts.unsafeOutsideRepo === true);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (useJson) {
			console.log(JSON.stringify({ ok: false, error: message }, null, 2));
		} else {
			console.error(c.red(`interlinked write: ${message}`));
		}
		process.exit(EXIT_USAGE);
	}

	// Gate — the whole point.
	const result = gateProposedContent(entries);

	// Any blocking failure → abort the whole batch.
	const blocking = result.failures.filter((f) => f.severity === GATE_SEVERITY_ERROR);
	if (blocking.length > 0) {
		if (useJson) {
			console.log(JSON.stringify(toJsonPayload(result), null, 2));
		} else {
			console.error(c.red(formatGateResult(result)));
			console.error("");
			console.error(c.yellow("No files changed. Fix the findings or restructure your edit."));
		}
		process.exit(EXIT_GATE_FAIL);
	}

	// Gate passed — write atomically.
	try {
		atomicWriteAll(entries);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (useJson) {
			console.log(JSON.stringify({ ok: false, error: message }, null, 2));
		} else {
			console.error(c.red(`interlinked write: atomic write failed — ${message}`));
		}
		process.exit(EXIT_GATE_FAIL);
	}

	if (useJson) {
		console.log(
			JSON.stringify(
				{
					...toJsonPayload(result),
					wrote: entries.map((e) => e.path),
				},
				null,
				2,
			),
		);
		return;
	}
	const count = entries.length;
	console.log(
		c.green(
			`interlinked write: ${count} file${count === 1 ? "" : "s"} written (${result.elapsedMs}ms gate)`,
		),
	);
	for (const { path } of entries) {
		console.log(`  ${path}`);
	}
	if (result.failures.length > 0) {
		// Non-blocking warnings were surfaced by the gate.
		console.log("");
		console.log(c.dim("Gate warnings (non-blocking):"));
		for (const f of result.failures) {
			console.log(c.dim(`  ${f.path}: ${f.tool} ${f.code} L${f.line} — ${f.message}`));
		}
	}
}
