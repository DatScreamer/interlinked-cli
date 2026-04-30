import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "./rules-loader.js";
import { writeStatuslineArtifacts } from "./statusline-snapshot.js";
import type { GuardRulesConfig } from "./types.js";

function emptyConfig(): GuardRulesConfig {
	const cfg = getDefaultConfig();
	cfg.rules = [];
	cfg.disabled_rules = [];
	return cfg;
}

describe("writeStatuslineArtifacts", () => {
	let cwd: string;
	let interlinkedDir: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "statusline-snapshot-"));
		interlinkedDir = join(cwd, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("writes a snapshot with default mode values when no config files exist", () => {
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: emptyConfig(),
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
		});

		const text = readFileSync(join(interlinkedDir, "statusline.snapshot"), "utf-8");
		expect(text).toMatch(/^harness_mode=quality$/m);
		expect(text).toMatch(/^enforcement_mode=balanced$/m);
		expect(text).toMatch(/^sync_mode=realtime$/m);
		expect(text).toMatch(/^rules_total=0$/m);
		expect(text).toMatch(/^server_bridge=local_only$/m);
		expect(text).toMatch(/^index_status=missing$/m);
	});

	function writeConfiguredSnapshot(): string {
		writeFileSync(join(interlinkedDir, "config.json"), JSON.stringify({ mode: "ci" }));
		writeFileSync(
			join(interlinkedDir, "check-policy.json"),
			JSON.stringify({ mode: "strict" }),
		);
		writeFileSync(
			join(interlinkedDir, "config.local.json"),
			JSON.stringify({
				sync_mode: "local",
				active_server: "production",
				servers: { production: { workspace_id: "team-acme" } },
			}),
		);
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: emptyConfig(),
			reservationsCount: 2,
			indexStatus: "ready",
			indexFiles: 12450,
			serverBridgeConnected: true,
		});
		return readFileSync(join(interlinkedDir, "statusline.snapshot"), "utf-8");
	}

	it("reads harness_mode from config.json", () => {
		expect(writeConfiguredSnapshot()).toMatch(/^harness_mode=ci$/m);
	});

	it("reads enforcement_mode from check-policy.json", () => {
		expect(writeConfiguredSnapshot()).toMatch(/^enforcement_mode=strict$/m);
	});

	it("reads sync_mode and active_server from config.local.json", () => {
		const text = writeConfiguredSnapshot();
		expect(text).toMatch(/^sync_mode=local$/m);
		expect(text).toMatch(/^active_server=production$/m);
	});

	it("resolves workspace_id through the active server entry", () => {
		expect(writeConfiguredSnapshot()).toMatch(/^workspace_id=team-acme$/m);
	});

	it("propagates index status and file count", () => {
		const text = writeConfiguredSnapshot();
		expect(text).toMatch(/^index_status=ready$/m);
		expect(text).toMatch(/^index_files=12450$/m);
	});

	it("reflects connected server bridge", () => {
		expect(writeConfiguredSnapshot()).toMatch(/^server_bridge=connected$/m);
	});

	it("reflects current reservations count", () => {
		expect(writeConfiguredSnapshot()).toMatch(/^reservations_count=2$/m);
	});

	it("writes loaded-rules.md sorted by category then id", () => {
		const rules = emptyConfig();
		rules.rules = [
			{
				id: "process_b",
				enabled: true,
				trigger: "PreToolUse",
				tool_match: ["*"],
				action: "block",
				patterns: [],
				reason: "B",
				severity: "high",
				category: "process",
			},
			{
				id: "process_a",
				enabled: true,
				trigger: "PreToolUse",
				tool_match: ["*"],
				action: "block",
				patterns: [],
				reason: "A",
				severity: "high",
				category: "process",
			},
			{
				id: "filesystem_x",
				enabled: true,
				trigger: "PreToolUse",
				tool_match: ["*"],
				action: "warn",
				patterns: [],
				reason: "X",
				severity: "medium",
				category: "filesystem",
			},
		];
		rules.disabled_rules = ["block_force_push"];

		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules,
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
		});

		const md = readFileSync(join(interlinkedDir, "loaded-rules.md"), "utf-8");
		expect(md).toContain("Total active rules: **3**");
		expect(md).toContain("## Filesystem (1)");
		expect(md).toContain("## Process (2)");
		const aIdx = md.indexOf("`process_a`");
		const bIdx = md.indexOf("`process_b`");
		expect(aIdx).toBeGreaterThan(0);
		expect(bIdx).toBeGreaterThan(aIdx);
		expect(md).toContain("## Disabled rules (1)");
		expect(md).toContain("~~`block_force_push`~~");
	});
});
