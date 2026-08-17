import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadInterlinkedConfig, mergeConfig } from "./interlinked-config.js";
import type { InterlinkedConfig } from "./interlinked-config.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-cfg-"));
	mkdirSync(join(tmp, ".interlinked"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeConfig(raw: unknown): string {
	const path = join(tmp, ".interlinked", "config.json");
	writeFileSync(path, JSON.stringify(raw, null, 2));
	return path;
}

function distinctBase(): InterlinkedConfig {
	return {
		...DEFAULT_CONFIG,
		binary_version: "fallback-version",
		workspace_id: "fallback-workspace",
		runners_enabled: ["unknown"],
		daemon: {
			auto_start: false,
			idle_shutdown_ms: 123,
			log_level: "error",
			tsgo_enabled: false,
		},
		tool_classes: {
			read_budget_ms: 11,
			modify_budget_ms: 22,
			side_effect_budget_ms: 33,
			long_running_budget_ms: 44,
			unknown_budget_ms: 55,
		},
		cloud: {
			enabled: true,
			product: "guardrails",
			portal_url: "fallback-portal",
			token_env: "FALLBACK_TOKEN",
		},
	};
}

describe("loadInterlinkedConfig", () => {
	it("returns defaults when no file exists", () => {
		expect(loadInterlinkedConfig(tmp)).toEqual({
			schema_version: "1",
			binary_version: "0.0.0",
			workspace_id: null,
			runners_enabled: ["claude-code", "copilot-cli"],
			daemon: {
				auto_start: true,
				idle_shutdown_ms: 900_000,
				log_level: "info",
				tsgo_enabled: true,
			},
			tool_classes: {
				read_budget_ms: 300,
				modify_budget_ms: 800,
				side_effect_budget_ms: 2000,
				long_running_budget_ms: 5000,
				unknown_budget_ms: 800,
			},
			cloud: {
				enabled: false,
				product: null,
				portal_url: null,
				token_env: null,
			},
		});
	});

	it("does not emit a read error when the config file is absent", () => {
		const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		expect(loadInterlinkedConfig(tmp)).toEqual({
			...DEFAULT_CONFIG,
		});
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("merges a partial config over defaults", () => {
		writeConfig({
			tool_classes: { read_budget_ms: 100 },
			daemon: { tsgo_enabled: false },
		});
		const cfg = loadInterlinkedConfig(tmp);
		expect(cfg.tool_classes.read_budget_ms).toBe(100);
		expect(cfg.tool_classes.modify_budget_ms).toBe(
			DEFAULT_CONFIG.tool_classes.modify_budget_ms,
		);
		expect(cfg.daemon.tsgo_enabled).toBe(false);
		expect(cfg.daemon.auto_start).toBe(true);
	});

	it("respects cloud.enabled = true", () => {
		writeConfig({ cloud: { enabled: true, product: "guardrails", portal_url: "https://x" } });
		const cfg = loadInterlinkedConfig(tmp);
		expect(cfg.cloud.enabled).toBe(true);
		expect(cfg.cloud.product).toBe("guardrails");
		expect(cfg.cloud.portal_url).toBe("https://x");
	});

	it("returns defaults when file is malformed JSON", () => {
		writeFileSync(join(tmp, ".interlinked", "config.json"), "{not json");
		const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		expect(loadInterlinkedConfig(tmp)).toEqual(DEFAULT_CONFIG);
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("could not parse"));
		spy.mockRestore();
	});

	it("returns defaults and reports an unreadable config path", () => {
		mkdirSync(join(tmp, ".interlinked", "config.json"));
		const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		expect(loadInterlinkedConfig(tmp)).toEqual(DEFAULT_CONFIG);
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("could not read"));
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});
});

describe("mergeConfig — validation", () => {
	it("rejects wrong types and falls back to defaults per-field", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, {
			daemon: { auto_start: "yes", idle_shutdown_ms: -1 },
			tool_classes: { read_budget_ms: "fast" },
		});
		expect(cfg.daemon.auto_start).toBe(DEFAULT_CONFIG.daemon.auto_start);
		expect(cfg.daemon.idle_shutdown_ms).toBe(DEFAULT_CONFIG.daemon.idle_shutdown_ms);
		expect(cfg.tool_classes.read_budget_ms).toBe(DEFAULT_CONFIG.tool_classes.read_budget_ms);
	});

	it("filters runners_enabled to known ids", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, {
			runners_enabled: ["claude-code", "not-a-runner", "cursor"],
		});
		expect(cfg.runners_enabled).toEqual(["claude-code", "cursor"]);
	});

	it("accepts null for cloud.product", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { cloud: { product: null } });
		expect(cfg.cloud.product).toBeNull();
	});

	it("accepts null for workspace_id", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { workspace_id: null });
		expect(cfg.workspace_id).toBeNull();
	});

	it("ignores invalid log_level and keeps default", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { daemon: { log_level: "TRACE" } });
		expect(cfg.daemon.log_level).toBe(DEFAULT_CONFIG.daemon.log_level);
	});

	it("returns the supplied base for null and primitive top-level values", () => {
		const base = distinctBase();
		for (const raw of [null, undefined, true, 7, "config", Symbol("config")]) {
			expect(mergeConfig(base, raw)).toBe(base);
		}
	});

	it("keeps the schema version fixed while accepting a binary version string", () => {
		const base = distinctBase();
		expect(mergeConfig(base, { binary_version: "2.4.0" })).toMatchObject({
			schema_version: "1",
			binary_version: "2.4.0",
		});
		expect(mergeConfig(base, { binary_version: 2 })).toMatchObject({
			schema_version: "1",
			binary_version: "fallback-version",
		});
	});

	it("uses section fallbacks for null and primitive daemon, budget, and cloud values", () => {
		const base = distinctBase();
		for (const raw of [null, 7, "section"]) {
			expect(mergeConfig(base, { daemon: raw }).daemon).toBe(base.daemon);
			expect(mergeConfig(base, { tool_classes: raw }).tool_classes).toBe(base.tool_classes);
			expect(mergeConfig(base, { cloud: raw }).cloud).toBe(base.cloud);
		}
	});

	it("accepts and rejects nullable string fields independently", () => {
		const base = distinctBase();
		const cfg = mergeConfig(base, {
			workspace_id: null,
			cloud: { portal_url: "https://portal", token_env: null },
		});
		expect(cfg.workspace_id).toBeNull();
		expect(cfg.cloud.portal_url).toBe("https://portal");
		expect(cfg.cloud.token_env).toBeNull();

		const fallback = mergeConfig(base, {
			workspace_id: 42,
			cloud: { portal_url: false, token_env: {} },
		});
		expect(fallback.workspace_id).toBe("fallback-workspace");
		expect(fallback.cloud.portal_url).toBe("fallback-portal");
		expect(fallback.cloud.token_env).toBe("FALLBACK_TOKEN");
	});

	it("accepts zero and finite nonnegative budgets but rejects non-numbers and non-finite values", () => {
		const base = distinctBase();
		const zero = mergeConfig(base, {
			daemon: { idle_shutdown_ms: 0 },
			tool_classes: { read_budget_ms: 0 },
		});
		expect(zero.daemon.idle_shutdown_ms).toBe(0);
		expect(zero.tool_classes.read_budget_ms).toBe(0);

		const finite = mergeConfig(base, {
			daemon: { idle_shutdown_ms: 99.5 },
			tool_classes: { read_budget_ms: 10 },
		});
		expect(finite.daemon.idle_shutdown_ms).toBe(99.5);
		expect(finite.tool_classes.read_budget_ms).toBe(10);

		const invalid = mergeConfig(base, {
			daemon: { idle_shutdown_ms: Number.NaN },
			tool_classes: { read_budget_ms: Number.POSITIVE_INFINITY, modify_budget_ms: -1 },
		});
		expect(invalid.daemon.idle_shutdown_ms).toBe(123);
		expect(invalid.tool_classes.read_budget_ms).toBe(11);
		expect(invalid.tool_classes.modify_budget_ms).toBe(22);
	});

	it("accepts every supported log level and falls back for invalid values", () => {
		for (const level of ["debug", "info", "warn", "error"] as const) {
			const fallback = level === "debug" ? "info" : "debug";
			const base = distinctBase();
			base.daemon.log_level = fallback;
			expect(mergeConfig(base, { daemon: { log_level: level } }).daemon.log_level).toBe(level);
		}
		const base = distinctBase();
		expect(mergeConfig(base, { daemon: { log_level: "trace" } }).daemon.log_level).toBe("error");
	});

	it("keeps every known runner, ignores invalid entries, and falls back for empty results", () => {
		const base = distinctBase();
		const known = ["claude-code", "copilot-cli", "codex", "gemini-cli", "cursor", "unknown"];
		expect(mergeConfig(base, { runners_enabled: known }).runners_enabled).toEqual(known);
		expect(mergeConfig(base, { runners_enabled: ["not-a-runner", 3, null] }).runners_enabled).toBe(
			base.runners_enabled,
		);
		expect(mergeConfig(base, { runners_enabled: [] }).runners_enabled).toBe(base.runners_enabled);
	});

	it("accepts both cloud products, null, and falls back for invalid products", () => {
		const base = distinctBase();
		expect(mergeConfig(base, { cloud: { product: "guardrails" } }).cloud.product).toBe("guardrails");
		const agentBase = distinctBase();
		agentBase.cloud.product = "guardrails";
		expect(mergeConfig(agentBase, { cloud: { product: "agent-ci" } }).cloud.product).toBe("agent-ci");
		const nullBase = distinctBase();
		nullBase.cloud.product = "agent-ci";
		expect(mergeConfig(nullBase, { cloud: { product: null } }).cloud.product).toBeNull();
		expect(mergeConfig(base, { cloud: { product: "unknown" } }).cloud.product).toBe("guardrails");
	});
});
