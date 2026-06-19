import { sign as edSign, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPONSOR_STATUS_FILE } from "../harness/sponsor/feed-client.js";
import type { SponsorFeed } from "../harness/sponsor/types.js";
import {
	sponsorDisableAction,
	sponsorEnableAction,
	sponsorStatusAction,
} from "./sponsor.js";

const FEED: SponsorFeed = {
	version: 1,
	generated_at: "2026-06-12T00:00:00Z",
	valid_until: "2099-01-01T00:00:00Z",
	creatives: [
		{
			id: "alpha",
			campaign: "friends",
			text: "Alpha — a friend project",
			url: "https://alpha.example",
			weight: 1,
		},
	],
};

function makeSignedWire(feed: SponsorFeed): { wire: string; pubB64: string } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const bytes = Buffer.from(JSON.stringify(feed), "utf8");
	return {
		wire: JSON.stringify({
			key_id: "test",
			payload_b64: bytes.toString("base64"),
			sig: edSign(null, bytes, privateKey).toString("base64"),
		}),
		pubB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
	};
}

describe("sponsor command actions", () => {
	let cwd: string;
	let settingsPath: string;
	let savedEnv: string | undefined;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "sponsor-cmd-"));
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		settingsPath = join(cwd, "claude-settings.json");
		savedEnv = process.env.INTERLINKED_SPONSOR_PUBKEY;
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		if (savedEnv === undefined) delete process.env.INTERLINKED_SPONSOR_PUBKEY;
		else process.env.INTERLINKED_SPONSOR_PUBKEY = savedEnv;
		vi.restoreAllMocks();
	});

	function localConfig(): Record<string, unknown> {
		return JSON.parse(
			readFileSync(join(cwd, ".interlinked", "config.local.json"), "utf8"),
		) as Record<string, unknown>;
	}

	it("enable writes the sponsor block and a stable anonymous install id", async () => {
		await sponsorEnableAction({}, { cwd, claudeSettingsPath: settingsPath });
		const cfg = localConfig();
		const sponsor = cfg.sponsor as Record<string, unknown>;
		expect(sponsor.enabled).toBe(true);
		expect(sponsor.telemetry).toBe(true);
		expect(typeof cfg.install_id).toBe("string");
		const firstId = cfg.install_id;
		// Re-enable keeps the same install id.
		await sponsorEnableAction({}, { cwd, claudeSettingsPath: settingsPath });
		expect(localConfig().install_id).toBe(firstId);
	});

	it("enable refuses outside an interlinked project", async () => {
		const bare = mkdtempSync(join(tmpdir(), "sponsor-bare-"));
		const code = await sponsorEnableAction({}, { cwd: bare, claudeSettingsPath: settingsPath });
		expect(code).toBe(1);
		expect(existsSync(join(bare, ".interlinked", "config.local.json"))).toBe(false);
		rmSync(bare, { recursive: true, force: true });
	});

	it("enable --spinner fetches the feed and writes a tracked spinner verb", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const fetchImpl = (async () => ({ ok: true, text: async () => wire })) as unknown as typeof fetch;
		await sponsorEnableAction(
			{ spinner: true },
			{ cwd, claudeSettingsPath: settingsPath, fetchImpl },
		);
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			spinnerVerbs?: { verbs?: string[] };
		};
		expect(settings.spinnerVerbs?.verbs?.[0]).toContain("Alpha");
		const sponsor = localConfig().sponsor as { spinner_verbs_written?: string[] };
		expect(sponsor.spinner_verbs_written).toEqual(settings.spinnerVerbs?.verbs);
	});

	it("disable flips the flag, clears the status file, and removes our verbs", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const fetchImpl = (async () => ({ ok: true, text: async () => wire })) as unknown as typeof fetch;
		await sponsorEnableAction(
			{ spinner: true },
			{ cwd, claudeSettingsPath: settingsPath, fetchImpl },
		);
		// Simulate a daemon-written status row.
		writeFileSync(join(cwd, ".interlinked", SPONSOR_STATUS_FILE), "enabled=1\n");
		await sponsorDisableAction({}, { cwd, claudeSettingsPath: settingsPath });
		const sponsor = localConfig().sponsor as Record<string, unknown>;
		expect(sponsor.enabled).toBe(false);
		expect(sponsor.spinner_verbs_written).toEqual([]);
		expect(readFileSync(join(cwd, ".interlinked", SPONSOR_STATUS_FILE), "utf8")).toContain(
			"enabled=0",
		);
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		expect(settings.spinnerVerbs).toBeUndefined();
	});

	it("status --json reports config and live status", async () => {
		await sponsorEnableAction({}, { cwd, claudeSettingsPath: settingsPath });
		writeFileSync(
			join(cwd, ".interlinked", SPONSOR_STATUS_FILE),
			"enabled=1\ncreative=alpha\ntext=Alpha\n",
		);
		const logSpy = vi.mocked(console.log);
		logSpy.mockClear();
		await sponsorStatusAction({ json: true }, { cwd, claudeSettingsPath: settingsPath });
		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		const parsed = JSON.parse(printed) as {
			enabled: boolean;
			live: Record<string, string>;
		};
		expect(parsed.enabled).toBe(true);
		expect(parsed.live.creative).toBe("alpha");
	});

	it("disable --json emits a machine-readable disabled payload", async () => {
		await sponsorEnableAction({}, { cwd, claudeSettingsPath: settingsPath });
		const logSpy = vi.mocked(console.log);
		logSpy.mockClear();
		const code = await sponsorDisableAction({ json: true }, { cwd, claudeSettingsPath: settingsPath });
		expect(code).toBe(0);
		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(JSON.parse(printed)).toEqual({ enabled: false });
	});

	it("status (non-json) prints the feed, telemetry, and the live creative line", async () => {
		await sponsorEnableAction({}, { cwd, claudeSettingsPath: settingsPath });
		writeFileSync(
			join(cwd, ".interlinked", SPONSOR_STATUS_FILE),
			"enabled=1\ncreative=alpha\ntext=Alpha line\n",
		);
		const logSpy = vi.mocked(console.log);
		logSpy.mockClear();
		const code = await sponsorStatusAction({}, { cwd, claudeSettingsPath: settingsPath });
		expect(code).toBe(0);
		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("Sponsor slot:");
		expect(printed).toContain("feed:");
		expect(printed).toContain("telemetry:");
		expect(printed).toContain("showing: alpha — Alpha line");
	});

	it("status (non-json) on a fresh project reports disabled with no live creative", async () => {
		const logSpy = vi.mocked(console.log);
		logSpy.mockClear();
		const code = await sponsorStatusAction({}, { cwd, claudeSettingsPath: settingsPath });
		expect(code).toBe(0);
		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("disabled");
		expect(printed).not.toContain("showing:");
	});
});
