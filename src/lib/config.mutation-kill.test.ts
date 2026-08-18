// Mutation-kill companion for config.ts.
//
// Targets the 40 mutants recorded as "survived" for src/lib/config.ts in
// .interlinked/mutation-manifest.json at generation 1727 (2026-08-17). The
// broader src/lib/__tests__/config.test.ts suite already exercises this
// module extensively, but it sits outside the mutation runner's companion
// scope (glob_fallback reported testCount: 0 for this file), so none of its
// coverage counts toward survivor kills. This file lives beside config.ts
// with a static SUT import specifically so the runner picks it up.
//
// One mutant (readJson: `!existsSync(path)`) targets a function that no
// longer exists in this file — it was extracted into json-file.ts's
// `readJsonFile` by commit f001df7 and now uses a try/catch instead of an
// existsSync guard. That survivor is stale manifest bookkeeping, not
// something a same-file test can target; left uncovered, not claimed.

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted: spies on mkdirSync only (call-through to the real implementation)
// while every other fs export stays untouched. Plain `vi.spyOn(fs, ...)`
// throws "Module namespace is not configurable in ESM" for node:fs — this is
// the vitest-documented workaround, and it also covers config.ts's own
// `import { mkdirSync } from "node:fs"` since both resolve through the same
// mocked module graph within this test file.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, mkdirSync: vi.fn(actual.mkdirSync) };
});

import {
	FEATURE_DEFAULTS,
	getLocalConfigPath,
	getSharedConfigPath,
	initConfig,
	isFeatureEnabled,
	readSharedConfig,
	resolveConfig,
	updateLocalConfig,
	writeSharedConfig,
} from "./config.js";
import type { SharedConfig } from "./config.js";

// test-contract: invariant — FEATURE_DEFAULTS is the dark-ship source of truth every isFeatureEnabled() fallback reads; a value flipped here silently changes gate behavior for every unconfigured install.
it("FEATURE_DEFAULTS pins every dotted-path default exactly", () => {
	expect(FEATURE_DEFAULTS).toEqual({
		"harness.evaluator.wrapper_normalization": true,
		"harness.evaluator.span_classification": true,
		"harness.evaluator.keyword_quick_reject": true,
		"harness.evaluator.dual_engine_regex": true,
		"harness.evaluator.allowlist_expiry": true,
		"harness.rules.destructive_v1_extras": true,
		"harness.rules.resource_bomb": true,
		"harness.checks.ubs_critical_tier": true,
		"harness.checks.ubs_warning_tier": true,
		"harness.checks.ubs_advisory_tier": false,
		"harness.trajectory.tool_loop": false,
		"harness.trajectory.destructive_sequence": false,
		"harness.trajectory.unbackedoff_retry": false,
		"harness.trajectory.silent_stall": false,
		"harness.impact_analysis.pagerank": false,
		"harness.impact_analysis.cycle_detection": false,
		"harness.compact_reminder.enabled": true,
		"harness.exit_codes.envelope": true,
		"harness.bench.section_timing": true,
	});
});

describe("initConfig (mutation-kill)", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(join(tmpdir(), "cfg-mk-"));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — initConfig must only touch config.local.json when the caller actually supplies an agentName or mcpPrefix; a plain "interlinked enable --server ..." run must not create a stray local-config file.
	it("does not create a local config file when neither agentName nor mcpPrefix is given", () => {
		initConfig({ serverUrl: "https://x" }, tmp);
		expect(fs.existsSync(getLocalConfigPath(tmp))).toBe(false);
	});
});

describe("isFeatureEnabled (mutation-kill)", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(join(tmpdir(), "cfg-mk-"));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: boundary — a dotted path whose first segment isn't "harness" must skip the override walk entirely and resolve from FEATURE_DEFAULTS only, even when config.harness holds a same-named subtree the walk could otherwise match.
	it("skips the override walk for a non-harness-prefixed path", () => {
		const config: SharedConfig = {
			version: 1,
			server_url: "https://x",
			harness: { checks: { ubs_advisory_tier: true } },
		};
		// Not in FEATURE_DEFAULTS and doesn't start with "harness." — must be
		// false, never the override-tree value the matching suffix would hit.
		expect(isFeatureEnabled("other.checks.ubs_advisory_tier", config)).toBe(false);
	});

	// test-contract: boundary — an explicit null mid-path in a hand-edited config.json must be caught by the type/null guard and break to the FEATURE_DEFAULTS fallback rather than throwing when the walk indexes into it.
	it("does not throw when an override branch is explicitly null on disk", () => {
		writeSharedConfig({ version: 1, server_url: "https://x" }, tmp);
		fs.writeFileSync(
			getSharedConfigPath(tmp),
			JSON.stringify({ version: 1, server_url: "https://x", harness: { evaluator: null } }),
		);
		const config = readSharedConfig(tmp);
		expect(isFeatureEnabled("harness.evaluator.wrapper_normalization", config)).toBe(true);
	});
});

describe("writeJson (mutation-kill, exercised via writeSharedConfig)", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(join(tmpdir(), "cfg-mk-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — writeJson must only call mkdirSync when the target directory is actually missing; a directory that already exists (the common warm-repo path) must not trigger a redundant mkdirSync call.
	it("does not call mkdirSync when the config directory already exists", () => {
		fs.mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		vi.mocked(fs.mkdirSync).mockClear();
		writeSharedConfig({ version: 1, server_url: "https://x" }, tmp);
		expect(fs.mkdirSync).not.toHaveBeenCalled();
		expect(readSharedConfig(tmp)?.server_url).toBe("https://x");
	});
});

describe("resolveConfig — env var trimming (mutation-kill)", () => {
	const savedEnv: Record<string, string | undefined> = {};
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
			savedEnv[k] = process.env[k];
			delete process.env[k];
		}
		tmp = fs.mkdtempSync(join(tmpdir(), "cfg-mk-"));
	});

	afterEach(() => {
		for (const k of envKeys) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: boundary — INTERLINKED_SERVER_URL, INTERLINKED_WORKSPACE_ID, and INTERLINKED_MCP_PREFIX are each trimmed before use, so shell whitespace never leaks into the resolved config.
	it("trims padded INTERLINKED_SERVER_URL, INTERLINKED_WORKSPACE_ID, and INTERLINKED_MCP_PREFIX", () => {
		process.env.INTERLINKED_SERVER_URL = "  https://padded.example  ";
		process.env.INTERLINKED_WORKSPACE_ID = "  ws-padded  ";
		process.env.INTERLINKED_MCP_PREFIX = "  mp-padded  ";
		const resolved = resolveConfig(tmp);
		expect(resolved.server_url).toBe("https://padded.example");
		expect(resolved.workspace_id).toBe("ws-padded");
		expect(resolved.mcp_prefix).toBe("mp-padded");
	});

	// test-contract: boundary — INTERLINKED_AGENT_NAME is trimmed before it wins the resolved agent_name field.
	it("trims a padded INTERLINKED_AGENT_NAME", () => {
		process.env.INTERLINKED_AGENT_NAME = "  agent-padded  ";
		expect(resolveConfig(tmp).agent_name).toBe("agent-padded");
	});

	// test-contract: boundary — INTERLINKED_AGENT (the fallback source used only when INTERLINKED_AGENT_NAME is unset) is trimmed before it wins agent_name too.
	it("trims a padded INTERLINKED_AGENT when INTERLINKED_AGENT_NAME is unset", () => {
		process.env.INTERLINKED_AGENT = "  agent-fallback-padded  ";
		expect(resolveConfig(tmp).agent_name).toBe("agent-fallback-padded");
	});

	// test-contract: boundary — INTERLINKED_ACCESS_TOKEN is trimmed before it wins the resolved access_token field.
	it("trims a padded INTERLINKED_ACCESS_TOKEN", () => {
		process.env.INTERLINKED_ACCESS_TOKEN = "  tok-padded  ";
		expect(resolveConfig(tmp).access_token).toBe("tok-padded");
	});

	// test-contract: boundary — INTERLINKED_TOKEN (the fallback source used only when INTERLINKED_ACCESS_TOKEN is unset) is trimmed before it wins access_token too.
	it("trims a padded INTERLINKED_TOKEN when INTERLINKED_ACCESS_TOKEN is unset", () => {
		process.env.INTERLINKED_TOKEN = "  tok-fallback-padded  ";
		expect(resolveConfig(tmp).access_token).toBe("tok-fallback-padded");
	});
});

describe("resolveConfig — string/conditional literals (mutation-kill)", () => {
	const savedEnv: Record<string, string | undefined> = {};
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
			savedEnv[k] = process.env[k];
			delete process.env[k];
		}
		tmp = fs.mkdtempSync(join(tmpdir(), "cfg-mk-"));
	});

	afterEach(() => {
		for (const k of envKeys) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — the active-server key defaults to the literal "production" when local.active_server is unset, so a servers.production entry the user actually saved is the one resolved.
	it("falls back to the 'production' server-entry key when active_server is unset", () => {
		updateLocalConfig(
			{ servers: { production: { server_url: "https://from-production-entry.example" } } },
			tmp,
		);
		expect(resolveConfig(tmp).server_url).toBe("https://from-production-entry.example");
	});

	// test-contract: public-api — INTERLINKED_SYNC_MODE="manual" must actually switch sync_mode to "manual", one of the three documented accepted values.
	it("accepts INTERLINKED_SYNC_MODE=manual", () => {
		process.env.INTERLINKED_SYNC_MODE = "manual";
		expect(resolveConfig(tmp).sync_mode).toBe("manual");
	});

	// test-contract: public-api — INTERLINKED_SYNC_MODE="realtime" must actually switch sync_mode to "realtime" even when the local config's own default differs, proving the env branch really reassigns rather than "realtime" being the answer by coincidence.
	it("accepts INTERLINKED_SYNC_MODE=realtime over a differing local default", () => {
		updateLocalConfig({ sync_mode: "local" }, tmp);
		process.env.INTERLINKED_SYNC_MODE = "realtime";
		expect(resolveConfig(tmp).sync_mode).toBe("realtime");
	});
});
