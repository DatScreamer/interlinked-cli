// ===========================================
// interlinked skill — Skill marker management
// ===========================================
// Posts SkillEnter / SkillLeave / SkillList events to the harness via Unix
// socket. Skill markers populate `SessionTrajectory.active_skills`, which the
// active_when predicate evaluator reads to scope distilled rules. See
// docs/design/harness-active-when-scoping.md.

import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import type { JsonObject } from "../lib/json-types.js";
import { c, header, kvLine, table } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { getSocketPath } from "./harness.js";

interface ActiveSkillRecord {
	name: string;
	entered_at: number;
	expires_at: number;
	source: "cli" | "hook" | "manual";
}

interface SkillListSession {
	session_id: string;
	agent_name: string;
	skills: ActiveSkillRecord[];
}

const SOCKET_TIMEOUT_MS = 2000;

export async function skillEnterCommand(
	name: string,
	opts: { ttl?: string; session?: string; source?: string; json?: boolean },
): Promise<void> {
	const mode = getOutputMode(opts);
	const trimmed = name?.trim();
	if (!trimmed) {
		outputError(mode, "skill name required");
		process.exitCode = 1;
		return;
	}
	const ttlSeconds = opts.ttl ? parseTtl(opts.ttl) : undefined;
	if (opts.ttl && ttlSeconds === null) {
		outputError(mode, `invalid --ttl '${opts.ttl}'. Use a duration like 30m, 1h, 90s.`);
		process.exitCode = 1;
		return;
	}

	const reply = await sendSkillEvent({
		hook_event: "SkillEnter",
		session_id: opts.session ?? "",
		tool_input: {
			name: trimmed,
			...(ttlSeconds !== undefined ? { ttl_seconds: ttlSeconds } : {}),
			...(opts.source ? { source: opts.source } : {}),
		},
	});

	if (!reply) {
		outputError(mode, "Could not reach harness — is `interlinked harness start` running?");
		process.exitCode = 1;
		return;
	}

	output(mode, { skill: trimmed, status: "entered" }, {
		json: () => ({ skill: trimmed, status: "entered", ttl_seconds: ttlSeconds ?? null }),
		normal: () => `${c.green("✓")} skill entered: ${c.bold(trimmed)}${ttlSeconds ? c.dim(` (ttl ${formatTtl(ttlSeconds)})`) : ""}`,
	});
}

export async function skillLeaveCommand(
	name: string,
	opts: { session?: string; json?: boolean },
): Promise<void> {
	const mode = getOutputMode(opts);
	const trimmed = name?.trim();
	if (!trimmed) {
		outputError(mode, "skill name required");
		process.exitCode = 1;
		return;
	}

	const reply = await sendSkillEvent({
		hook_event: "SkillLeave",
		session_id: opts.session ?? "",
		tool_input: { name: trimmed },
	});

	if (!reply) {
		outputError(mode, "Could not reach harness — is `interlinked harness start` running?");
		process.exitCode = 1;
		return;
	}

	output(mode, { skill: trimmed, status: "left" }, {
		json: () => ({ skill: trimmed, status: "left" }),
		normal: () => `${c.green("✓")} skill left: ${c.bold(trimmed)}`,
	});
}

export async function skillListCommand(
	opts: { session?: string; json?: boolean },
): Promise<void> {
	const mode = getOutputMode(opts);

	const reply = await sendSkillEvent({
		hook_event: "SkillList",
		session_id: opts.session ?? "",
		tool_input: {},
	});

	if (!reply) {
		outputError(mode, "Could not reach harness — is `interlinked harness start` running?");
		process.exitCode = 1;
		return;
	}

	const raw = reply.additional_context;
	let parsed: SkillListSession[] = [];
	if (typeof raw === "string" && raw.length > 0) {
		try {
			parsed = JSON.parse(raw) as SkillListSession[];
		} catch {
			outputError(mode, "harness returned malformed skill list");
			process.exitCode = 1;
			return;
		}
	}

	output(mode, parsed, {
		json: () => parsed,
		normal: () => formatSkillListNormal(parsed),
	});
}

function formatSkillListNormal(sessions: SkillListSession[]): string {
	if (sessions.length === 0) {
		return c.dim("No active sessions.");
	}
	const lines: string[] = [];
	lines.push(header("Active skills"));
	const now = Date.now();
	let total = 0;
	for (const s of sessions) {
		if (s.skills.length === 0) continue;
		lines.push("");
		lines.push(`${c.bold(s.agent_name)} ${c.dim(`(${s.session_id.slice(0, 8)})`)}`);
		const rows: Array<[string, string, string, string]> = s.skills.map((sk) => [
			sk.name,
			formatTtl(Math.max(0, Math.round((sk.expires_at - now) / 1000))),
			sk.source,
			new Date(sk.entered_at).toISOString().slice(11, 19),
		]);
		lines.push(table(["skill", "expires in", "source", "entered (utc)"], rows));
		total += s.skills.length;
	}
	if (total === 0) {
		return c.dim("No active skills across all sessions.");
	}
	lines.push("");
	lines.push(kvLine("total", String(total)));
	return lines.join("\n");
}

function parseTtl(raw: string): number | null {
	const m = raw.trim().match(/^(\d+)([smh]|min|sec|hr)?$/i);
	if (!m) return null;
	const n = Number(m[1]);
	if (!Number.isFinite(n) || n <= 0) return null;
	const unit = (m[2] || "s").toLowerCase();
	if (unit === "s" || unit === "sec") return n;
	if (unit === "m" || unit === "min") return n * 60;
	if (unit === "h" || unit === "hr") return n * 3600;
	return n;
}

function formatTtl(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return `${Math.round((seconds / 3600) * 10) / 10}h`;
}

function sendSkillEvent(event: JsonObject): Promise<JsonObject | null> {
	return new Promise((resolve) => {
		const socketPath = getSocketPath();
		if (!existsSync(socketPath)) {
			resolve(null);
			return;
		}

		const payload = {
			...event,
			timestamp: new Date().toISOString(),
			agent_source: "cli",
		};

		const sock = createConnection(socketPath);
		const timeout = setTimeout(() => {
			try {
				sock.destroy();
			} catch {
				/* socket already gone */
			}
			resolve(null);
		}, SOCKET_TIMEOUT_MS);

		let data = "";
		sock.on("connect", () => {
			sock.write(`${JSON.stringify(payload)}\n`);
		});
		sock.on("data", (chunk) => {
			data += chunk.toString();
			const nlIdx = data.indexOf("\n");
			if (nlIdx !== -1) {
				clearTimeout(timeout);
				sock.destroy();
				try {
					resolve(JSON.parse(data.slice(0, nlIdx)) as JsonObject);
				} catch {
					resolve(null);
				}
			}
		});
		sock.on("error", () => {
			clearTimeout(timeout);
			resolve(null);
		});
	});
}
