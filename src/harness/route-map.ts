// ===========================================
// Route Map — API Route Detection & Context (Phase A3 dispatcher)
// ===========================================
// Thin dispatcher that delegates per-framework extraction to the
// adapter modules in `route-map/`. Each adapter exports
// `extractEndpoints(filePath, content): Endpoint[]` (with Next.js
// taking an extra `{ projectRoot }` option for matcher resolution).
//
// Design:
//   - Detect which frameworks are present in the project (cheap fs
//     check on startup) and only call those adapters' file-convention
//     paths for matching files.
//   - Always call the explicit-call adapters (Express / Hono / MCP)
//     because their patterns can appear in any TS/JS file regardless
//     of project shape.
//
// Public surface (consumers: server.ts, structural-checks.ts):
//   - `extractAllEndpoints(): Endpoint[]`   — bulk, every file initialized
//   - `extractEndpointsForFile(filePath): Endpoint[]` — incremental
//   - `getRouteContext(filePath): string | null` — formatted PostToolUse
//     context string (back-compat with structural-checks.ts)
//   - `getRoutesForFile(filePath): RouteInfo[]` — back-compat projection
//     from `Endpoint`; left as a thin shim for the lone existing consumer.

import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

import * as expressAdapter from "./route-map/express.js";
import * as fastapiAdapter from "./route-map/fastapi.js";
import * as honoAdapter from "./route-map/hono.js";
import * as mcpAdapter from "./route-map/mcp.js";
import * as nextjsAdapter from "./route-map/nextjs.js";
import * as nuxtAdapter from "./route-map/nuxt.js";
import * as sveltekitAdapter from "./route-map/sveltekit.js";
import type { Endpoint, RouteInfo } from "./types/session.js";

// ===========================================
// Framework Detection
// ===========================================

type ConventionFramework = "nextjs" | "sveltekit" | "nuxt";

function detectFrameworks(projectRoot: string): Set<ConventionFramework> {
	const frameworks = new Set<ConventionFramework>();
	const nextConfigs = ["next.config.js", "next.config.mjs", "next.config.ts"];
	if (
		nextConfigs.some((f) => existsSync(join(projectRoot, f))) ||
		existsSync(join(projectRoot, "app"))
	) {
		frameworks.add("nextjs");
	}
	const svelteConfigs = ["svelte.config.js", "svelte.config.ts"];
	if (
		svelteConfigs.some((f) => existsSync(join(projectRoot, f))) ||
		existsSync(join(projectRoot, "src", "routes"))
	) {
		frameworks.add("sveltekit");
	}
	const nuxtConfigs = ["nuxt.config.js", "nuxt.config.ts"];
	if (
		nuxtConfigs.some((f) => existsSync(join(projectRoot, f))) ||
		existsSync(join(projectRoot, "server", "api"))
	) {
		frameworks.add("nuxt");
	}
	return frameworks;
}

/** Extensions extractors are willing to scan. */
const TS_JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const PYTHON_EXT = new Set([".py"]);

// ===========================================
// RouteMap Class
// ===========================================

export class RouteMap {
	/** absolute file path → endpoints defined in that file */
	private endpoints: Map<string, Endpoint[]> = new Map();
	private projectRoot: string;
	private frameworks: Set<ConventionFramework>;

	constructor(projectRoot: string) {
		this.projectRoot = resolve(projectRoot);
		this.frameworks = detectFrameworks(this.projectRoot);
	}

	/**
	 * Scan project files to detect convention-based and explicit
	 * endpoints. Call once on startup with the list of indexed files.
	 */
	initialize(files: string[]): void {
		for (const file of files) {
			this.scanFile(file);
		}
	}

	/**
	 * Re-scan a single file after edit (called on PostToolUse). Clears
	 * old endpoints for the file and re-detects.
	 */
	updateFile(filePath: string, content?: string): void {
		const absPath = this.toAbsolute(filePath);
		this.endpoints.delete(absPath);
		this.scanFile(absPath, content);
	}

	/** All endpoints across every initialized file. */
	extractAllEndpoints(): Endpoint[] {
		const out: Endpoint[] = [];
		for (const list of this.endpoints.values()) {
			for (const ep of list) out.push(ep);
		}
		return out;
	}

	/**
	 * Endpoints for a single file (incremental). Re-scans on the fly if
	 * the file was edited since the last scan and `content` is provided.
	 */
	extractEndpointsForFile(filePath: string, content?: string): Endpoint[] {
		const absPath = this.toAbsolute(filePath);
		if (content !== undefined) {
			this.endpoints.delete(absPath);
			this.scanFile(absPath, content);
		}
		return this.endpoints.get(absPath) ?? [];
	}

	/**
	 * @deprecated Back-compat projection from {@link Endpoint}. The lone
	 * existing consumer is `structural-checks.ts` via `getRouteContext`;
	 * external callers should use `extractEndpointsForFile`.
	 */
	getRoutesForFile(filePath: string): RouteInfo[] {
		const endpoints = this.endpoints.get(this.toAbsolute(filePath)) ?? [];
		return endpoints.map((e) => ({
			method: e.method,
			path: e.path,
			handler_file: e.file,
			line: e.line,
		}));
	}

	/**
	 * Generate the human-readable PostToolUse context line for a file.
	 * Reads from the richer {@link Endpoint} shape but the return type
	 * remains `string | null` to stay back-compat with structural-checks.
	 */
	getRouteContext(filePath: string): string | null {
		const fileEndpoints = this.endpoints.get(this.toAbsolute(filePath)) ?? [];
		if (fileEndpoints.length === 0) return null;
		const descriptions = fileEndpoints.map((e) => {
			if (e.method === "TOOL") return `TOOL ${e.path}`;
			if (e.method === "ALL") return e.path;
			return `${e.method} ${e.path}`;
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

	/**
	 * Decide which adapter(s) apply to this file and merge their output.
	 * The order is: convention adapters first (Next.js / SvelteKit / Nuxt),
	 * then explicit-call adapters (Express / Hono / MCP), then FastAPI.
	 * Each adapter returns `[]` for files that don't fit its conventions.
	 */
	private scanFile(filePath: string, content?: string): void {
		const absPath = this.toAbsolute(filePath);
		const ext = extname(absPath);

		const isTsJs = TS_JS_EXT.has(ext);
		const isPython = PYTHON_EXT.has(ext);
		if (!isTsJs && !isPython) return;

		let fileContent: string;
		if (content !== undefined) {
			fileContent = content;
		} else {
			try {
				fileContent = readFileSync(absPath, "utf-8");
			} catch {
				return;
			}
		}

		const endpoints: Endpoint[] = [];

		if (isTsJs) {
			if (this.frameworks.has("nextjs")) {
				endpoints.push(
					...nextjsAdapter.extractEndpoints(absPath, fileContent, {
						projectRoot: this.projectRoot,
					}),
				);
			}
			if (this.frameworks.has("sveltekit")) {
				endpoints.push(...sveltekitAdapter.extractEndpoints(absPath, fileContent));
			}
			if (this.frameworks.has("nuxt")) {
				endpoints.push(...nuxtAdapter.extractEndpoints(absPath, fileContent));
			}
			endpoints.push(...expressAdapter.extractEndpoints(absPath, fileContent));
			endpoints.push(...honoAdapter.extractEndpoints(absPath, fileContent));
			endpoints.push(...mcpAdapter.extractEndpoints(absPath, fileContent));
		}
		if (isPython) {
			endpoints.push(...fastapiAdapter.extractEndpoints(absPath, fileContent));
		}

		// Dedupe — adapter overlap (Express + Hono share most of the
		// call-site regex) can double-count the same route.
		const deduped = dedupeEndpoints(endpoints);
		if (deduped.length > 0) {
			this.endpoints.set(absPath, deduped);
		}
	}
}

function dedupeEndpoints(endpoints: Endpoint[]): Endpoint[] {
	const seen = new Set<string>();
	const out: Endpoint[] = [];
	for (const e of endpoints) {
		// Hono and Express produce structurally identical results on the
		// same file — prefer the first occurrence. The key intentionally
		// ignores `framework` so identical method+path on the same line
		// from two adapters collapses to one entry.
		const key = `${e.method}:${e.path}:${e.line ?? 0}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(e);
	}
	return out;
}
