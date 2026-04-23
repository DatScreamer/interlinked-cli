// ===========================================
// Update Notifier — check npm registry for newer interlinked-cli releases
// ===========================================
// Background fetch of https://registry.npmjs.org/interlinked-cli/latest,
// cached in ~/.cache/interlinked-cli/update-check.json with a 24-hour TTL.
// The CURRENT invocation reads the cache (fast, offline-safe) and prints
// a one-line notice to stderr if a newer version is available. A fresh
// fetch is kicked off fire-and-forget so the NEXT invocation sees the
// latest state.
//
// Privacy: the only network call is a GET to the public npm registry —
// the same request `npm view interlinked-cli version` would make. No
// identifying data is sent; the User-Agent is npm's default.
//
// Opt-out: set INTERLINKED_NO_UPDATE_CHECK=1, or run in a non-TTY / CI
// environment (auto-detected).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { JsonObject } from "./json-types.js";

const REGISTRY_URL = "https://registry.npmjs.org/interlinked-cli/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

interface UpdateCache {
	lastCheckAt: number;
	latestVersion: string | null;
}

function getCachePath(): string {
	return join(homedir(), ".cache", "interlinked-cli", "update-check.json");
}

function readCache(): UpdateCache | null {
	try {
		const path = getCachePath();
		if (!existsSync(path)) return null;
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const obj = parsed as JsonObject;
		const lastCheckAt = typeof obj.lastCheckAt === "number" ? obj.lastCheckAt : 0;
		const latestVersion =
			typeof obj.latestVersion === "string" ? obj.latestVersion : null;
		return { lastCheckAt, latestVersion };
	} catch {
		return null;
	}
}

function writeCache(cache: UpdateCache): void {
	try {
		const path = getCachePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
	} catch {
		/* ignore — update check is best-effort */
	}
}

/**
 * Skip-all predicate. Returns true in any environment where printing an
 * update notice would be noisy or inappropriate: CI runs, non-TTY stderr,
 * explicit opt-out, and vitest test runs.
 */
export function isUpdateCheckDisabled(): boolean {
	if (process.env.INTERLINKED_NO_UPDATE_CHECK === "1") return true;
	if (process.env.CI === "true") return true;
	if (process.env.NODE_ENV === "test") return true;
	if (process.env.VITEST === "true") return true;
	if (!process.stderr.isTTY) return true;
	return false;
}

/**
 * Compare two dotted-numeric version strings. Returns true if `latest` is
 * strictly newer than `current`. Deliberately narrow: it accepts
 * `1.2.3` / `1.2.3-beta.1` but ignores anything after a `-` (pre-release
 * identifiers). A pre-release is never reported as "newer than" stable.
 */
export function isNewer(latest: string, current: string): boolean {
	const norm = (s: string): number[] => {
		const base = s.split("-")[0];
		return base.split(".").map((p) => {
			const n = Number.parseInt(p, 10);
			return Number.isFinite(n) ? n : 0;
		});
	};
	const L = norm(latest);
	const C = norm(current);
	const len = Math.max(L.length, C.length);
	for (let i = 0; i < len; i++) {
		const a = L[i] ?? 0;
		const b = C[i] ?? 0;
		if (a > b) return true;
		if (a < b) return false;
	}
	return false;
}

/**
 * Hit the npm registry for the current "latest" dist-tag version. Returns
 * null on any failure — DNS, offline, timeout, 4xx/5xx, malformed JSON.
 * Never throws. Internal to this module — exposed only for the background
 * refresh in maybeRefreshUpdateCache().
 */
async function fetchLatestVersion(): Promise<string | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(REGISTRY_URL, { signal: controller.signal });
		if (!res.ok) return null;
		const body = (await res.json()) as unknown;
		if (!body || typeof body !== "object") return null;
		const version = (body as JsonObject).version;
		return typeof version === "string" ? version : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Returns an ANSI-free, trailing-newline-terminated notice if a newer
 * version is cached, or null if there's no notice to print. Always fast
 * (synchronous cache read).
 */
export function getCachedUpdateNotice(currentVersion: string): string | null {
	if (isUpdateCheckDisabled()) return null;
	const cache = readCache();
	if (!cache?.latestVersion) return null;
	if (!isNewer(cache.latestVersion, currentVersion)) return null;
	return (
		`\n  Update available: ${cache.latestVersion} (current: ${currentVersion})\n` +
		"  Run `npm i -g interlinked-cli` to update.\n" +
		"  Silence with INTERLINKED_NO_UPDATE_CHECK=1.\n\n"
	);
}

/**
 * If the cache is stale (or missing), kick off a background registry fetch
 * and update the cache. Returns immediately; never blocks the CLI. The
 * fetch's own timeout (FETCH_TIMEOUT_MS) caps the longest the background
 * task can run.
 */
export function maybeRefreshUpdateCache(): void {
	if (isUpdateCheckDisabled()) return;
	const cache = readCache();
	const stale = !cache || Date.now() - cache.lastCheckAt > CHECK_INTERVAL_MS;
	if (!stale) return;
	// Fire-and-forget. Errors are swallowed inside fetchLatestVersion.
	void fetchLatestVersion().then((latestVersion) => {
		writeCache({ lastCheckAt: Date.now(), latestVersion });
	});
}
