import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getConfigDir,
	getDataDir,
	getHooksDir,
	getLocalConfigPath,
	getSharedConfigPath,
	isConfigured,
	readLocalConfig,
	readSharedConfig,
	resolveConfig,
	updateLocalConfig,
} from "../config.js";

describe("config paths", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("getConfigDir returns <cwd>/.interlinked", () => {
		expect(getConfigDir(tmp)).toBe(join(tmp, ".interlinked"));
	});

	it("getDataDir defaults under .interlinked/ but honors data_dir override", () => {
		// Default — no local config yet.
		expect(getDataDir(tmp)).toBe(join(tmp, ".interlinked"));
	});

	it("getHooksDir lives under .interlinked/hooks", () => {
		expect(getHooksDir(tmp)).toBe(join(tmp, ".interlinked", "hooks"));
	});

	it("config path helpers return absolute paths under cwd", () => {
		expect(getSharedConfigPath(tmp).startsWith(tmp)).toBe(true);
		expect(getLocalConfigPath(tmp).startsWith(tmp)).toBe(true);
	});
});

describe("readSharedConfig / readLocalConfig", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns null when no config exists", () => {
		expect(readSharedConfig(tmp)).toBeNull();
		expect(readLocalConfig(tmp)).toBeNull();
	});

	it("reads a valid shared config file", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "config.json"),
			JSON.stringify({ version: 1, server_url: "https://example.com" }),
		);
		const read = readSharedConfig(tmp);
		expect(read?.server_url).toBe("https://example.com");
	});

	it("returns null on malformed JSON (tolerant read)", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(join(tmp, ".interlinked", "config.json"), "not-json");
		expect(readSharedConfig(tmp)).toBeNull();
	});
});

describe("isConfigured", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("is false when no config file exists", () => {
		expect(isConfigured(tmp)).toBe(false);
	});

	it("is true once a shared config is written", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "config.json"),
			JSON.stringify({ version: 1, server_url: "https://x" }),
		);
		expect(isConfigured(tmp)).toBe(true);
	});
});

describe("resolveConfig", () => {
	const saved: Record<string, string | undefined> = {};
	const envKeys = [
		"INTERLINKED_SERVER_URL",
		"INTERLINKED_WORKSPACE_ID",
		"INTERLINKED_MCP_PREFIX",
		"INTERLINKED_AGENT_NAME",
		"INTERLINKED_AGENT",
		"INTERLINKED_ACCESS_TOKEN",
		"INTERLINKED_TOKEN",
		"INTERLINKED_SYNC_MODE",
	];
	let tmp: string;

	beforeEach(() => {
		for (const k of envKeys) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		for (const k of envKeys) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns a DEFAULT_SERVER url when nothing is configured", () => {
		const resolved = resolveConfig(tmp);
		expect(resolved.server_url).toBeTruthy();
		expect(resolved.sync_mode).toBe("realtime");
	});

	it("env INTERLINKED_SERVER_URL overrides every other source", () => {
		process.env.INTERLINKED_SERVER_URL = "https://env.example";
		const resolved = resolveConfig(tmp);
		expect(resolved.server_url).toBe("https://env.example");
	});

	it("env INTERLINKED_SYNC_MODE is accepted only for known values", () => {
		process.env.INTERLINKED_SYNC_MODE = "local";
		expect(resolveConfig(tmp).sync_mode).toBe("local");
		process.env.INTERLINKED_SYNC_MODE = "bogus";
		expect(resolveConfig(tmp).sync_mode).toBe("realtime");
	});

	it("env INTERLINKED_ACCESS_TOKEN overrides local.access_token", () => {
		process.env.INTERLINKED_ACCESS_TOKEN = "env-tok";
		expect(resolveConfig(tmp).access_token).toBe("env-tok");
	});
});

describe("updateLocalConfig", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("merges updates into existing local config", () => {
		updateLocalConfig({ agent_name: "alice" }, tmp);
		updateLocalConfig({ sync_mode: "manual" }, tmp);
		const read = readLocalConfig(tmp);
		expect(read?.agent_name).toBe("alice");
		expect(read?.sync_mode).toBe("manual");
	});

	it("deep-merges the `servers` map rather than replacing it", () => {
		updateLocalConfig({ servers: { production: { server_url: "https://prod" } } }, tmp);
		updateLocalConfig({ servers: { staging: { server_url: "https://staging" } } }, tmp);
		const read = readLocalConfig(tmp);
		expect(read?.servers?.production?.server_url).toBe("https://prod");
		expect(read?.servers?.staging?.server_url).toBe("https://staging");
	});
});
