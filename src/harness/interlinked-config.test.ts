import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadInterlinkedConfig, mergeConfig } from "./interlinked-config.js";

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

describe("loadInterlinkedConfig", () => {
	it("returns defaults when no file exists", () => {
		expect(loadInterlinkedConfig(tmp)).toEqual(DEFAULT_CONFIG);
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
		expect(spy).toHaveBeenCalled();
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
});
