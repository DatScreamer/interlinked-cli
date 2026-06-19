// interlinked-tdd: exempt
// ===========================================
// Interlinked Harness — Endpoint / Route-Map Types
// (extracted from session.ts; pure type declarations, no runtime logic)
// ===========================================

/**
 * Supported endpoint framework discriminators (Phase A3 of the
 * security-scanning plan). Each value matches an adapter under
 * `src/harness/route-map/<framework>.ts`.
 *
 * - `express` / `hono`: explicit-call frameworks where routes are
 *   declared via `app.<method>(...)` / `router.<method>(...)` chains.
 * - `nextjs` / `sveltekit` / `nuxt`: file-convention frameworks where
 *   the URL path is derived from the path on disk.
 * - `fastapi`: Python decorator-based routing (`@app.get(...)`).
 * - `mcp`: MCP `server.tool(...)` definitions, not HTTP but follows the
 *   same "named handler" shape.
 */
export type EndpointFramework =
	| "express"
	| "hono"
	| "nextjs"
	| "fastapi"
	| "mcp"
	| "sveltekit"
	| "nuxt";

/**
 * Auth chain entry attached to an extracted endpoint. Captured from any of
 * three shapes depending on framework:
 * - `middleware`: an Express/Hono `.use(authFn)` reference upstream.
 * - `depends`: a FastAPI `Depends(get_current_user)` injection.
 * - `matcher`: a Next.js `middleware.ts` `config.matcher` entry that covers
 *   the route path.
 *
 * `file`/`line` are optional because some auth markers (the matcher case)
 * point at a sibling file, not the route file itself.
 */
export interface AuthChainEntry {
	name: string;
	kind: "middleware" | "depends" | "matcher";
	file?: string | undefined;
	line?: number | undefined;
}

/**
 * Declared parameter on an extracted endpoint. `source` distinguishes
 * convention-derived path params (`[id]` / `:id`) from query/body/header
 * params parsed out of handler signatures. `schema_name` (optional) is the
 * name of a Zod / Valibot / Pydantic schema referenced in the handler
 * signature — populated when the heuristic finds one and left undefined
 * otherwise.
 */
export interface ParamSpec {
	name: string;
	source: "path" | "query" | "body" | "header";
	optional?: boolean;
	schema_name?: string;
}

/**
 * Endpoint — the richer route record consumed by the Phase B detectors and
 * any future Agent CI cloud sweep. Replaces the V0 `RouteInfo` shape; that
 * type now exists only as a deprecated alias for the lone structural-checks
 * consumer.
 */
export interface Endpoint {
	framework: EndpointFramework;
	/** HTTP method ("GET"/"POST"/...), "ALL" for match-anything routes, or "TOOL" for MCP tools. */
	method: string;
	/** URL path pattern (or MCP tool name when `framework === "mcp"`). */
	path: string;
	/** Nearest-preceding handler symbol — best-effort heuristic, may be undefined. */
	handler_symbol?: string | undefined;
	/** Absolute path of the file containing the route definition. */
	file: string;
	/** Line number (1-indexed) of the route-registration site. */
	line?: number | undefined;
	/** Auth middleware / Depends / matcher entries upstream of this handler. */
	auth_chain: AuthChainEntry[];
	/** Declared path/query/body/header params for this endpoint. */
	declared_params: ParamSpec[];
}

/**
 * @deprecated Use {@link Endpoint} via `RouteMap.extractEndpointsForFile`.
 * Retained as a structural alias so the lone existing consumer
 * (`structural-checks.ts:getRouteContext`) keeps compiling while the
 * endpoint-security pack lands. `handler_file` is the back-compat name for
 * `Endpoint.file`.
 */
export type RouteInfo = {
	method: string;
	path: string;
	/** Back-compat alias for `Endpoint.file`. */
	handler_file: string;
	line?: number | undefined;
};
