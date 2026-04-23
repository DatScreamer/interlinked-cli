// ===========================================
// Route Map — API Route Detection & Context
// ===========================================
// Detects API routes from filesystem conventions (Next.js, SvelteKit, Nuxt)
// and explicit route patterns (Express, Hono, Koa, manual routing, MCP tools).
// Provides contextual warnings when agents edit handler files so they
// understand the downstream impact of their changes.
//
// Design goals:
//   - Zero external dependencies (pure regex-based parsing, no AST library)
//   - Incremental updates (re-scan single file on PostToolUse)
//   - Convention-aware (only detect framework routes if framework markers are present)

import { existsSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import type { RouteInfo } from "./types.js";

// ===========================================
// Framework Detection
// ===========================================

type Framework = "nextjs" | "sveltekit" | "nuxt";

/** Check which file-convention frameworks are present in the project */
function detectFrameworks(projectRoot: string): Set<Framework> {
	const frameworks = new Set<Framework>();

	// Next.js: has next.config.* or app/ directory with route files
	const nextConfigs = ["next.config.js", "next.config.mjs", "next.config.ts"];
	if (
		nextConfigs.some((f) => existsSync(join(projectRoot, f))) ||
		existsSync(join(projectRoot, "app"))
	) {
		frameworks.add("nextjs");
	}

	// SvelteKit: has svelte.config.* or src/routes/
	const svelteConfigs = ["svelte.config.js", "svelte.config.ts"];
	if (
		svelteConfigs.some((f) => existsSync(join(projectRoot, f))) ||
		existsSync(join(projectRoot, "src", "routes"))
	) {
		frameworks.add("sveltekit");
	}

	// Nuxt: has nuxt.config.* or server/api/
	const nuxtConfigs = ["nuxt.config.js", "nuxt.config.ts"];
	if (
		nuxtConfigs.some((f) => existsSync(join(projectRoot, f))) ||
		existsSync(join(projectRoot, "server", "api"))
	) {
		frameworks.add("nuxt");
	}

	return frameworks;
}

// ===========================================
// Convention-based Route Extraction
// ===========================================

const NEXTJS_ROUTE_FILE = /[/\\]app[/\\](.*?)[/\\]route\.(ts|js)$/;
const SVELTEKIT_ROUTE_FILE = /[/\\]src[/\\]routes[/\\](.*?)[/\\]\+server\.(ts|js)$/;
const NUXT_API_FILE = /[/\\]server[/\\]api[/\\](.+)\.(ts|js)$/;

/** HTTP methods exported in Next.js/SvelteKit route files */
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/**
 * Extract route path from a file-convention framework.
 * Converts directory segments to URL path segments.
 * Handles dynamic segments: [id] → :id, [...slug] → *slug
 */
function conventionPath(rawSegments: string): string {
	const parts = rawSegments.split(/[/\\]/);
	const urlParts = parts.map((part) => {
		// Catch-all: [...slug] → *slug
		if (/^\[\.\.\.(\w+)\]$/.test(part)) {
			return `*${part.slice(4, -1)}`;
		}
		// Dynamic: [id] → :id
		if (/^\[(\w+)\]$/.test(part)) {
			return `:${part.slice(1, -1)}`;
		}
		// Route groups: (group) → skip
		if (/^\(.+\)$/.test(part)) {
			return null;
		}
		return part;
	});
	return `/${urlParts.filter(Boolean).join("/")}`;
}

/** Detect HTTP methods exported from a convention route file */
function detectExportedMethods(content: string): string[] {
	const methods: string[] = [];
	for (const method of HTTP_METHODS) {
		// Match: export async function GET, export function GET, export const GET
		const pattern = new RegExp(
			`^\\s*export\\s+(?:async\\s+)?(?:function|const|let)\\s+${method}\\b`,
			"m",
		);
		if (pattern.test(content)) {
			methods.push(method);
		}
	}
	return methods.length > 0 ? methods : ["ALL"];
}

/** Try to extract routes from filesystem conventions */
function extractConventionRoutes(
	filePath: string,
	projectRoot: string,
	frameworks: Set<Framework>,
	content: string,
): RouteInfo[] {
	const _relPath = relative(projectRoot, filePath);
	const routes: RouteInfo[] = [];

	// Next.js: app/**/route.ts
	if (frameworks.has("nextjs")) {
		const match = filePath.match(NEXTJS_ROUTE_FILE);
		if (match) {
			const urlPath = conventionPath(match[1]);
			const methods = detectExportedMethods(content);
			for (const method of methods) {
				routes.push({
					method,
					path: `/api${urlPath === "/" ? "" : urlPath}`,
					handler_file: filePath,
				});
			}
		}
	}

	// SvelteKit: src/routes/**/+server.ts
	if (frameworks.has("sveltekit")) {
		const match = filePath.match(SVELTEKIT_ROUTE_FILE);
		if (match) {
			const urlPath = conventionPath(match[1]);
			const methods = detectExportedMethods(content);
			for (const method of methods) {
				routes.push({ method, path: urlPath, handler_file: filePath });
			}
		}
	}

	// Nuxt: server/api/**/*.ts
	if (frameworks.has("nuxt")) {
		const match = filePath.match(NUXT_API_FILE);
		if (match) {
			// Nuxt strips the extension and uses filename as path
			const segments = match[1].replace(/\.(?:get|post|put|patch|delete)$/, "");
			const urlPath = `/api/${segments.replace(/[/\\]/g, "/").replace(/\[(\w+)\]/g, ":$1")}`;
			// Check for method suffix in filename (e.g., users.get.ts)
			const methodSuffix = match[1].match(/\.(get|post|put|patch|delete)$/i);
			const method = methodSuffix ? methodSuffix[1].toUpperCase() : "ALL";
			routes.push({ method, path: urlPath, handler_file: filePath });
		}
	}

	return routes;
}

// ===========================================
// Explicit Route Pattern Detection (Regex)
// ===========================================

/** Regex patterns for explicit route definitions with line-level detection */
const ROUTE_PATTERNS: {
	pattern: RegExp;
	extract: (match: RegExpMatchArray) => { method: string; path: string };
}[] = [
	// Express/Hono/Koa style: app.get("/path" or router.post("/path"
	{
		pattern:
			/(?:app|router|server|api|hono)\.(get|post|put|patch|delete|all|use)\(\s*["'`]([^"'`]+)["'`]/gi,
		extract: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
	},
	// url.pathname === "/path" or url.pathname.startsWith("/path")
	{
		pattern: /url\.pathname\s*===?\s*["'`]([^"'`]+)["'`]/gi,
		extract: (m) => ({ method: "ALL", path: m[1] }),
	},
	{
		pattern: /url\.pathname\.startsWith\(\s*["'`]([^"'`]+)["'`]\s*\)/gi,
		extract: (m) => ({ method: "ALL", path: m[1] }),
	},
	// MCP tool definitions: server.tool("name"
	{
		pattern: /server\.tool\(\s*["'`]([^"'`]+)["'`]/gi,
		extract: (m) => ({ method: "TOOL", path: m[1] }),
	},
];

/** Scan file content for explicit route patterns */
function extractExplicitRoutes(filePath: string, content: string): RouteInfo[] {
	const routes: RouteInfo[] = [];
	const seen = new Set<string>();
	const _lines = content.split("\n");

	for (const { pattern, extract } of ROUTE_PATTERNS) {
		// Reset lastIndex for global regex
		pattern.lastIndex = 0;

		for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
			const { method, path } = extract(match);
			const key = `${method}:${path}`;
			if (seen.has(key)) continue;
			seen.add(key);

			// Find line number by counting newlines before match position
			const before = content.slice(0, match.index);
			const line = before.split("\n").length;

			routes.push({ method, path, handler_file: filePath, line });
		}
	}

	return routes;
}

// ===========================================
// RouteMap Class
// ===========================================

export class RouteMap {
	/** file path → routes defined in that file */
	private routes: Map<string, RouteInfo[]> = new Map();
	private projectRoot: string;
	private frameworks: Set<Framework>;

	constructor(projectRoot: string) {
		this.projectRoot = resolve(projectRoot);
		this.frameworks = detectFrameworks(this.projectRoot);
	}

	/**
	 * Scan project files to detect convention-based and explicit routes.
	 * Call once on startup with the list of indexed files.
	 */
	initialize(files: string[]): void {
		for (const file of files) {
			this.scanFile(file);
		}
	}

	/**
	 * Re-scan a single file after edit (called on PostToolUse).
	 * Clears old routes for the file and re-detects.
	 */
	updateFile(filePath: string, content?: string): void {
		const absPath = this.toAbsolute(filePath);
		this.routes.delete(absPath);
		this.scanFile(absPath, content);
	}

	/** Get routes handled by a given file */
	getRoutesForFile(filePath: string): RouteInfo[] {
		return this.routes.get(this.toAbsolute(filePath)) || [];
	}

	/**
	 * Generate context string for PreToolUse injection.
	 * Returns null when the file has no detected routes.
	 */
	getRouteContext(filePath: string): string | null {
		const fileRoutes = this.getRoutesForFile(filePath);
		if (fileRoutes.length === 0) return null;

		const descriptions = fileRoutes.map((r) => {
			if (r.method === "TOOL") return `TOOL ${r.path}`;
			if (r.method === "ALL") return r.path;
			return `${r.method} ${r.path}`;
		});

		const unique = [...new Set(descriptions)];
		return `This file handles: ${unique.join(", ")}. Changes may affect API consumers.`;
	}

	// --- Internal ---

	private toAbsolute(filePath: string): string {
		return filePath.startsWith(sep) || filePath.match(/^[A-Z]:\\/i)
			? filePath
			: resolve(this.projectRoot, filePath);
	}

	private scanFile(filePath: string, content?: string): void {
		const absPath = this.toAbsolute(filePath);
		const ext = extname(absPath);

		// Only scan TS/JS files
		if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) {
			return;
		}

		let fileContent: string;
		if (content) {
			fileContent = content;
		} else {
			try {
				fileContent = readFileSync(absPath, "utf-8");
			} catch {
				return; // File not readable
			}
		}

		const fileRoutes: RouteInfo[] = [];

		// Convention-based detection
		const conventionRoutes = extractConventionRoutes(
			absPath,
			this.projectRoot,
			this.frameworks,
			fileContent,
		);
		fileRoutes.push(...conventionRoutes);

		// Explicit pattern detection
		const explicitRoutes = extractExplicitRoutes(absPath, fileContent);
		fileRoutes.push(...explicitRoutes);

		if (fileRoutes.length > 0) {
			this.routes.set(absPath, fileRoutes);
		}
	}
}
