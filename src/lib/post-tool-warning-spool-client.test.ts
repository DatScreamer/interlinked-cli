import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acknowledgeSynchronousPostToolResult,
	drainLatePostToolWarnings,
	QUALITY_WARNING_SPOOL_DIR,
} from "./post-tool-warning-spool-client.js";

let dataDir = "";
let spoolDir = "";

function readyRecord(
	token: string,
	sessionId: string,
	warnings: string[],
	producedAt: string,
): string {
	return JSON.stringify({
		version: 1,
		token,
		session_id: sessionId,
		produced_at: producedAt,
		warnings,
	});
}

function writeReady(
	token: string,
	sessionId: string,
	warnings: string[],
	producedAt: string,
): string {
	const path = join(spoolDir, `${token}.ready.json`);
	writeFileSync(path, readyRecord(token, sessionId, warnings, producedAt));
	return path;
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "interlinked-warning-client-"));
	spoolDir = join(dataDir, QUALITY_WARNING_SPOOL_DIR);
	mkdirSync(spoolDir);
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

describe("acknowledgeSynchronousPostToolResult", () => {
	it("removes only its request-owned ready record and deduplicates a rolling-upgrade legacy copy", () => {
		const token = "request-token-0001";
		const own = writeReady(
			token,
			"session-a",
			["direct warning"],
			new Date().toISOString(),
		);
		const foreign = writeReady(
			"request-token-0002",
			"session-b",
			["foreign warning"],
			new Date(Date.now() - 1_000).toISOString(),
		);
		const legacy = join(dataDir, "pending-quality-warnings.json");
		writeFileSync(legacy, JSON.stringify(["direct warning", "legacy warning"]));

		expect(acknowledgeSynchronousPostToolResult(dataDir, token, ["direct warning"])).toEqual([
			"direct warning",
		]);
		expect(existsSync(own)).toBe(false);
		expect(existsSync(foreign)).toBe(true);
		expect(existsSync(legacy)).toBe(false);
	});
});

describe("drainLatePostToolWarnings", () => {
	it("defers young same-session work, then claims that session exactly once while retaining foreign work", () => {
		const now = Date.now();
		const eligible = writeReady(
			"eligible-token-001",
			"session-a",
			["late warning"],
			new Date(now - 1_000).toISOString(),
		);
		const foreign = writeReady(
			"foreign-token-0001",
			"session-b",
			["foreign warning"],
			new Date(now - 1_000).toISOString(),
		);
		const young = writeReady(
			"young-token-000001",
			"session-a",
			["young warning"],
			new Date(now - 50).toISOString(),
		);

		expect(drainLatePostToolWarnings(dataDir, "session-a", now)).toEqual([]);
		expect(existsSync(eligible)).toBe(true);
		expect(existsSync(young)).toBe(true);
		expect(drainLatePostToolWarnings(dataDir, "session-a", now + 1_000)).toEqual([
			"late warning",
			"young warning",
		]);
		expect(drainLatePostToolWarnings(dataDir, "session-a", now + 1_000)).toEqual([]);
		expect(existsSync(eligible)).toBe(false);
		expect(existsSync(foreign)).toBe(true);
		expect(existsSync(young)).toBe(false);
	});

	it("silently discards stale and malformed records without replaying them as clean output", () => {
		const stale = writeReady(
			"stale-token-00001",
			"session-a",
			["stale warning"],
			"2020-01-01T00:00:00.000Z",
		);
		const malformed = join(spoolDir, "malformed-token-01.ready.json");
		writeFileSync(malformed, "not-json");
		const malformedActive = join(spoolDir, "malformed-token-01.active.json");
		writeFileSync(
			malformedActive,
			JSON.stringify({
				version: 1,
				token: "malformed-token-01",
				session_id: "session-a",
				started_at: "2020-01-01T00:00:00.000Z",
				client_pid: 999_999,
			}),
		);
		const staleActive = join(spoolDir, "stale-token-00001.active.json");
		writeFileSync(
			staleActive,
			JSON.stringify({
				version: 1,
				token: "stale-token-00001",
				session_id: "session-a",
				started_at: "2020-01-01T00:00:00.000Z",
				// A reused live PID must not pin a day-old record forever.
				client_pid: process.pid,
			}),
		);

		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual([]);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(staleActive)).toBe(false);
		expect(existsSync(malformed)).toBe(false);
		expect(existsSync(malformedActive)).toBe(false);
		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual([]);
	});

	it("defers both modern and legacy delivery while the same request is still active", () => {
		const token = "active-token-00001";
		const active = join(spoolDir, `${token}.active.json`);
		writeFileSync(
			active,
			JSON.stringify({
				version: 1,
				token,
				session_id: "session-a",
				started_at: new Date().toISOString(),
				client_pid: process.pid,
			}),
		);
		const ready = writeReady(
			token,
			"session-a",
			["same warning"],
			new Date(Date.now() - 1_000).toISOString(),
		);
		const legacy = join(dataDir, "pending-quality-warnings.json");
		writeFileSync(legacy, JSON.stringify(["unscoped foreign warning"]));

		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual([]);
		expect(existsSync(active)).toBe(true);
		expect(existsSync(ready)).toBe(true);
		expect(existsSync(legacy)).toBe(true);

		unlinkSync(active);
		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual(["same warning"]);
		expect(existsSync(legacy)).toBe(false);
		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual([]);
	});

	it("does not create a drain lock or output when there is no pending work", () => {
		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual([]);
		expect(existsSync(join(spoolDir, ".drain.lock"))).toBe(false);
	});

	it("sweeps an abandoned active-only marker but preserves a live one", () => {
		const now = Date.now();
		const abandoned = join(spoolDir, "abandoned-token01.active.json");
		writeFileSync(
			abandoned,
			JSON.stringify({
				version: 1,
				token: "abandoned-token01",
				session_id: "session-a",
				started_at: new Date(now - 1_000).toISOString(),
				client_pid: 999_999,
			}),
		);
		const live = join(spoolDir, "live-token-000001.active.json");
		writeFileSync(
			live,
			JSON.stringify({
				version: 1,
				token: "live-token-000001",
				session_id: "session-b",
				started_at: new Date(now - 1_000).toISOString(),
				client_pid: process.pid,
			}),
		);

		expect(drainLatePostToolWarnings(dataDir, "session-a", now)).toEqual([]);
		expect(existsSync(abandoned)).toBe(false);
		expect(existsSync(live)).toBe(true);
	});

	it("sweeps a malformed active-only marker after the compatibility grace period", () => {
		const malformed = join(spoolDir, "malformed-active1.active.json");
		writeFileSync(malformed, "not-json");

		expect(drainLatePostToolWarnings(dataDir, "session-a", Date.now() + 1_000)).toEqual([]);
		expect(existsSync(malformed)).toBe(false);
	});
});
