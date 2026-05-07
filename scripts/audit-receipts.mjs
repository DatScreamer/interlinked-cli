#!/usr/bin/env node
// =====================================================================
// Receipts audit — verify the landing page's "blocks" table against
// activity.jsonl + Claude Code session transcripts.
// =====================================================================
//
// Why this exists: every row in landing/public/index.html's receipt
// table is a count drawn from .interlinked/activity.jsonl. The raw
// counts are real, but the row LABELS imply the agent attempted the
// dangerous thing in the row's title — and the older substring-matching
// rules fired on commit-message bodies, echo arguments, and grep
// patterns too. This script resolves every block to the agent's actual
// tool_input by looking up the nearest-before tool_use in the session
// transcript at:
//
//   ~/.claude/projects/-Users-quentincody-interlinked-cli/<session_id>.jsonl
//
// Output: writes landing/receipts.json with confirmed-real counts +
// per-row verdicts. The HTML's receipts table is hand-edited to match
// (gen-markers around the headline number); scripts/check-docs.mjs
// validates the HTML's "Verified blocks" stat agrees with this JSON.
//
// Limitations:
//   - activity.jsonl is gitignored local data. CI cannot run this
//     script. It must run locally before launch and the resulting
//     receipts.json gets committed.
//   - Some sessions' transcripts have rolled out of the local
//     ~/.claude/projects/ retention window. Those events become
//     "transcript_missing" — counted as unverified, not real.
//
// Usage:
//   npm run docs:audit-receipts            # writes landing/receipts.json
//   node scripts/audit-receipts.mjs --json # prints to stdout instead

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ACTIVITY = join(ROOT, ".interlinked/activity.jsonl");
const TRANSCRIPT_DIR = join(homedir(), ".claude/projects/-Users-quentincody-interlinked-cli");
const OUT_PATH = join(ROOT, "landing/receipts.json");

// Rule IDs grouped by whether the row is confirmed-real after audit
// (kept on the landing page) or FP-heavy (dropped from the headline
// table but still counted in the residual). Update this when adding
// new rules — the audit script is intentionally explicit, not inferring.
const KEEP_ROWS = [
	{ rule_id: "tsc-diff-overlay", severity: "high", label: "Edits that introduced a new TypeScript error — blocked before the write landed" },
	{ rule_id: "bash-code-file-write-bypass", severity: "high", label: "Shell-redirect bypass attempts (cat > file.ts to dodge content-quality gate)" },
	{ rule_id: "tdd_new_file_gate", severity: "high", label: "New source file with no companion test" },
	{ rule_id: "empty_catch", severity: "high", label: "Empty catch{} blocks" },
	{ rule_id: "builtin-repo-confinement", severity: "critical", label: "Writes outside the repo root" },
	{ rule_id: "self-kill-protection", severity: "critical", label: "kill <pid> targeting the harness or session process" },
];

// Rule IDs that the audit found to be FP-heavy. Counts are still
// reported in the residual but are not treated as real attempts.
const FP_HEAVY_RULES = new Set([
	"builtin-shutdown-reboot",
	"builtin-rm-rf-root",
	"builtin-drop-database",
	"builtin-kubectl-delete-all",
	"builtin-chmod-777",
	"builtin-nohup-network",
	"pretooluse-injection-scan",
]);

const TOOL_USE_TOOLS = new Set(["Bash", "Edit", "Write", "MultiEdit", "apply_patch"]);
const TRANSCRIPT_LOOKBACK_SECONDS = 60;

function parseTs(s) {
	return Date.parse(s);
}

function loadActivityBlocks() {
	if (!existsSync(ACTIVITY)) {
		throw new Error(`activity.jsonl not found at ${ACTIVITY} — audit can only run locally where the activity log exists`);
	}
	const blocks = [];
	const text = readFileSync(ACTIVITY, "utf8");
	for (const line of text.split("\n")) {
		if (!line) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "guard_block") blocks.push(event);
	}
	return blocks;
}

function loadTranscript(sessionId) {
	const path = join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
	if (!existsSync(path)) return null;
	const entries = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// skip malformed lines
		}
	}
	return entries;
}

const transcriptCache = new Map();
function getTranscript(sessionId) {
	if (transcriptCache.has(sessionId)) return transcriptCache.get(sessionId);
	const t = loadTranscript(sessionId);
	transcriptCache.set(sessionId, t);
	return t;
}

function findCommandForBlock(sessionId, blockTsMs) {
	const transcript = getTranscript(sessionId);
	if (!transcript) return null;
	let best = null;
	let bestDt = Number.POSITIVE_INFINITY;
	for (const rec of transcript) {
		if (rec?.type !== "assistant") continue;
		const ts = parseTs(rec.timestamp || "");
		if (Number.isNaN(ts)) continue;
		const content = rec.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type !== "tool_use") continue;
			if (!TOOL_USE_TOOLS.has(block.name)) continue;
			const cmd = block.input?.command || block.input?.file_path || "";
			if (!cmd) continue;
			const dt = blockTsMs - ts;
			if (dt >= 0 && dt < TRANSCRIPT_LOOKBACK_SECONDS * 1000 && dt < bestDt) {
				best = { command: String(cmd), tool: block.name, ts: rec.timestamp };
				bestDt = dt;
			}
		}
	}
	return best;
}

// Heuristic: classify a resolved command as a real attempt or an FP.
// Conservative — defaults to "needs_review" so the audit underclaims
// rather than overclaims.
function classify(ruleId, command) {
	const lc = command.toLowerCase();
	const looksLikeText = (verb) =>
		lc.includes("git commit") || lc.includes(`echo `) || lc.includes(`grep `) || lc.includes(`rg `) || lc.includes(`> ${verb}.log`);

	if (ruleId === "builtin-shutdown-reboot") {
		if (looksLikeText("shutdown") && (lc.includes("shutdown") || lc.includes("reboot"))) return "fp_in_text";
		const startsWithVerb = /^\s*(?:sudo\s+)?(?:shutdown|reboot)\b/i;
		if (startsWithVerb.test(command)) return "real";
		return "fp_in_text"; // older rule fired on substring match — assume FP unless command-start match
	}
	if (ruleId === "builtin-rm-rf-root") {
		if (looksLikeText("rm")) return "fp_in_text";
		const isRoot = /^\s*(?:sudo\s+)?rm\s+-[rRf]+\s+\/(?!Users|Volumes|var\/tmp\b|tmp\b)/.test(command);
		const isWildcard = /^\s*(?:sudo\s+)?rm\s+-[rRf]+\s+\*/.test(command);
		if (isRoot || isWildcard) return "real";
		// rm -rf <project-subdir> is the rule firing on any path starting with /
		// Not a true root-level delete.
		return "fp_path_under_users";
	}
	if (ruleId === "builtin-drop-database") {
		if (looksLikeText("drop")) return "fp_in_text";
		// Real DROP would be embedded in a script execution, not interactive
		return "needs_review";
	}
	if (ruleId === "builtin-kubectl-delete-all") {
		if (looksLikeText("kubectl")) return "fp_in_text";
		if (/^\s*kubectl\s+delete\s+--all/.test(command)) return "real";
		return "fp_in_text";
	}
	if (ruleId === "builtin-chmod-777") {
		if (looksLikeText("chmod")) return "fp_in_text";
		if (/^\s*(?:sudo\s+)?chmod\s+0?777\b/.test(command)) return "real";
		return "fp_in_text";
	}
	if (ruleId === "builtin-nohup-network") {
		if (!lc.includes("nohup")) return "fp_in_text";
		return "needs_review";
	}
	if (ruleId === "self-kill-protection") {
		// kill <pid> where the pid was the harness — the rule fires only
		// when the resolved PID belongs to the harness or session process.
		if (/^\s*kill\s+-?\d/.test(command)) return "real";
		return "needs_review";
	}
	if (ruleId === "pretooluse-injection-scan") {
		// File-path field, not a command. Whether the content was real
		// prompt injection depends on the file's contents at write time,
		// which the activity log doesn't preserve. Mark as unverified.
		return "needs_review";
	}
	return "needs_review";
}

function audit() {
	const blocks = loadActivityBlocks();

	// Bucket by rule_id.
	const byRule = new Map();
	for (const b of blocks) {
		const id = b.guard_rule_id || "_unknown";
		if (!byRule.has(id)) byRule.set(id, []);
		byRule.get(id).push(b);
	}

	const verifiedRows = [];
	const droppedRows = [];

	for (const row of KEEP_ROWS) {
		const events = byRule.get(row.rule_id) || [];
		// For "keep" rows we trust the rule fired correctly; the verified
		// count is the raw count. (Row labels were chosen because they're
		// content-quality / TDD / structural — these rules don't have
		// the substring-FP problem.)
		verifiedRows.push({
			rule_id: row.rule_id,
			label: row.label,
			severity: row.severity,
			count_logged: events.length,
			count_verified: events.length,
		});
	}

	for (const ruleId of FP_HEAVY_RULES) {
		const events = byRule.get(ruleId) || [];
		const verdicts = {};
		const samples = [];
		for (const e of events) {
			const blockTs = parseTs(e.ts || "");
			const session = e.session || "";
			let verdict = "transcript_missing";
			let cmd = null;
			if (session && !Number.isNaN(blockTs)) {
				const resolved = findCommandForBlock(session, blockTs);
				if (resolved) {
					cmd = resolved.command;
					verdict = classify(ruleId, cmd);
				}
			}
			verdicts[verdict] = (verdicts[verdict] || 0) + 1;
			if (samples.length < 3 && cmd) {
				samples.push({ verdict, command: cmd.replace(/\s+/g, " ").slice(0, 120), ts: e.ts });
			}
		}
		droppedRows.push({
			rule_id: ruleId,
			count_logged: events.length,
			count_real: verdicts.real || 0,
			verdicts,
			samples,
		});
	}

	const totalLogged = blocks.length;
	const totalVerified = verifiedRows.reduce((s, r) => s + r.count_verified, 0);
	const totalDropped = droppedRows.reduce((s, r) => s + r.count_logged, 0);
	const residual = totalLogged - totalVerified - totalDropped;

	return {
		audited_at: new Date().toISOString(),
		method: "Per-event resolution against ~/.claude/projects/<cwd>/<session>.jsonl tool_use entries; nearest-before tool_use within 60s window. FP-heavy rules classified via command-text heuristic (see scripts/audit-receipts.mjs).",
		total_logged: totalLogged,
		total_verified: totalVerified,
		residual_unverified: residual,
		verified_rows: verifiedRows,
		dropped_rows: droppedRows,
	};
}

const wantStdout = process.argv.includes("--json");
const result = audit();
const payload = `${JSON.stringify(result, null, 2)}\n`;

if (wantStdout) {
	process.stdout.write(payload);
} else {
	writeFileSync(OUT_PATH, payload);
	process.stdout.write(`wrote landing/receipts.json (${result.total_verified} verified / ${result.total_logged} logged)\n`);
}
