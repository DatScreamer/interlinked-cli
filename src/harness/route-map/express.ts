// ===========================================
// Route-map adapter — Express
// ===========================================
// Recognizes the explicit-call routing shape Express ships with:
//   app.get("/path", handler)
//   router.post("/path", handler)
//   adminRouter.use(authMiddleware)
//   router.delete("/users/:id", handler)
//
// V1 is regex-based — no AST. The trade-off matches the Phase A3 mandate:
// "no runtime dependency, heuristic is fine for V1". Adapter is pure;
// caller is responsible for I/O. Auth-chain detection lives in
// `../auth-chain.ts` and is wired in below — every Endpoint comes back
// with `auth_chain` populated.

import { detectAuthChain } from "../auth-chain.js";
import type { Endpoint } from "../types/session.js";
import {
	isInsideStringLiteral,
	lineNumberAt,
	makeEndpoint,
	sniffInlineHandlerSymbol,
} from "./shared.js";

/**
 * Matches `<receiver>.<method>("/path"` where:
 *   - `<receiver>` is any identifier; the {@link RECEIVER_NAME_RE}
 *     post-filter pins it down to identifiers ending in `app`, `router`,
 *     `server`, `api`, or `hono`.
 *   - `<method>` is a recognized HTTP verb or `all`.
 *
 * Group 1 = receiver, group 2 = verb, group 3 = path.
 */
const METHOD_RE =
	/(?:^|[^.\w])([A-Za-z_$][\w$]*?)\.(get|post|put|patch|delete|head|options|all)\s*\(\s*["'`]([^"'`]+)["'`]/gi;

/** Receiver suffixes accepted as Express-style routers. */
const RECEIVER_NAME_RE = /(?:app|router|server|api|hono)$/i;

function lineIsCommented(line: string): boolean {
	return /^\s*\/\//.test(line);
}

/**
 * Walks `content` once and emits an {@link Endpoint} per Express-style
 * route registration. Each Endpoint has `auth_chain` populated via
 * {@link detectAuthChain}; path params derive from the URL pattern.
 */
export function extractEndpoints(filePath: string, content: string): Endpoint[] {
	const endpoints: Endpoint[] = [];
	const seen = new Set<string>();
	const lines = content.split("\n");
	METHOD_RE.lastIndex = 0;
	for (let m = METHOD_RE.exec(content); m !== null; m = METHOD_RE.exec(content)) {
		const receiver = m[1];
		if (!RECEIVER_NAME_RE.test(receiver)) continue;
		const verb = m[2].toUpperCase();
		const path = m[3];
		const receiverOffset = m.index + (m[0].indexOf(receiver) >= 0 ? m[0].indexOf(receiver) : 0);
		const line = lineNumberAt(content, receiverOffset);
		const lineText = lines[line - 1] ?? "";
		if (lineIsCommented(lineText)) continue;
		if (isInsideStringLiteral(receiverOffset, content)) continue;
		const key = `${verb}:${path}:${line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const handlerSymbol = sniffInlineHandlerSymbol(lineText, content, line);
		const endpoint = makeEndpoint({
			framework: "express",
			method: verb,
			path,
			file: filePath,
			line,
			handler_symbol: handlerSymbol,
		});
		endpoint.auth_chain = detectAuthChain("express", filePath, content, line);
		endpoints.push(endpoint);
	}
	return endpoints;
}
