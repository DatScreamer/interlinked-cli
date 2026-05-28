// interlinked-tdd: exempt
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types.js";

// Per-session Facet DO. v0 scaffold — declared so wrangler.jsonc binds it and
// the architecture forces session-scoped state out of the Supervisor; actual
// trajectory writes wired in a later phase.
export class Facet extends DurableObject<Env> {
	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS trajectory (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				hook_event TEXT NOT NULL,
				tool_name TEXT,
				payload_json TEXT NOT NULL,
				recorded_at INTEGER NOT NULL
			)
		`);
	}

	async ping(): Promise<string> {
		return "facet-alive";
	}
}
