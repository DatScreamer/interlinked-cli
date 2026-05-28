// interlinked-tdd: exempt — WorkerEntrypoint orchestration shell. The evaluator
// (governor/evaluate.ts) and identity validation (auth/oauth-helpers parseProps)
// are unit-tested; the DO interaction is exercised by the deploy-time e2e (F).
//
// This is the OAuthProvider `apiHandler`: it ONLY runs for requests the provider
// already authorized, so identity arrives in this.ctx.props. workspace_id is
// taken from props (bound to the token at login) — NEVER from the client.

import { WorkerEntrypoint } from "cloudflare:workers";
import { parseProps } from "./auth/oauth-helpers.js";
import { evaluate } from "./governor/evaluate.js";
import type { Env, HookEvent, Props, Verdict } from "./types.js";

const EVALUATE_PATH = "/governor/evaluate";
const ADMIN_RECENT_PATH = "/admin/recent";
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 200;

export class ApiHandler extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
		// props is set by workers-oauth-provider for every authorized request.
		const props = parseProps((this.ctx as { props?: unknown }).props);
		if (!props) return json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);

		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === EVALUATE_PATH) {
			return this.handleEvaluate(request, props);
		}
		if (request.method === "GET" && url.pathname === ADMIN_RECENT_PATH) {
			return this.handleAdminRecent(url, props);
		}
		return new Response("not found", { status: HTTP_NOT_FOUND });
	}

	private async handleEvaluate(request: Request, props: Props): Promise<Response> {
		let event: HookEvent;
		try {
			event = (await request.json()) as HookEvent;
		} catch {
			return json({ error: "invalid json body" }, HTTP_BAD_REQUEST);
		}
		if (!event.hook_event || !event.session_id || !event.tool_name) {
			return json({ error: "missing required event fields" }, HTTP_BAD_REQUEST);
		}
		const verdict: Verdict = evaluate(event);
		this.ctx.waitUntil(this.persist(props.workspaceId, event, verdict));
		return json(verdict);
	}

	private async handleAdminRecent(url: URL, props: Props): Promise<Response> {
		const limit = parseLimit(url.searchParams.get("limit"));
		const stub = this.supervisorFor(props.workspaceId);
		// Annotation pins the shape — the DO RPC stub's return-type inference
		// through Rpc.Promisified doesn't always propagate cleanly under strict.
		const events: Array<Record<string, unknown>> = await stub.recentEvents(limit);
		return json({ events, count: events.length, workspace_id: props.workspaceId, limit });
	}

	private async persist(workspaceId: string, event: HookEvent, verdict: Verdict): Promise<void> {
		await this.supervisorFor(workspaceId).recordEvent(workspaceId, event, verdict);
	}

	private supervisorFor(workspaceId: string) {
		const id = this.env.SUPERVISOR.idFromName(workspaceId);
		return this.env.SUPERVISOR.get(id);
	}
}

function parseLimit(raw: string | null): number {
	if (raw === null) return DEFAULT_RECENT_LIMIT;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RECENT_LIMIT;
	return Math.min(parsed, MAX_RECENT_LIMIT);
}

function json(body: unknown, status = HTTP_OK): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
