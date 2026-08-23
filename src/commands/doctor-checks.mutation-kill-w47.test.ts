import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_SCRIPT_VERSION } from "../lib/hooks.js";
import {
	authTokenCheck,
	clientHookChecks,
	harnessChecks,
	hookVersionChecks,
	legacyConfigCheck,
	localFileChecks,
	permissionRuleChecks,
	sessionFileChecks,
} from "./doctor-checks.js";

// Mutation-kill suite for wave pass1_w47 (src/commands/doctor-checks.ts).
// All I/O happens under a real per-test tmpdir; nothing touches the repo or
// the real user home except through an explicitly stubbed HOME env var that
// is always restored in afterEach.

let cwd: string;
let savedHome: string | undefined;
let savedInterlinkedHome: string | undefined;
let fakeHomeToClean: string | undefined;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-checks-w47-"));
	savedHome = process.env.HOME;
	savedInterlinkedHome = process.env.INTERLINKED_HOME;
	fakeHomeToClean = undefined;
	// getConfigDir() consults INTERLINKED_HOME first -- keep it unset so every
	// path in this suite resolves under our own tmpdir.
	delete process.env.INTERLINKED_HOME;
});

afterEach(() => {
	fs.rmSync(cwd, { recursive: true, force: true });
	if (fakeHomeToClean) fs.rmSync(fakeHomeToClean, { recursive: true, force: true });
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	if (savedInterlinkedHome === undefined) delete process.env.INTERLINKED_HOME;
	else process.env.INTERLINKED_HOME = savedInterlinkedHome;
});

function mkfile(rel: string, content = "{}"): string {
	const full = path.join(cwd, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content);
	return full;
}

function mkdir(rel: string): string {
	const full = path.join(cwd, rel);
	fs.mkdirSync(full, { recursive: true });
	return full;
}

// ---------------------------------------------------------------------------
// localFileChecks — agent identity + hook script path assembly
// ---------------------------------------------------------------------------

describe("localFileChecks — positive (must fire)", () => {
	it("P1: warns 'Agent identity' when local config exists but agent_name is unset", () => {
		mkdir(".interlinked");
		mkfile(".interlinked/config.local.json", "{}");
		const out = localFileChecks(cwd, { agent_name: undefined });
		const row = out.find((r) => r.name === "Agent identity");
		expect(row).toBeDefined();
		expect(row?.status).toBe("warn");
	});

	it("P2: 'Hook script' is pass only when the FULL .interlinked/hooks/interlinked-activity.mjs path exists", () => {
		mkfile(".interlinked/hooks/interlinked-activity.mjs", "// stub");
		const out = localFileChecks(cwd, {});
		const row = out.find((r) => r.name === "Hook script");
		expect(row?.status).toBe("pass");
	});

	it("P3: 'Hook script' warns when only the containing dirs exist but the file itself does not", () => {
		// .interlinked/hooks/ exists (empty) -- the literal path segments must
		// all be correct or existsSync would wrongly resolve to this directory.
		mkdir(".interlinked/hooks");
		const out = localFileChecks(cwd, {});
		const row = out.find((r) => r.name === "Hook script");
		expect(row?.status).toBe("warn");
	});

	it("P4: legacy .claude/hooks dir alone (no file) still warns, not passes", () => {
		mkdir(".claude/hooks");
		const out = localFileChecks(cwd, {});
		const row = out.find((r) => r.name === "Hook script");
		expect(row?.status).toBe("warn");
	});
});

// ---------------------------------------------------------------------------
// hookVersionChecks — expectedHookVersion / hookVersionResult / --fix path
// ---------------------------------------------------------------------------

describe("hookVersionChecks — positive (must fire)", () => {
	it("P1: no version stamp -> warn 'No version stamp found'", () => {
		mkfile(".interlinked/hooks/interlinked-activity.mjs", "// no stamp here\n");
		const out = hookVersionChecks(cwd, false);
		expect(out).toHaveLength(1);
		expect(out[0]?.status).toBe("warn");
		expect(out[0]?.message).toContain("No version stamp found");
	});

	it("P2: mismatched version stamp -> warn 'Installed vX, expected vY'", () => {
		mkfile(
			".interlinked/hooks/interlinked-activity.mjs",
			"// interlinked-hook-version: 0.0.1-not-real\n",
		);
		const out = hookVersionChecks(cwd, false);
		expect(out).toHaveLength(1);
		expect(out[0]?.status).toBe("warn");
		expect(out[0]?.message).toContain("Installed v0.0.1-not-real");
		expect(out[0]?.message).toContain("expected v");
		expect(out[0]?.fixable).toBe(true);
	});

	it("P3: matching version stamp (default 'quality' mode, no config.json) -> pass", () => {
		const expected = `${HOOK_SCRIPT_VERSION}+mode-quality`;
		mkfile(
			".interlinked/hooks/interlinked-activity.mjs",
			`// interlinked-hook-version: ${expected}\n`,
		);
		const out = hookVersionChecks(cwd, false);
		expect(out).toHaveLength(1);
		expect(out[0]?.status).toBe("pass");
		expect(out[0]?.message).toBe(`v${expected} (current)`);
	});

	it("P4: mismatched stamp + fix:true actually regenerates and reports 'Updated hook script'", () => {
		mkfile(
			".interlinked/hooks/interlinked-activity.mjs",
			"// interlinked-hook-version: 0.0.1-stale\n",
		);
		const out = hookVersionChecks(cwd, true);
		expect(out).toHaveLength(1);
		expect(out[0]?.status).toBe("pass");
		expect(out[0]?.message).toMatch(/^Updated hook script from v0\.0\.1-stale to v/);
	});
});

// ---------------------------------------------------------------------------
// clientHookChecks
// ---------------------------------------------------------------------------

describe("clientHookChecks — positive (must fire)", () => {
	it("P1: Claude Code settings.json present with a hook marker -> pass, exact name", () => {
		mkfile(
			".claude/settings.json",
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{ hooks: [{ type: "command", command: "node .interlinked/hooks/interlinked-activity.mjs" }] },
					],
				},
			}),
		);
		const out = clientHookChecks(cwd);
		const row = out.find((r) => r.name === "Claude Code hooks");
		expect(row?.status).toBe("pass");
	});

	it("P2: Gemini CLI settings.json present with a hook marker -> exact name 'Gemini CLI hooks'", () => {
		mkfile(
			".gemini/settings.json",
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{ hooks: [{ type: "command", command: "node .interlinked/hooks/interlinked-activity.mjs" }] },
					],
				},
			}),
		);
		const out = clientHookChecks(cwd);
		expect(out.map((r) => r.name)).toContain("Gemini CLI hooks");
	});

	it("P3: Codex CLI dir present without config.toml -> exact message 'config.toml not found'", () => {
		mkdir(".codex");
		const out = clientHookChecks(cwd);
		const row = out.find((r) => r.name === "Codex CLI hooks");
		expect(row?.status).toBe("warn");
		expect(row?.message).toBe("config.toml not found");
	});
});

// ---------------------------------------------------------------------------
// permissionRuleChecks
// ---------------------------------------------------------------------------

describe("permissionRuleChecks — positive (must fire)", () => {
	it("P1: a long malformed rule is truncated to 60 chars with a trailing ellipsis", () => {
		const junkRule = "x".repeat(100); // missing Tool(...) prefix -> flagged malformed
		mkfile(
			".claude/settings.json",
			JSON.stringify({ permissions: { allow: [junkRule], deny: [], ask: [] } }),
		);
		const out = permissionRuleChecks(cwd, false);
		const row = out.find((r) => r.name.includes(".claude/settings.json"));
		expect(row).toBeDefined();
		expect(row?.message).toContain("...");
	});

	it("P2: display path collapses a real HOME prefix to '~', not the literal string", () => {
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-checks-w47-home-"));
		fakeHomeToClean = fakeHome;
		process.env.HOME = fakeHome;
		const junkRule = "not a valid rule";
		fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(fakeHome, ".claude", "settings.json"),
			JSON.stringify({ permissions: { allow: [junkRule], deny: [], ask: [] } }),
		);
		const out = permissionRuleChecks(cwd, false);
		const row = out.find((r) => r.name.includes("settings.json") && r.name.includes("~"));
		expect(row).toBeDefined();
		expect(row?.name).not.toContain(fakeHome);
	});
});

// ---------------------------------------------------------------------------
// authTokenCheck
// ---------------------------------------------------------------------------

describe("authTokenCheck — positive (must fire)", () => {
	it("P1: null token, not a local dev server -> fail, not pass", () => {
		const result = authTokenCheck(null, false);
		expect(result.status).toBe("fail");
		expect(result.message).not.toContain("Token available");
	});

	it("P2: real token -> pass", () => {
		const result = authTokenCheck("tok_abc", false);
		expect(result.status).toBe("pass");
	});
});

// ---------------------------------------------------------------------------
// legacyConfigCheck
// ---------------------------------------------------------------------------

describe("legacyConfigCheck — positive (must fire)", () => {
	it("P1: fix:false never migrates -- warns and leaves the legacy file in place", () => {
		mkfile(".claude/interlinked-session.json", JSON.stringify({ server_url: "http://x", agent_name: "a" }));
		const out = legacyConfigCheck(cwd, false);
		expect(out).toHaveLength(1);
		expect(out[0]?.status).toBe("warn");
		expect(out[0]?.message).toContain("should migrate");
		expect(fs.existsSync(path.join(cwd, ".claude", "interlinked-session.json"))).toBe(true);
	});

	it("P2: fix:true migrates -- pass and legacy file relocated", () => {
		mkfile(".claude/interlinked-session.json", JSON.stringify({ server_url: "http://x", agent_name: "a" }));
		const out = legacyConfigCheck(cwd, true);
		expect(out).toHaveLength(1);
		expect(out[0]?.status).toBe("pass");
		expect(out[0]?.message).toContain("Migrated");
	});
});

// ---------------------------------------------------------------------------
// sessionFileChecks — path-segment assembly for both the primary and legacy dir
// ---------------------------------------------------------------------------

describe("sessionFileChecks — positive (must fire)", () => {
	it("P1: primary .interlinked/sessions dir with 2 fresh files -> exact count 2", () => {
		const dir = mkdir(".interlinked/sessions");
		fs.writeFileSync(path.join(dir, "a.json"), "{}");
		fs.writeFileSync(path.join(dir, "b.json"), "{}");
		const out = sessionFileChecks(cwd);
		expect(out).toHaveLength(1);
		expect(out[0]?.status).toBe("pass");
		expect(out[0]?.message).toBe("2 active session file(s)");
	});

	it("P2: legacy .interlinked/hooks/agent-sessions dir (no primary sessions dir) with 2 fresh files -> exact count 2", () => {
		const dir = mkdir(".interlinked/hooks/agent-sessions");
		fs.writeFileSync(path.join(dir, "a.json"), "{}");
		fs.writeFileSync(path.join(dir, "b.json"), "{}");
		const out = sessionFileChecks(cwd);
		expect(out).toHaveLength(1);
		expect(out[0]?.status).toBe("pass");
		expect(out[0]?.message).toBe("2 active session file(s)");
	});

	it("P3: empty primary sessions dir -> 'No session files'", () => {
		mkdir(".interlinked/sessions");
		const out = sessionFileChecks(cwd);
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toBe("No session files");
	});
});

// ---------------------------------------------------------------------------
// harnessChecks — object-literal passthrough into harnessServerRow + guard-rules
// ---------------------------------------------------------------------------

describe("harnessChecks — positive (must fire)", () => {
	it("P1: a live pid file (this process) with no socket reports pass 'Running (PID ...)'", () => {
		const configDir = mkdir(".interlinked");
		fs.writeFileSync(path.join(configDir, "harness.pid"), String(process.pid));
		const out = harnessChecks(cwd, configDir, undefined);
		const row = out.find((r) => r.name === "Harness server");
		expect(row?.status).toBe("pass");
		expect(row?.message).toContain("Running");
		expect(row?.message).toContain(String(process.pid));
	});

	it("P2: no pid file, no socket file -> the DEFAULT 'not running' message, not the stale-socket one", () => {
		const configDir = mkdir(".interlinked");
		const out = harnessChecks(cwd, configDir, undefined);
		const row = out.find((r) => r.name === "Harness server");
		expect(row?.status).toBe("warn");
		expect(row?.message).not.toContain("Stale socket");
		expect(row?.message).toContain("Not running");
	});

	it("P3: guard-rules.json present -> pass 'present (team-shared rules)'", () => {
		const configDir = mkdir(".interlinked");
		fs.writeFileSync(path.join(configDir, "guard-rules.json"), "{}");
		const out = harnessChecks(cwd, configDir, undefined);
		const row = out.find((r) => r.name === "Guard rules");
		expect(row?.status).toBe("pass");
	});

	it("P4: guard-rules.json absent -> warn, even though configDir itself exists", () => {
		const configDir = mkdir(".interlinked");
		const out = harnessChecks(cwd, configDir, undefined);
		const row = out.find((r) => r.name === "Guard rules");
		expect(row?.status).toBe("warn");
	});
});
