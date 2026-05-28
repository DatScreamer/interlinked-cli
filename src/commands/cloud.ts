// ===========================================
// interlinked cloud — inspect the cloud governor
// ===========================================
// Subcommands:
//   recent   — GET /admin/recent from the configured cloud governor and
//              render the most recent events + verdicts.
//
// Reads `cloud_governor.{url,bearer_token}` from
// `.interlinked/config.local.json` (the same block the daemon's
// cloud-forward path uses). This is the admin-side window into the
// Supervisor DO's events table — see docs/design/cloud-governor-architecture.md
// §4 (admin vs end-user POVs).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { c, relativeTime, table } from "../lib/formatter.js";

export interface CloudCliConfig {
	url: string;
	bearer_token: string;
}

/** Read the cloud_governor block from config.local.json. Returns null when the
 *  file is missing, unparseable, or the block lacks url/bearer_token — callers
 *  print a setup hint in that case. */
export function loadCloudConfigForCli(cwd: string): CloudCliConfig | null {
	try {
		const path = join(cwd, ".interlinked", "config.local.json");
		if (!existsSync(path)) return null;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { cloud_governor?: unknown };
		const cg = parsed.cloud_governor;
		if (!cg || typeof cg !== "object") return null;
		const candidate = cg as { url?: unknown; bearer_token?: unknown };
		if (typeof candidate.url !== "string" || typeof candidate.bearer_token !== "string") {
			return null;
		}
		return { url: candidate.url, bearer_token: candidate.bearer_token };
	} catch {
		return null;
	}
}

/** Resolve the /admin/recent URL from the configured evaluate URL. Uses URL
 *  resolution against the origin so any path/query on the source is discarded
 *  (the evaluate URL ends in /governor/evaluate; we want /admin/recent on the
 *  same origin). */
export function deriveAdminUrl(evaluateUrl: string, limit: number): string {
	const u = new URL("/admin/recent", evaluateUrl);
	u.searchParams.set("limit", String(limit));
	return u.toString();
}

export interface RecentEvent {
	id?: number;
	session_id?: string;
	hook_event?: string;
	tool_name?: string;
	decision?: string;
	rule_id?: string | null;
	created_at?: number;
}

function shortSession(s: string | undefined): string {
	if (!s) return "?";
	return s.length > 8 ? s.slice(0, 8) : s;
}

function decorateDecision(d: string | undefined): string {
	if (d === "block") return c.red("block");
	if (d === "allow") return c.green("allow");
	return d ?? "?";
}

/** Render recent events as a table. Pure — no I/O — so it's unit-testable. */
export function formatRecentEvents(events: RecentEvent[]): string {
	if (events.length === 0) return c.dim("  (no events recorded yet)");
	const rows = events.map((e) => [
		String(e.id ?? "?"),
		e.created_at ? relativeTime(new Date(e.created_at).toISOString()) : "?",
		shortSession(e.session_id),
		e.tool_name ?? "?",
		decorateDecision(e.decision),
		e.rule_id ?? c.dim("—"),
	]);
	return table(["id", "when", "session", "tool", "decision", "rule"], rows);
}

interface RecentResponse {
	events?: RecentEvent[];
	count?: number;
	workspace_id?: string;
}

const FETCH_TIMEOUT_MS = 10_000;
const EXIT_MISCONFIGURED = 2;
const EXIT_UNREACHABLE = 1;

export interface CloudRecentOpts {
	cwd: string;
	limit: number;
	json?: boolean;
}

export async function cloudRecentCommand(opts: CloudRecentOpts): Promise<void> {
	const config = loadCloudConfigForCli(opts.cwd);
	if (!config) {
		process.stderr.write(
			"error: no cloud_governor block in .interlinked/config.local.json.\n" +
				'Add { "cloud_governor": { "url": "...", "bearer_token": "..." } } to use this command.\n',
		);
		process.exit(EXIT_MISCONFIGURED);
	}

	const adminUrl = deriveAdminUrl(config.url, opts.limit);
	const body = await fetchRecent(adminUrl, config.bearer_token);

	if (opts.json) {
		process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
		return;
	}

	const events = body.events ?? [];
	process.stdout.write(
		`${c.bold("Cloud governor — recent events")} ${c.dim(
			`(workspace: ${body.workspace_id ?? "?"}, ${events.length} shown)`,
		)}\n\n`,
	);
	process.stdout.write(`${formatRecentEvents(events)}\n`);
}

async function fetchRecent(adminUrl: string, bearerToken: string): Promise<RecentResponse> {
	let res: Response;
	try {
		res = await fetch(adminUrl, {
			headers: { authorization: `Bearer ${bearerToken}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		process.stderr.write(
			`error: could not reach cloud governor at ${adminUrl}: ${
				err instanceof Error ? err.message : String(err)
			}\n`,
		);
		process.exit(EXIT_UNREACHABLE);
	}
	if (!res.ok) {
		const detail = res.status === 401 ? " (check bearer_token)" : "";
		process.stderr.write(`error: cloud governor returned ${res.status} ${res.statusText}${detail}\n`);
		process.exit(EXIT_UNREACHABLE);
	}
	return (await res.json()) as RecentResponse;
}
