// interlinked-tdd: exempt
import { authenticateRequest } from "./auth.js";
import { evaluate } from "./governor/evaluate.js";
import type { Env, HookEvent, Verdict } from "./types.js";

export { Supervisor } from "./dos/supervisor.js";
export { Facet } from "./dos/facet.js";

const HEALTH_PATH = "/health";
const EVALUATE_PATH = "/governor/evaluate";
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === HEALTH_PATH) {
			return json({ status: "ok", environment: env.ENVIRONMENT ?? "unknown" });
		}

		if (request.method === "POST" && url.pathname === EVALUATE_PATH) {
			return handleEvaluate(request, env, ctx);
		}

		return new Response("not found", { status: HTTP_NOT_FOUND });
	},
} satisfies ExportedHandler<Env>;

async function handleEvaluate(
	request: Request,
	env: Env,
	ctx: ExecutionContext
): Promise<Response> {
	const auth = authenticateRequest(request, env);
	if (!auth.authenticated || !auth.workspace_id) {
		return json({ error: auth.error ?? "unauthorized" }, HTTP_UNAUTHORIZED);
	}

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

	ctx.waitUntil(persistAsync({ env, workspace_id: auth.workspace_id, event, verdict }));

	return json(verdict);
}

interface PersistArgs {
	env: Env;
	workspace_id: string;
	event: HookEvent;
	verdict: Verdict;
}

async function persistAsync({ env, workspace_id, event, verdict }: PersistArgs): Promise<void> {
	const id = env.SUPERVISOR.idFromName(workspace_id);
	const stub = env.SUPERVISOR.get(id);
	await stub.recordEvent(workspace_id, event, verdict);
}

function json(body: unknown, status = HTTP_OK): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
