// ===========================================
// Viz Server — loopback dashboard host
// ===========================================
// A decoupled, read-only HTTP server (zero deps, node:http only) that serves
// the baseline-test dashboard and streams live activity to it. Binds 127.0.0.1
// ONLY — the dashboard surfaces unscrubbed tool I/O, so it must never leave the
// loopback interface.
//
// It builds its OWN ProjectGraph from the working tree and tails the existing
// activity.jsonl for live events — the harness daemon is not required and is
// never touched, so `interlinked viz` works offline.

import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectGraph } from "../../harness/project-graph.js";
import {
	type CheckEvent,
	createActivityTailer,
	createChecksTailer,
	formatSse,
	seedRecentChecks,
	seedRecentEvents,
	type VizEvent,
} from "./event-stream.js";
import { buildGraphSnapshot, type VizGraphSnapshot } from "./graph-snapshot.js";

/** Default loopback port for the viz dashboard. Public API. */
export const DEFAULT_VIZ_PORT = 6403;

const ROUTE = {
	ROOT: "/",
	INDEX: "/index.html",
	GRAPH: "/api/graph",
	HEALTH: "/api/health",
	STREAM: "/api/stream",
	CHECKS: "/api/checks",
} as const;

const HTTP = { OK: 200, NOT_FOUND: 404, SERVER_ERROR: 500 } as const;
const SEED_EVENTS = 40;

export interface VizServerOptions {
	root: string;
	port?: number;
	host?: string;
	/** Override the dashboard asset directory (dev/test). */
	webRoot?: string;
	/** Activity log to tail for live events (default: cwd/.interlinked/activity.jsonl). */
	activityPath?: string;
	/** Check-results log to tail for gate decisions (default: cwd/.interlinked/check-results.jsonl). */
	checkResultsPath?: string;
	/** Tailer poll interval in ms (default 1000). */
	pollMs?: number;
}

export interface VizServerHandle {
	url: string;
	port: number;
	close: () => Promise<void>;
}

interface SseClient {
	res: ServerResponse;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
};

/** Map a filename to a Content-Type, defaulting to octet-stream. */
export function contentTypeFor(name: string): string {
	const dot = name.lastIndexOf(".");
	const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
	return MIME[ext] ?? "application/octet-stream";
}

/**
 * Resolve a web asset across the dev tree and the bundled `dist/` layout.
 * In dev (tsx) this file is `src/lib/viz/server.ts` → `./web/<name>`; in the
 * published build it is bundled into `dist/index.js` and the asset is copied
 * to `dist/viz/<name>` (see scripts/copy-runtime-assets.mjs).
 */
export function resolveVizAsset(name: string): string | null {
	const candidates = [
		fileURLToPath(new URL(`./web/${name}`, import.meta.url)),
		fileURLToPath(new URL(`./viz/${name}`, import.meta.url)),
		join(process.cwd(), "src/lib/viz/web", name),
		join(process.cwd(), "dist/viz", name),
	];
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return null;
}

/** Read the dashboard HTML once at startup (startup sync I/O is fine; per-request is not). */
function loadDashboardHtml(webRoot: string | undefined): Buffer | null {
	const file = webRoot ? join(webRoot, "index.html") : resolveVizAsset("index.html");
	return file && existsSync(file) ? readFileSync(file) : null;
}

/** Start the loopback dashboard server. Resolves once it is listening. */
export async function startVizServer(opts: VizServerOptions): Promise<VizServerHandle> {
	const host = opts.host ?? "127.0.0.1";
	const rootLabel = basename(opts.root.replace(/[/\\]+$/, "")) || opts.root;
	const activityPath = opts.activityPath ?? join(process.cwd(), ".interlinked", "activity.jsonl");
	const checkResultsPath = opts.checkResultsPath ?? join(process.cwd(), ".interlinked", "check-results.jsonl");
	const sseClients = new Set<SseClient>();
	const checkClients = new Set<SseClient>();
	let snapshot: VizGraphSnapshot | null = null;

	const getSnapshot = (): VizGraphSnapshot => {
		if (!snapshot) {
			const graph = new ProjectGraph(opts.root);
			graph.initialize();
			snapshot = buildGraphSnapshot(graph, rootLabel);
		}
		return snapshot;
	};

	const broadcast = (ev: VizEvent): void => {
		const data = formatSse(ev);
		for (const client of sseClients) {
			if (!client.res.writableEnded) client.res.write(data);
		}
	};
	const broadcastCheck = (ev: CheckEvent): void => {
		const data = formatSse(ev);
		for (const client of checkClients) {
			if (!client.res.writableEnded) client.res.write(data);
		}
	};
	const pollMs = opts.pollMs ?? 1000;
	const tailer = createActivityTailer(activityPath, broadcast, pollMs);
	const checksTailer = createChecksTailer(checkResultsPath, broadcastCheck, pollMs);

	const dashHtml = loadDashboardHtml(opts.webRoot);
	const server = createServer((req, res) =>
		handleRequest(req, res, { getSnapshot, sseClients, checkClients, dashHtml, activityPath, checkResultsPath }),
	);
	await new Promise<void>((resolve) => server.listen(opts.port ?? DEFAULT_VIZ_PORT, host, resolve));

	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? DEFAULT_VIZ_PORT);

	const close = (): Promise<void> => {
		tailer.stop();
		checksTailer.stop();
		for (const client of [...sseClients]) {
			if (!client.res.writableEnded) client.res.end();
		}
		for (const client of [...checkClients]) {
			if (!client.res.writableEnded) client.res.end();
		}
		sseClients.clear();
		checkClients.clear();
		return new Promise<void>((resolve) => server.close(() => resolve()));
	};

	return { url: `http://${host}:${port}`, port, close };
}

interface RequestContext {
	getSnapshot: () => VizGraphSnapshot;
	sseClients: Set<SseClient>;
	checkClients: Set<SseClient>;
	dashHtml: Buffer | null;
	activityPath: string;
	checkResultsPath: string;
}

function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): void {
	const path = (req.url ?? ROUTE.ROOT).split("?")[0] ?? ROUTE.ROOT;
	if (path === ROUTE.ROOT || path === ROUTE.INDEX) {
		serveDashboard(res, ctx.dashHtml);
		return;
	}
	if (path === ROUTE.GRAPH) {
		sendJson(res, ctx.getSnapshot());
		return;
	}
	if (path === ROUTE.HEALTH) {
		const s = ctx.getSnapshot();
		sendJson(res, { ok: true, root: s.root, node_count: s.node_count, edge_count: s.edge_count });
		return;
	}
	if (path === ROUTE.STREAM) {
		openStream(req, res, ctx.sseClients, ctx.activityPath);
		return;
	}
	if (path === ROUTE.CHECKS) {
		openChecksStream(req, res, ctx.checkClients, ctx.checkResultsPath);
		return;
	}
	sendStatus(res, HTTP.NOT_FOUND, "not found");
}

function sendJson(res: ServerResponse, body: unknown): void {
	res.writeHead(HTTP.OK, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(JSON.stringify(body));
}

function sendStatus(res: ServerResponse, code: number, message: string): void {
	res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
	res.end(message);
}

function serveDashboard(res: ServerResponse, html: Buffer | null): void {
	if (!html) {
		sendStatus(res, HTTP.SERVER_ERROR, "dashboard asset missing");
		return;
	}
	res.writeHead(HTTP.OK, { "Content-Type": contentTypeFor("index.html"), "Cache-Control": "no-store" });
	res.end(html);
}

/** Write the SSE response head + hello comment shared by both live streams. */
function openSseHead(res: ServerResponse, hello: string): void {
	res.writeHead(HTTP.OK, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	res.write(`: ${hello}\n\n`);
}

/**
 * Open a Server-Sent-Events connection: send the recent backlog as seed, then
 * register the client so the shared activity tailer broadcasts new events to it.
 */
function openStream(
	req: IncomingMessage,
	res: ServerResponse,
	sseClients: Set<SseClient>,
	activityPath: string,
): void {
	openSseHead(res, "interlinked baseline stream");
	for (const ev of seedRecentEvents(activityPath, SEED_EVENTS)) res.write(formatSse(ev));
	const client: SseClient = { res };
	sseClients.add(client);
	req.on("close", () => {
		sseClients.delete(client);
	});
}

/**
 * Open a Server-Sent-Events connection for gate decisions: seed the recent
 * check-results backlog, then register the client so the shared checks tailer
 * broadcasts new rows to it. Mirrors `openStream`.
 */
function openChecksStream(
	req: IncomingMessage,
	res: ServerResponse,
	checkClients: Set<SseClient>,
	checkResultsPath: string,
): void {
	openSseHead(res, "interlinked checks stream");
	for (const ev of seedRecentChecks(checkResultsPath, SEED_EVENTS)) res.write(formatSse(ev));
	const client: SseClient = { res };
	checkClients.add(client);
	req.on("close", () => {
		checkClients.delete(client);
	});
}
