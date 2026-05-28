// interlinked-tdd: exempt
import { DurableObject } from "cloudflare:workers";
import type { Env, HookEvent, Verdict } from "../types.js";

export class Supervisor extends DurableObject<Env> {
	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				workspace_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				agent_source TEXT NOT NULL,
				agent_name TEXT,
				hook_event TEXT NOT NULL,
				tool_name TEXT,
				payload_json TEXT NOT NULL,
				decision TEXT,
				rule_id TEXT,
				created_at INTEGER NOT NULL
			)
		`);
		this.ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS idx_events_workspace_created ON events (workspace_id, created_at)"
		);
		this.ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS idx_events_session_created ON events (session_id, created_at)"
		);
	}

	async recordEvent(workspace_id: string, event: HookEvent, verdict: Verdict): Promise<void> {
		this.ctx.storage.sql.exec(
			`INSERT INTO events
				(workspace_id, session_id, agent_source, agent_name, hook_event, tool_name, payload_json, decision, rule_id, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			workspace_id,
			event.session_id,
			event.agent_source,
			event.agent_name ?? null,
			event.hook_event,
			event.tool_name,
			JSON.stringify(event),
			verdict.decision,
			verdict.rule_id ?? null,
			Date.now()
		);
	}

	async recentEvents(limit = 20): Promise<Array<Record<string, unknown>>> {
		const cursor = this.ctx.storage.sql.exec(
			"SELECT id, session_id, hook_event, tool_name, decision, rule_id, created_at FROM events ORDER BY id DESC LIMIT ?",
			limit
		);
		return cursor.toArray() as Array<Record<string, unknown>>;
	}
}
