// ===========================================
// interlinked scanner — toggle + audit + review the content scanner
// ===========================================
//
// The privacy filter (OPF content scanner) runs inside the harness and blocks
// PII/secrets from being written to disk, egressed, or ingested by tainting
// Read/Grep results. This command lets the user flip it on/off without
// restarting the harness — the harness hot-reloads `guard-rules.local.json`
// and stops invoking the scanner on the next tool call.
//
// `scanner review` is the second half of the WebFetch 3-way review loop:
// when the harness's WebFetch proxy detects PII in a fetched body, it
// stashes a `*.review.json` file under `.interlinked/scanner/pending/`.
// `scanner review` shows the user that file and writes the chosen
// `<key>.decision.json`, which the harness consumes on the next call to
// the same URL.
//
// Every toggle and review choice is recorded in
// `.interlinked/content-scanner.audit.jsonl` so a reviewer can answer
// "when was the filter off, and why?" — and the same for "who allowed
// what?". The audit log is append-only and survives harness restarts.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
	listPendingReviews,
	type PendingReviewSummary,
	readReview,
	type ReviewDecision,
	type ReviewPayload,
	writeDecision,
} from "../harness/content-scanner/review-files.js";
import { getConfigDir } from "../lib/config.js";
import { c, header, kvLine } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

const LOCAL_RULES_FILE = "guard-rules.local.json";
const AUDIT_LOG_FILE = "content-scanner.audit.jsonl";
const STATUS_FILE = "content-scanner.status";
/** typeof tag for an object — pulled out of the conditional so the
 *  linter's magic-literal rule passes. */
const TYPEOF_OBJECT = "object" as const;
/** Sentinel value for the toggle action — also a magic literal in the
 *  conditional that picks between flip and explicit set. */
const TOGGLE_ACTION = "toggle" as const;
const NO_CHANGE_ACTION = "no_change" as const;

interface ScannerOptions {
	reason?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

export interface ScannerReviewOptions extends ScannerOptions {
	allow?: boolean;
	redact?: boolean;
	block?: boolean;
	key?: string;
}

type AuditAction =
	| "enable"
	| "disable"
	| "toggle"
	| "no_change"
	| "review_allow"
	| "review_redact"
	| "review_block"
	| "review_skip";

interface AuditEntry {
	ts: string;
	action: AuditAction;
	/** State transition for toggle actions (`from`/`to`). Omitted for
	 *  review actions, which have no on/off semantic. */
	from?: boolean;
	to?: boolean;
	actor: {
		user: string;
		host: string;
		tty: string | null;
		via: "cli";
	};
	reason: string | null;
}

interface BuildAuditEntryArgs {
	action: AuditAction;
	from?: boolean;
	to?: boolean;
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

function isPlainObject(v: unknown): v is JsonObject {
	return typeof v === TYPEOF_OBJECT && v !== null && !Array.isArray(v);
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
			if (isPlainObject(obj)) {
				parsed = obj;
			}
		} catch (_err) {
			process.stderr.write(
				`[interlinked:scanner] Warning: ${path} was unparseable; overwriting.\n`,
			);
		}
	}

	const scannerBlock = isPlainObject(parsed.content_scanner) ? parsed.content_scanner : {};
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

function buildAuditEntry(args: BuildAuditEntryArgs): AuditEntry {
	const info = userInfo();
	return {
		ts: new Date().toISOString(),
		action: args.action,
		from: args.from,
		to: args.to,
		actor: {
			user: info.username,
			host: hostname(),
			tty: resolveTty(),
			via: "cli",
		},
		reason: args.reason,
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
	if (current === target) return NO_CHANGE_ACTION;
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
	desired: boolean | typeof TOGGLE_ACTION,
	opts: ScannerOptions,
): Promise<void> {
	const current = readCurrentEnabled(cwd);
	const target = desired === TOGGLE_ACTION ? !current : desired;
	const action = deriveAction(current, target);
	writeEnabledFlag(cwd, target);
	appendAudit(
		cwd,
		buildAuditEntry({ action, from: current, to: target, reason: opts.reason ?? null }),
	);

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

function runCommand<O extends ScannerOptions>(
	action: (opts: O) => Promise<void>,
	opts: O,
): Promise<void> {
	return action(opts).catch((err: unknown) => {
		outputError(getOutputMode(opts), err instanceof Error ? err.message : String(err));
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
	await runCommand((o) => applyToggle(process.cwd(), TOGGLE_ACTION, o), opts);
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

/** Prefix on every review-action audit entry. Reviews don't have an
 *  on/off transition, so the renderer branches on this rather than
 *  pretending `from`/`to` are meaningful. */
const REVIEW_ACTION_PREFIX = "review_";

/** Map a single audit entry to a one-cell summary suitable for the
 *  "Recent Activity" line. Toggle entries show `off → on`; review
 *  entries show `review: <decision>`; no-op toggles show `no-change`. */
function formatAuditDelta(entry: AuditEntry): string {
	if (entry.action.startsWith(REVIEW_ACTION_PREFIX)) {
		const verb = entry.action.slice(REVIEW_ACTION_PREFIX.length);
		return c.cyan(`review: ${verb}`);
	}
	if (entry.action === NO_CHANGE_ACTION) return c.dim("no-change");
	return `${entry.from ? "on" : "off"} → ${entry.to ? "on" : "off"}`;
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
	// Header changed from "Recent Toggle History" → "Recent Activity"
	// because the audit log now also carries review_allow/redact/block/skip
	// entries. Mixing them under a "Toggle" header was actively misleading.
	lines.push(header("Recent Activity"));
	for (const entry of s.last_audit) {
		const reason = entry.reason ? c.dim(` — ${entry.reason}`) : "";
		lines.push(
			`  ${c.dim(entry.ts)}  ${formatAuditDelta(entry)}  by ${entry.actor.user}${reason}`,
		);
	}
	return lines.join("\n");
}

// ===========================================
// scanner review — second half of the WebFetch 3-way review loop
// ===========================================

interface ReviewResultPayload {
	pending: number;
	cache_key: string | null;
	decision: ReviewDecision | "skip" | null;
	url: string | null;
	finding_count: number;
	action: AuditAction | "none";
}

/** Sentinel for the "leave the review unresolved" choice. Not a real
 *  decision — it just records an audit entry without writing a
 *  `*.decision.json` file. */
const SKIP_DECISION = "skip" as const;

type ReviewChoice = ReviewDecision | typeof SKIP_DECISION;

const REVIEW_DECISION_TO_ACTION: Record<ReviewChoice, AuditAction> = {
	allow: "review_allow",
	redact: "review_redact",
	block: "review_block",
	skip: "review_skip",
};

const REVIEW_PROMPT = "[a]llow / [r]edact / [b]lock / [s]kip";

interface PickError {
	error: string;
}

function isPickError(v: unknown): v is PickError {
	return typeof v === TYPEOF_OBJECT && v !== null && "error" in (v as object);
}

/** Pick a review by --key, otherwise return the first (newest) pending. */
function pickReview(
	reviews: PendingReviewSummary[],
	key: string | undefined,
): PendingReviewSummary | PickError | null {
	if (reviews.length === 0) return null;
	if (key) {
		const match = reviews.find((r) => r.key === key);
		if (!match) return { error: `no pending review with key "${key}"` };
		return match;
	}
	return reviews[0] ?? null;
}

/** Reject conflicting decision flags up front. Cleaner than implicit
 *  precedence (allow wins over block, etc.) — surprising precedence is
 *  the kind of thing you find out about by leaking PII. */
function pickFlagDecision(
	opts: ScannerReviewOptions,
): ReviewDecision | undefined | PickError {
	const flags = [opts.allow && "allow", opts.redact && "redact", opts.block && "block"].filter(
		Boolean,
	) as ReviewDecision[];
	if (flags.length === 0) return undefined;
	if (flags.length > 1) {
		return { error: `conflicting flags: ${flags.join(", ")} — pick one` };
	}
	return flags[0];
}

async function promptForDecision(): Promise<ReviewDecision | "skip"> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const raw = (await rl.question(`${REVIEW_PROMPT}: `)).trim().toLowerCase();
		if (raw.startsWith("a")) return "allow";
		if (raw.startsWith("r")) return "redact";
		if (raw.startsWith("b")) return "block";
		return "skip";
	} finally {
		rl.close();
	}
}

function renderReview(review: ReviewPayload): string {
	const lines: string[] = [];
	lines.push(header("Privacy Filter — Review"));
	lines.push(kvLine("URL", review.url));
	if (review.prompt) lines.push(kvLine("Prompt", review.prompt));
	lines.push(kvLine("Findings", String(review.findings.length)));
	lines.push(kvLine("Categories", c.yellow(formatCategories(review))));
	lines.push("");
	lines.push(header("Body (PII highlighted)"));
	lines.push(highlightFindings(review));
	lines.push("");
	lines.push(c.dim("This body is rendered locally and was NOT sent to the model."));
	return lines.join("\n");
}

function formatCategories(review: ReviewPayload): string {
	const counts = new Map<string, number>();
	for (const f of review.findings) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
	return [...counts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([label, n]) => `${label}(${n})`)
		.join(", ");
}

/** Splice the original body so each finding's text is wrapped in red ANSI
 *  + the `<LABEL>` suffix. Splices from the end so earlier indices stay
 *  valid during iteration. */
function highlightFindings(review: ReviewPayload): string {
	const sorted = [...review.findings].sort((a, b) => b.start - a.start);
	let result = review.body;
	for (const span of sorted) {
		const original = result.slice(span.start, span.end);
		const tag = c.dim(` <${span.label.toUpperCase()}>`);
		result = result.slice(0, span.start) + c.red(original) + tag + result.slice(span.end);
	}
	return result;
}

export async function scannerReviewCommand(opts: ScannerReviewOptions): Promise<void> {
	await runCommand(async (o: ScannerReviewOptions) => {
		const cwd = process.cwd();
		const mode = getOutputMode(o);
		const reviews = listPendingReviews(cwd);

		if (reviews.length === 0) {
			const payload: ReviewResultPayload = {
				pending: 0,
				cache_key: null,
				decision: null,
				url: null,
				finding_count: 0,
				action: "none",
			};
			output(mode, payload, {
				json: () => payload,
				short: () => "no pending reviews",
				normal: () => c.dim("No pending reviews."),
			});
			return;
		}

		const flagPick = pickFlagDecision(o);
		if (isPickError(flagPick)) {
			outputError(mode, flagPick.error);
			process.exitCode = 1;
			return;
		}

		const picked = pickReview(reviews, o.key);
		if (picked === null) {
			outputError(mode, "no pending reviews matched");
			process.exitCode = 1;
			return;
		}
		if (isPickError(picked)) {
			outputError(mode, picked.error);
			process.exitCode = 1;
			return;
		}

		const review = readReview(cwd, picked.key);
		if (!review) {
			outputError(mode, `pending review for key ${picked.key} could not be read`);
			process.exitCode = 1;
			return;
		}

		let decision: ReviewDecision | "skip";
		if (flagPick) {
			decision = flagPick;
		} else if (mode === "json" || !process.stdin.isTTY) {
			// Machine-readable / non-interactive callers must supply an explicit
			// decision flag. Falling through to renderReview()+promptForDecision()
			// here would (a) print the ANSI review UI to stdout and contaminate
			// the JSON document, and (b) block forever on stdin.
			outputError(
				mode,
				"non-interactive scanner review requires an explicit --allow, --redact, or --block flag",
				{
					pending_key: picked.key,
					url: review.url,
					finding_count: review.findings.length,
				},
			);
			return;
		} else {
			console.log(renderReview(review));
			decision = await promptForDecision();
		}

		const action = REVIEW_DECISION_TO_ACTION[decision];

		// Skip leaves the review file in place. We still record the audit
		// entry so "I looked at this and deferred" is queryable later.
		if (decision === SKIP_DECISION) {
			appendAudit(cwd, buildAuditEntry({ action, reason: o.reason ?? null }));
			const payload: ReviewResultPayload = {
				pending: reviews.length,
				cache_key: picked.key,
				decision: SKIP_DECISION,
				url: review.url,
				finding_count: review.findings.length,
				action,
			};
			output(mode, payload, {
				json: () => payload,
				short: () => SKIP_DECISION,
				normal: () => c.dim("Skipped — review left in place."),
			});
			return;
		}

		const info = userInfo();
		writeDecision({
			cwd,
			key: picked.key,
			decision,
			actor: { user: info.username, host: hostname(), tty: resolveTty() },
		});
		appendAudit(cwd, buildAuditEntry({ action, reason: o.reason ?? null }));

		const payload: ReviewResultPayload = {
			pending: reviews.length,
			cache_key: picked.key,
			decision,
			url: review.url,
			finding_count: review.findings.length,
			action,
		};
		output(mode, payload, {
			json: () => payload,
			short: () => decision,
			normal: () =>
				c.green(
					`Recorded: ${decision} for ${review.url} (${review.findings.length} finding(s))`,
				) + `\n${c.dim("Re-invoke the WebFetch in your agent session to apply.")}`,
		});
	}, opts);
}
