// ===========================================
// Route-map adapter — FastAPI
// ===========================================
// FastAPI routes are Python-decorator-based:
//   @app.get("/items")
//   def list_items():
//       ...
//
//   @router.delete("/orders/{order_id}", dependencies=[Depends(auth)])
//   async def delete_order(order_id: int, user=Depends(get_current_user)):
//       ...
//
// We scan for `@<receiver>.<method>("...")` decorators, then look at
// the following line(s) for the `def <name>(` definition. Path params
// use `{name}` syntax; handler-signature params can carry a
// `Depends(...)` call that the auth-chain detector picks up.

import { nonNull } from "../../lib/non-null.js";
import { detectAuthChain } from "../auth-chain.js";
import type { Endpoint, ParamSpec } from "../types/session.js";
import { extractPathParams, findHandlerSymbol, lineNumberAt, makeEndpoint } from "./shared.js";

/**
 * `@<receiver>.<verb>("/path"...)` decorator regex.
 *   group 1 = receiver (app | router | …)
 *   group 2 = verb (get | post | put | patch | delete | head | options)
 *   group 3 = path
 */
const DECORATOR_RE =
	/^[ \t]*@\s*([A-Za-z_][\w]*)\.(get|post|put|patch|delete|head|options|api_route)\s*\(\s*["']([^"']+)["']/gim;

/**
 * Common FastAPI router-receiver names. Loose suffix match — anything
 * ending in `app`, `router`, `api` qualifies, plus the popular short
 * names `v1` / `v2` / etc. via the numeric-suffix branch.
 */
const RECEIVER_NAME_RE = /^(?:app|router|api|v\d+)$|^.*(?:[Rr]outer|[Aa]pp|[Aa]pi)$/;

/** FastAPI's `api_route` registers a single handler for ALL methods. */
const API_ROUTE_VERB = "API_ROUTE";
/** Synthetic method for `api_route` decorators (no specific HTTP verb). */
const ALL_METHODS = "ALL";

export function extractEndpoints(filePath: string, content: string): Endpoint[] {
	const endpoints: Endpoint[] = [];
	const seen = new Set<string>();
	DECORATOR_RE.lastIndex = 0;
	for (let m = DECORATOR_RE.exec(content); m !== null; m = DECORATOR_RE.exec(content)) {
		const receiver = nonNull(m[1]);
		if (!RECEIVER_NAME_RE.test(receiver)) continue;
		const verb = nonNull(m[2]).toUpperCase();
		const path = nonNull(m[3]);
		const line = lineNumberAt(content, m.index);
		const key = `${verb}:${path}:${line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const handlerSymbol = findHandlerSymbol(content, line, { language: "python" });
		const declaredParams = collectDeclaredParams(content, line, path);
		const endpoint = makeEndpoint({
			framework: "fastapi",
			method: verb === API_ROUTE_VERB ? ALL_METHODS : verb,
			path,
			file: filePath,
			line,
			handler_symbol: handlerSymbol,
			declared_params: declaredParams,
		});
		endpoint.auth_chain = detectAuthChain("fastapi", filePath, content, line);
		endpoints.push(endpoint);
	}
	return endpoints;
}

/**
 * Path params come from the URL `{name}` syntax. Body / query / header
 * params would require parsing the handler signature with type
 * annotations — for V1 we only emit path params, which is enough to
 * power the Phase B IDOR detector. Future expansion: parse the
 * signature's `param: Type = Query(...)` / `Header(...)` / `Body(...)`
 * markers (FastAPI's canonical injection sites).
 */
function collectDeclaredParams(_content: string, _line: number, path: string): ParamSpec[] {
	return extractPathParams(path);
}
