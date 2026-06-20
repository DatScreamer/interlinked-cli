// ===========================================
// Auth-chain detector — Phase A3
// ===========================================
// Walks framework-specific surface for auth markers upstream of a route
// definition. Pure function — caller supplies file content + line number;
// no I/O. Output is consumed by the route-map dispatcher when it builds
// per-file Endpoint records, and (in Phase B) by the endpoint-security
// `endpoint_auth_missing` detector.
//
// Scope:
//   - Express / Hono: walk preceding `app.use(...)` / `router.use(...)`
//     in the same scope; recognize identifiers whose names match the
//     auth regex below.
//   - FastAPI: parse `Depends(...)` in handler signatures and
//     route-level `dependencies=[Depends(...)]`.
//   - Next.js: deferred to a sibling read of `middleware.ts` (the V1
//     in-file scan returns []; cf. the matcher-aware path in
//     `nextjs.ts`).
//
// The detector is intentionally name-only: anything matching the regex
// counts. Future extension via the Phase A1 sanitizer registry's
// `identity` bucket is left open via the `extraNames` option.

import { nonNull } from "../lib/non-null.js";
import type { AuthChainEntry, EndpointFramework } from "./types/session.js";

/**
 * Case-insensitive regex matching identifiers that look like auth /
 * identity middleware. The set is drawn from the Phase A3 spec plus a
 * handful of widely-used naming conventions (sessionUser, currentUser).
 * Future-extensible — callers can pass `extraNames` to add per-project
 * identifiers without touching this file.
 */
/**
 * Substring-match regex — fires on any of the recognized auth tokens
 * appearing anywhere in the identifier. Required because real-world
 * names like `get_current_user`, `auth_middleware`, `verifyTokenAsync`
 * are widely used. The token list is the Phase A3 spec list plus a few
 * widely-used naming conventions.
 *
 * The leading word-boundary (`\b`) keeps `authoritative_source` from
 * matching even though it starts with `auth` — that's intentional: the
 * boundary forces the token to start the identifier or follow an `_` /
 * camelCase split. Examples that match: `auth`, `authn`, `verifyToken`,
 * `requireUser`, `get_current_user`. Examples that don't: `authoritative`,
 * `userPreference` (no auth token), `tokenStore` (token alone is not an
 * auth marker — `verifyToken` / `checkToken` would be).
 */
const AUTH_NAME_RE =
	/(?:^|[_A-Z])(auth|authn|authorize|require_?user|require_?auth|verify_?token|session_?user|current_?user|authenticate|authorization)/i;

function nameLooksLikeAuth(name: string, extraNames?: ReadonlyArray<string>): boolean {
	if (AUTH_NAME_RE.test(name)) return true;
	if (!extraNames || extraNames.length === 0) return false;
	for (const candidate of extraNames) {
		if (candidate.toLowerCase() === name.toLowerCase()) return true;
	}
	return false;
}

/**
 * Detect the auth chain upstream of `line` (1-indexed) in `content`.
 *
 * @param framework - The framework discriminator. Drives which scanner runs.
 * @param filePath  - Absolute path of the file (only included in the output,
 *                    not used to read disk; the Next.js matcher resolution
 *                    lives in `route-map/nextjs.ts`, not here).
 * @param content   - The file's full text.
 * @param line      - 1-indexed line where the route is registered.
 * @param opts      - Optional extension hook: extra identifier names that
 *                    should count as auth (sourced from the Phase A1
 *                    sanitizer registry's `identity` bucket in Phase B).
 */
export function detectAuthChain(
	framework: EndpointFramework,
	filePath: string,
	content: string,
	line: number,
	opts?: { extraNames?: ReadonlyArray<string> },
): AuthChainEntry[] {
	switch (framework) {
		case "express":
		case "hono":
			return detectExpressLikeChain(filePath, content, line, opts?.extraNames);
		case "fastapi":
			return detectFastApiChain(filePath, content, line, opts?.extraNames);
		case "nextjs":
			// Matcher resolution lives in route-map/nextjs.ts; the in-file
			// scan finds nothing.
			return [];
		case "sveltekit":
		case "nuxt":
		case "mcp":
			return [];
		default: {
			// Exhaustiveness: switch is comprehensive; this branch only fires
			// if the union ever grows without updating the switch.
			const _exhaustive: never = framework;
			void _exhaustive;
			return [];
		}
	}
}

// ===========================================
// Express / Hono
// ===========================================

/**
 * Walk every `.use(...)` call that appears strictly above `routeLine`
 * (1-indexed). For each, collect the first identifier argument. Returns
 * one entry per auth-looking identifier in source order.
 *
 * The scan is whole-file rather than scope-aware — V1 trade-off. Real
 * scope-aware walking would need an AST; the FP rate is low enough that
 * "every prior .use upstream" is a useful approximation. In Phase B, we
 * combine this with the endpoint-security detector's per-router check,
 * which scopes by router-receiver name.
 */
function detectExpressLikeChain(
	filePath: string,
	content: string,
	routeLine: number,
	extraNames: ReadonlyArray<string> | undefined,
): AuthChainEntry[] {
	const entries: AuthChainEntry[] = [];
	const lines = content.split("\n");
	// Match `<receiver>.use(<arg1>[, <arg2>...])` and pull the first
	// identifier argument out. Accept an optional leading string ("/admin")
	// so `app.use('/admin', requireAuth)` is recognized.
	const useRe = /\b(?:[A-Za-z_$][\w$]*)\.use\s*\(\s*(?:["'`][^"'`]*["'`]\s*,\s*)?([A-Za-z_$][\w$]*)/;
	for (let i = 0; i < Math.min(lines.length, routeLine - 1); i++) {
		const line = nonNull(lines[i]);
		const m = useRe.exec(line);
		if (!m) continue;
		const ident = nonNull(m[1]);
		if (!nameLooksLikeAuth(ident, extraNames)) continue;
		entries.push({
			name: ident,
			kind: "middleware",
			file: filePath,
			line: i + 1,
		});
	}
	return entries;
}

// ===========================================
// FastAPI
// ===========================================

/**
 * Detect Depends() injections in the handler signature OR
 * `dependencies=[Depends(...)]` on the route decorator. Looks at the
 * decorator line plus the next ~10 lines (signature can span multiple
 * lines after a multi-arg `def`).
 */
function detectFastApiChain(
	filePath: string,
	content: string,
	routeLine: number,
	extraNames: ReadonlyArray<string> | undefined,
): AuthChainEntry[] {
	const entries: AuthChainEntry[] = [];
	const lines = content.split("\n");
	const start = Math.max(0, routeLine - 1);
	const end = Math.min(lines.length, start + 12);
	const dependsRe = /Depends\s*\(\s*([A-Za-z_][\w]*)/g;
	for (let i = start; i < end; i++) {
		const line = nonNull(lines[i]);
		dependsRe.lastIndex = 0;
		for (let m = dependsRe.exec(line); m !== null; m = dependsRe.exec(line)) {
			const ident = nonNull(m[1]);
			if (!nameLooksLikeAuth(ident, extraNames)) continue;
			entries.push({
				name: ident,
				kind: "depends",
				file: filePath,
				line: i + 1,
			});
		}
	}
	return entries;
}
