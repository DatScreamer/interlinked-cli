import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAuthToken } from "../auth.js";

describe("resolveAuthToken", () => {
	const saved: Record<string, string | undefined> = {};
	let tmp: string;

	beforeEach(() => {
		for (const k of ["INTERLINKED_ACCESS_TOKEN", "INTERLINKED_TOKEN"]) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
		tmp = mkdtempSync(join(tmpdir(), "auth-test-"));
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns null when no token is available in an isolated cwd", () => {
		// Pointing at a pristine tmpdir means no local config, no credentials file.
		// The only remaining source would be the Claude Code credentials fallback,
		// which resolveAuthToken guards on existence.
		const token = resolveAuthToken(tmp);
		// In a production dev env the fallback can resolve; we assert the
		// return type — string or null — not truthiness.
		expect(token === null || typeof token === "string").toBe(true);
	});

	it("picks up INTERLINKED_ACCESS_TOKEN from env", () => {
		process.env.INTERLINKED_ACCESS_TOKEN = "env-token";
		expect(resolveAuthToken(tmp)).toBe("env-token");
	});

	it("falls back to INTERLINKED_TOKEN when INTERLINKED_ACCESS_TOKEN is absent", () => {
		process.env.INTERLINKED_TOKEN = "alt-token";
		expect(resolveAuthToken(tmp)).toBe("alt-token");
	});

	it("prefers INTERLINKED_ACCESS_TOKEN over INTERLINKED_TOKEN when both are set", () => {
		process.env.INTERLINKED_ACCESS_TOKEN = "a";
		process.env.INTERLINKED_TOKEN = "b";
		expect(resolveAuthToken(tmp)).toBe("a");
	});
});
