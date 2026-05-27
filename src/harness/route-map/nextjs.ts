// ===========================================
// Route-map adapter — Next.js
// ===========================================
// Next.js App Router uses a file-system convention: any file at
// `app/**/route.{ts,js}` whose path doesn't start with `_` is an API
// endpoint. The URL is derived from the directory path, with
// `[id]` → `:id`, `[...slug]` → `*slug`, `(group)` dropped.
//
// Methods are detected by scanning the file for `export GET / POST /
// PUT / PATCH / DELETE / HEAD / OPTIONS` declarations.
//
// Auth is detected via `middleware.ts` at the project root, by checking
// whether `config.matcher` covers the route path.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AuthChainEntry, Endpoint } from "../types/session.js";
import {
	conventionPath,
	detectExportedMethods,
	findMethodExportLine,
	hasExportedMethod,
	makeEndpoint,
} from "./shared.js";

const NEXTJS_ROUTE_FILE = /[/\\]app[/\\](.*?)[/\\]route\.(?:ts|js)$/;

/**
 * Per-call options. `projectRoot` is needed to locate `middleware.ts`;
 * when omitted, the matcher path is skipped (returns endpoints with
 * empty `auth_chain`).
 */
export interface ExtractEndpointsOptions {
	projectRoot?: string;
}

export function extractEndpoints(
	filePath: string,
	content: string,
	opts?: ExtractEndpointsOptions,
): Endpoint[] {
	const match = filePath.match(NEXTJS_ROUTE_FILE);
	if (!match) return [];
	// conventionPath already returns a `/`-prefixed path from the captured
	// directory segments — App Router files under `app/api/...` produce
	// paths like `/api/admin/orgs` directly.
	const fullPath = conventionPath(match[1]);
	const methods = detectExportedMethods(content);
	// detectExportedMethods returns ["ALL"] when no method exports exist;
	// Next.js requires explicit method exports — treat that as "no endpoint".
	if (methods.length === 1 && methods[0] === "ALL" && !hasExportedMethod(content)) {
		return [];
	}
	const matcherEntry = opts?.projectRoot
		? resolveMatcherEntry(opts.projectRoot, fullPath)
		: null;

	const endpoints: Endpoint[] = [];
	for (const method of methods) {
		const line = findMethodExportLine(content, method);
		const endpoint = makeEndpoint({
			framework: "nextjs",
			method,
			path: fullPath,
			file: filePath,
			line,
			handler_symbol: method,
		});
		if (matcherEntry) endpoint.auth_chain = [matcherEntry];
		endpoints.push(endpoint);
	}
	return endpoints;
}

/**
 * Resolve a `matcher` auth-chain entry for `routePath` against the
 * project's `middleware.ts`. Returns `null` if no middleware.ts exists
 * or no matcher entry covers the route. Reads disk once per call.
 */
function resolveMatcherEntry(projectRoot: string, routePath: string): AuthChainEntry | null {
	const middlewarePath = join(projectRoot, "middleware.ts");
	if (!existsSync(middlewarePath)) return null;
	let middlewareContent: string;
	try {
		middlewareContent = readFileSync(middlewarePath, "utf-8");
	} catch {
		return null;
	}
	const matchers = parseMatcherConfig(middlewareContent);
	for (const matcher of matchers) {
		if (matcherCovers(matcher, routePath)) {
			return {
				name: "middleware",
				kind: "matcher",
				file: middlewarePath,
				line: undefined,
			};
		}
	}
	return null;
}

/**
 * Parse `export const config = { matcher: [...] | "..." }` out of a
 * middleware.ts file. Returns the matcher strings; an empty array if
 * the file has no config export.
 */
function parseMatcherConfig(content: string): string[] {
	const re = /matcher\s*:\s*(\[[^\]]+\]|["'`][^"'`]+["'`])/;
	const m = re.exec(content);
	if (!m) return [];
	const raw = m[1];
	const strings: string[] = [];
	const stringRe = /["'`]([^"'`]+)["'`]/g;
	for (let sm = stringRe.exec(raw); sm !== null; sm = stringRe.exec(raw)) {
		strings.push(sm[1]);
	}
	return strings;
}

/**
 * Conservative matcher-vs-path predicate. Next.js matchers support
 * three shapes: exact static, `:id` param, and `:path*` catch-all (or
 * `(.*)`). V1 supports all three via regex translation.
 */
function matcherCovers(matcher: string, routePath: string): boolean {
	// Stepwise translation — handle `/<param>*` first (absorbs the
	// leading slash into an optional group), then bare `<param>*`, then
	// bare params.
	const SLASH_CATCHALL = /\/:[a-zA-Z_][\w]*\*/g;
	const CATCHALL = /:[a-zA-Z_][\w]*\*/g;
	const PARAM = /:[a-zA-Z_][\w]*/g;
	let regex = matcher
		.replace(/\(\.\*\)/g, ".*")
		.replace(SLASH_CATCHALL, "(?:/.*)?")
		.replace(CATCHALL, ".*")
		.replace(PARAM, "[^/]+");
	regex = `^${regex}$`;
	try {
		return new RegExp(regex).test(routePath);
	} catch {
		return false;
	}
}
