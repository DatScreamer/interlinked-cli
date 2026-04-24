// ===========================================
// interlinked scanner — toggle + audit the content scanner
// ===========================================
//
// The privacy filter (OPF content scanner) runs inside the harness and blocks
// PII/secrets from being written to disk, egressed, or ingested by tainting
// Read/Grep results. This command lets the user flip it on/off without
// restarting the harness — the harness hot-reloads `guard-rules.local.json`
// and stops invoking the scanner on the next tool call.
//
// Every toggle is recorded in `.interlinked/content-scanner.audit.jsonl` so
// a reviewer can answer "when was the filter off, and why?". The audit log
// is append-only and survives harness restarts.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../lib/config.js";
import { c, header, kvLine } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

const LOCAL_RULES_FILE = "guard-rules.local.json";
const AUDIT_LOG_FILE = "content-scanner.audit.jsonl";
const STATUS_FILE = "content-scanner.status";

interface ScannerOptions {
	reason?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

type AuditAction = "enable" | "disable" | "toggle" | "no_change";

interface AuditEntry {
	ts: string;
	action: AuditAction;
	from: boolean;
	to: boolean;
	actor: {
		user: string;
		host: string;
		tty: string | null;
		via: "cli";
	};
	reason: string | null;
}

function getLocalRulesPath(cwd: string): string {
	return join(getConfigDir(cwd), LOCAL_RULES_FILE);
}

function getAuditLogPath(cwd: string): string {
	return join(getConfigDir(cwd), AUDIT_LOG_FILE);
}

function getStatusPath(cwd: string): string {
	return join(getConfigDir(cwd), STATUS_FILE);
}

/** Read `.interlinked/guard-rules.local.json`, merge-write a new enabled flag.
 *  Returns the previous value so the caller can decide if this was a no-op. */
function writeEnabledFlag(cwd: string, enabled: boolean): { previous: boolean } {
	const path = getLocalRulesPath(cwd);
	let parsed: JsonObject = {};
	if (existsSync(path)) {
		try {
			const raw = readFileSync(path, "utf-8");
			const obj: unknown = JSON.parse(raw);
			if (obj && typeof obj === "object" && !Array.isArray(obj)) {
				parsed = obj as JsonObject;
			}
		} catch (_err) {
			process.stderr.write(
				`[interlinked:scanner] Warning: ${path} was unparseable; overwriting.\n`,
			);
		}
	}

	const scannerBlock =
		parsed.content_scanner && typeof parsed.content_scanner === "object"
			? (parsed.content_scanner as JsonObject)
			: {};
	const previous = scannerBlock.enabled === true;
	scannerBlock.enabled = enabled;
	parsed.content_scanner = scannerBlock;

	writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
	return { previous };
}

function resolveTty(): string | null {
	if (process.stdout.isTTY) {
		return process.env.SSH_TTY || process.env.TTY || null;
	}
	return null;
}

function appendAudit(cwd: string, entry: AuditEntry): void {
	const path = getAuditLogPath(cwd);
	try {
		appendFileSync(path, `${JSON.stringify(entry)}\n`);
	} catch (err) {
		process.stderr.write(
			`[interlinked:scanner] Warning: failed to write audit log (${err instanceof Error ? err.message : String(err)})\n`,
		);
	}
}

function buildAuditEntry(
	action: AuditAction,
	from: boolean,
	to: boolean,
	reason: string | null,
): AuditEntry {
	const info = userInfo();
	return {
		ts: new Date().toISOString(),
		action,
		from,
		to,
		actor: {
			user: info.username,
			host: hostname(),
			tty: resolveTty(),
			via: "cli",
		},
		reason,
	};
}

function readCurrentEnabled(cwd: string): boolean {
	const path = getLocalRulesPath(cwd);
	if (!existsSync(path)) return false;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as JsonObject;
		const block = raw?.content_scanner as JsonObject | undefined;
		return block?.enabled === true;
	} catch (_) {
		return false;
	}
}

/** Resolve the audit action from a before/after pair. Separate helper because
 *  a nested ternary `a === b ? "no_change" : b ? "enable" : "disable"` reads
 *  worse than three named branches. */
function deriveAction(current: boolean, target: boolean): AuditAction {
	if (current === target) return "no_change";
	return target ? "enable" : "disable";
}

interface ToggleContext {
	cwd: string;
	current: boolean;
	target: boolean;
	opts: ScannerOptions;
	localRulesPath: string;
	auditPath: string;
}

async function applyToggle(
	cwd: string,
	desired: boolean | "toggle",
	opts: ScannerOptions,
): Promise<void> {
	const current = readCurrentEnabled(cwd);
	const target = desired === "toggle" ? !current : desired;
	const action = deriveAction(current, target);
	writeEnabledFlag(cwd, target);
	appendAudit(cwd, buildAuditEntry(action, current, target, opts.reason ?? null));

	const ctx: ToggleContext = {
		cwd,
		current,
		target,
		opts,
		localRulesPath: getLocalRulesPath(cwd),
		auditPath: getAuditLogPath(cwd),
	};
	const mode = getOutputMode(opts);
	const payload = {
		enabled: target,
		changed: current !== target,
		previous: current,
		audit_path: ctx.auditPath,
		reason: opts.reason ?? null,
		note: "Harness hot-reloads guard-rules.local.json — no restart needed for OFF. Toggling ON after a cold start requires 'interlinked harness restart' the first time only.",
	};

	output(mode, payload, {
		json: () => payload,
		short: () =>
			`${target ? "enabled" : "disabled"}${current === target ? " (no change)" : ""}`,
		normal: () => renderToggleResult(ctx),
	});
}

function renderToggleResult(ctx: ToggleContext): string {
	const unchanged = ctx.current === ctx.target;
	const lines: string[] = [];
	if (ctx.target) {
		lines.push(c.green(`PII filter: ENABLED${unchanged ? " (already on)" : ""}`));
	} else {
		lines.push(c.yellow(`PII filter: DISABLED${unchanged ? " (already off)" : ""}`));
	}
	if (!unchanged) {
		lines.push(c.dim(`  wrote: ${ctx.localRulesPath}`));
		lines.push(c.dim(`  audit: ${ctx.auditPath}`));
	}
	if (ctx.opts.reason) lines.push(c.dim(`  reason: ${ctx.opts.reason}`));
	if (!unchanged) {
		lines.push(
			c.dim("  the harness will pick this up on its next config watch event (usually <1s)."),
		);
	}
	return lines.join("\n");
}

function runCommand(action: (opts: ScannerOptions) => Promise<void>, opts: ScannerOptions): Promise<void> {
	return action(opts).catch((err: unknown) => {
		outputError(
			getOutputMode(opts),
			err instanceof Error ? err.message : String(err),
		);
		process.exitCode = 1;
	});
}

export async function scannerOnCommand(opts: ScannerOptions): Promise<void> {
	await runCommand((o) => applyToggle(process.cwd(), true, o), opts);
}

export async function scannerOffCommand(opts: ScannerOptions): Promise<void> {
	await runCommand((o) => applyToggle(process.cwd(), false, o), opts);
}

export async function scannerToggleCommand(opts: ScannerOptions): Promise<void> {
	await runCommand((o) => applyToggle(process.cwd(), "toggle", o), opts);
}

function readStatusFile(cwd: string): string | null {
	const path = getStatusPath(cwd);
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf-8").trim();
	} catch (_) {
		return null;
	}
}

function readLastAudit(cwd: string, n: number): AuditEntry[] {
	const path = getAuditLogPath(cwd);
	if (!existsSync(path)) return [];
	try {
		const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
		const tail = lines.slice(-n);
		const entries: AuditEntry[] = [];
		for (const line of tail) {
			try {
				entries.push(JSON.parse(line) as AuditEntry);
			} catch (_) {
				// skip malformed lines
			}
		}
		return entries;
	} catch (_) {
		return [];
	}
}

interface StatusSnapshot {
	enabled: boolean;
	runtime_status: string | null;
	last_audit: AuditEntry[];
	local_rules_path: string;
	audit_path: string;
}

export async function scannerStatusCommand(opts: ScannerOptions): Promise<void> {
	const cwd = process.cwd();
	const snapshot: StatusSnapshot = {
		enabled: readCurrentEnabled(cwd),
		runtime_status: readStatusFile(cwd),
		last_audit: readLastAudit(cwd, 5),
		local_rules_path: getLocalRulesPath(cwd),
		audit_path: getAuditLogPath(cwd),
	};

	const mode = getOutputMode(opts);
	output(mode, snapshot, {
		json: () => snapshot,
		short: () =>
			`${snapshot.enabled ? "on" : "off"} / ${snapshot.runtime_status ?? "unknown"}`,
		normal: () => renderStatus(snapshot),
	});
}

function renderStatus(s: StatusSnapshot): string {
	const lines: string[] = [];
	lines.push(header("PII Filter"));
	lines.push(kvLine("Enabled", s.enabled ? c.green("yes") : c.yellow("no")));
	lines.push(
		kvLine(
			"Runtime",
			s.runtime_status ? c.dim(s.runtime_status) : c.dim("(harness not writing status)"),
		),
	);
	lines.push(kvLine("Config", c.dim(s.local_rules_path)));
	lines.push(kvLine("Audit", c.dim(s.audit_path)));
	if (s.last_audit.length === 0) return lines.join("\n");
	lines.push("");
	lines.push(header("Recent Toggle History"));
	for (const entry of s.last_audit) {
		const delta =
			entry.action === "no_change"
				? c.dim("no-change")
				: `${entry.from ? "on" : "off"} → ${entry.to ? "on" : "off"}`;
		const reason = entry.reason ? c.dim(` — ${entry.reason}`) : "";
		lines.push(`  ${c.dim(entry.ts)}  ${delta}  by ${entry.actor.user}${reason}`);
	}
	return lines.join("\n");
}
