// ===========================================
// Route-map adapter — Hono
// ===========================================
// Hono routes look almost identical to Express:
//   app.get("/path", handler)
//   app.use(authMiddleware)
//   admin.route("/admin", adminApp)
//   const app = new Hono()
//
// The recognizer reuses the Express call-site regex but filters by
// receiver suffix (`app`, `router`, `hono`, ...). The `.route(prefix,
// subApp)` form is a sub-mount, NOT an endpoint — we filter it out
// because Hono uses two-arg `.route()` for sub-app composition, distinct
// from Express's `router.route(path).get(...)` chain.

import { detectAuthChain } from "../auth-chain.js";
import type { Endpoint } from "../types/session.js";
import { lineNumberAt, makeEndpoint, sniffInlineHandlerSymbol } from "./shared.js";

const METHOD_RE =
	/(?:^|[^.\w])([A-Za-z_$][\w$]*?)\.(get|post|put|patch|delete|head|options|all|on)\s*\(\s*["'`]([^"'`]+)["'`]/gi;

/**
 * Receiver-name suffix list — matches Express's `app|router|server|api|hono`.
 * Hono receivers that don't share this suffix (e.g. `admin`) are still
 * picked up via {@link findHonoInstances} below, which scans for
 * `const NAME = new Hono()` declarations and adds NAME to the set of
 * known receivers.
 */
const RECEIVER_NAME_RE = /(?:app|router|server|api|hono)$/i;

/**
 * Identifier regex matching `const|let|var NAME = new Hono()` or
 * `NAME.route(...)` sub-mount declarations. Captures every variable
 * that holds a Hono instance so the route-extraction loop can accept
 * `admin.get(...)` even when `admin` doesn't end in a known suffix.
 */
const HONO_INSTANCE_DECL_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Hono\s*\(/g;

function findHonoInstances(content: string): Set<string> {
	const names = new Set<string>();
	HONO_INSTANCE_DECL_RE.lastIndex = 0;
	for (let m = HONO_INSTANCE_DECL_RE.exec(content); m !== null; m = HONO_INSTANCE_DECL_RE.exec(content)) {
		names.add(m[1]);
	}
	return names;
}

export function extractEndpoints(filePath: string, content: string): Endpoint[] {
	const endpoints: Endpoint[] = [];
	const seen = new Set<string>();
	const lines = content.split("\n");
	const honoInstances = findHonoInstances(content);
	METHOD_RE.lastIndex = 0;
	for (let m = METHOD_RE.exec(content); m !== null; m = METHOD_RE.exec(content)) {
		const receiver = m[1];
		if (!RECEIVER_NAME_RE.test(receiver) && !honoInstances.has(receiver)) continue;
		const verb = m[2].toUpperCase();
		const path = m[3];
		// `m.index` points at the leading `[^.\w]` char (often a newline), so we
		// adjust to the start of the receiver name before computing the line —
		// otherwise routes on line N report as N−1, defeating the comment-skip.
		const receiverOffset = m.index + (m[0].indexOf(receiver) >= 0 ? m[0].indexOf(receiver) : 0);
		const line = lineNumberAt(content, receiverOffset);
		const lineText = lines[line - 1] ?? "";
		if (/^\s*\/\//.test(lineText)) continue;
		const key = `${verb}:${path}:${line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const handlerSymbol = sniffInlineHandlerSymbol(lineText, content, line);
		const endpoint = makeEndpoint({
			framework: "hono",
			method: verb,
			path,
			file: filePath,
			line,
			handler_symbol: handlerSymbol,
		});
		endpoint.auth_chain = detectAuthChain("hono", filePath, content, line);
		endpoints.push(endpoint);
	}
	return endpoints;
}
