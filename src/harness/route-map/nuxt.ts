// ===========================================
// Route-map adapter — Nuxt
// ===========================================
// Nuxt 3+ uses `server/api/<path>.{get,post,put,patch,delete}.ts` as
// the route convention. Filename suffix carries the HTTP method:
//   server/api/users.get.ts          → GET  /api/users
//   server/api/users/[id].patch.ts   → PATCH /api/users/:id
// When the filename has no method suffix, the handler responds to ALL
// methods.

import type { Endpoint } from "../types/session.js";
import { makeEndpoint } from "./shared.js";
import { nonNull } from "../../lib/non-null.js";

const NUXT_API_FILE = /[/\\]server[/\\]api[/\\](.+?)\.(?:ts|js)$/;
const METHOD_SUFFIX_RE = /\.(get|post|put|patch|delete|head|options)$/i;

export function extractEndpoints(filePath: string, content: string): Endpoint[] {
	const match = filePath.match(NUXT_API_FILE);
	if (!match) return [];
	// Light "is this a Nuxt handler" sanity check — must reference
	// defineEventHandler / eventHandler / readBody / setHeader / etc.
	// Cheap but effective at suppressing the `src/lib/api/foo.ts` shape.
	if (!/\b(?:defineEventHandler|eventHandler|readBody|sendError|setHeader|setResponseStatus)\b/.test(content)) {
		// Allow the convention to fire even without a recognized helper
		// when the file path matches — many real Nuxt projects use the
		// default-export-function shape — but only if the export is a
		// `export default` of a function-like value.
		if (!/^\s*export\s+default\b/m.test(content)) return [];
	}
	const rawSegments = nonNull(match[1]);
	const methodMatch = METHOD_SUFFIX_RE.exec(rawSegments);
	const method = methodMatch ? nonNull(methodMatch[1]).toUpperCase() : "ALL";
	const segments = rawSegments.replace(METHOD_SUFFIX_RE, "");
	// Rewrite [id] → :id (Nuxt uses the same convention as Next.js for
	// dynamic segments).
	const urlPath = `/api/${segments
		.replace(/[/\\]/g, "/")
		.replace(/\[(\w+)\]/g, ":$1")}`;
	return [
		makeEndpoint({
			framework: "nuxt",
			method,
			path: urlPath,
			file: filePath,
		}),
	];
}
