import { sign as edSign, generateKeyPairSync } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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

	it("enable --json emits a machine-readable enabled payload", async () => {
		const logSpy = vi.mocked(console.log);
		logSpy.mockClear();
		const code = await sponsorEnableAction(
			{ json: true },
			{ cwd, claudeSettingsPath: settingsPath },
		);
		expect(code).toBe(0);
		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		const parsed = JSON.parse(printed) as { enabled: boolean; install_id: string };
		expect(parsed.enabled).toBe(true);
		expect(typeof parsed.install_id).toBe("string");
	});

	it("enable records a custom --feed-url override", async () => {
		await sponsorEnableAction(
			{ feedUrl: "https://feed.example/custom" },
			{ cwd, claudeSettingsPath: settingsPath },
		);
		const sponsor = localConfig().sponsor as { feed_url?: string };
		expect(sponsor.feed_url).toBe("https://feed.example/custom");
	});

	it("resolveDeps falls back to process.cwd()/homedir() when no overrides are given", async () => {
		// Exercise the default-cwd / default-settings-path branches without
		// touching the real repo: chdir into a bare tmp dir with no
		// .interlinked/, so the action early-returns before any write.
		const bareDefault = mkdtempSync(join(tmpdir(), "sponsor-default-cwd-"));
		// SPY, not process.chdir(): chdir THROWS in a worker thread
		// ("process.chdir() is not supported in workers"), and Stryker's vitest
		// runner pins a worker-thread pool.
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(realpathSync(bareDefault));
		try {
			const code = await sponsorEnableAction({}, {});
			expect(code).toBe(1);
		} finally {
			cwdSpy.mockRestore();
			rmSync(bareDefault, { recursive: true, force: true });
		}
	});

	it("enable --spinner reports skipped when the feed fetch fails (wire is null)", async () => {
		const fetchImpl = (async () => ({ ok: false })) as unknown as typeof fetch;
		await sponsorEnableAction(
			{ spinner: true },
			{ cwd, claudeSettingsPath: settingsPath, fetchImpl },
		);
		const errSpy = vi.mocked(console.error);
		const printed = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("Spinner surface skipped: no verified feed/creative available yet.");
		const sponsor = localConfig().sponsor as { spinner?: boolean };
		expect(sponsor.spinner).toBeUndefined();
	});

	it("enable --spinner reports skipped when the wire signature does not verify (feed is null)", async () => {
		const { wire } = makeSignedWire(FEED);
		// No INTERLINKED_SPONSOR_PUBKEY set (or set to a mismatched key) → verifyWire fails.
		delete process.env.INTERLINKED_SPONSOR_PUBKEY;
		const fetchImpl = (async () => ({ ok: true, text: async () => wire })) as unknown as typeof fetch;
		await sponsorEnableAction(
			{ spinner: true },
			{ cwd, claudeSettingsPath: settingsPath, fetchImpl },
		);
		const errSpy = vi.mocked(console.error);
		const printed = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("Spinner surface skipped: no verified feed/creative available yet.");
	});

	it("enable --spinner reports skipped when the feed has no live creative (creative is null)", async () => {
		const expiredFeed: SponsorFeed = {
			...FEED,
			valid_until: "2000-01-01T00:00:00Z",
		};
		const { wire, pubB64 } = makeSignedWire(expiredFeed);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const fetchImpl = (async () => ({ ok: true, text: async () => wire })) as unknown as typeof fetch;
		await sponsorEnableAction(
			{ spinner: true },
			{ cwd, claudeSettingsPath: settingsPath, fetchImpl },
		);
		const errSpy = vi.mocked(console.error);
		const printed = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("Spinner surface skipped: no verified feed/creative available yet.");
	});

	it("enable --spinner reports skipped when settings.json is not parseable (res.ok false)", async () => {
		writeFileSync(settingsPath, "{ not valid json");
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const fetchImpl = (async () => ({ ok: true, text: async () => wire })) as unknown as typeof fetch;
		await sponsorEnableAction(
			{ spinner: true },
			{ cwd, claudeSettingsPath: settingsPath, fetchImpl },
		);
		const errSpy = vi.mocked(console.error);
		const printed = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("Spinner surface skipped: settings.json not parseable — left untouched");
		const sponsor = localConfig().sponsor as { spinner?: boolean };
		expect(sponsor.spinner).toBeUndefined();
	});

	it("enable (non-json) reports telemetry off when a prior config already disabled it", async () => {
		// Pre-seed a sponsor block with telemetry:false so `prior.telemetry ?? true`
		// keeps it off, then re-enable and check the non-json summary line.
		await sponsorEnableAction({}, { cwd, claudeSettingsPath: settingsPath });
		const cfgBefore = localConfig();
		writeFileSync(
			join(cwd, ".interlinked", "config.local.json"),
			JSON.stringify({ ...cfgBefore, sponsor: { ...(cfgBefore.sponsor as object), telemetry: false } }),
		);
		const logSpy = vi.mocked(console.log);
		logSpy.mockClear();
		await sponsorEnableAction({}, { cwd, claudeSettingsPath: settingsPath });
		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("Telemetry: off");
	});

	it("disable on a fresh project (no prior sponsor config) is a safe no-op", async () => {
		const code = await sponsorDisableAction({}, { cwd, claudeSettingsPath: settingsPath });
		expect(code).toBe(0);
		const sponsor = localConfig().sponsor as Record<string, unknown>;
		expect(sponsor.enabled).toBe(false);
		expect(sponsor.spinner_verbs_written).toEqual([]);
	});

	it("status --json on a fresh project falls back to telemetry:true and install_id:null", async () => {
		const logSpy = vi.mocked(console.log);
		logSpy.mockClear();
		await sponsorStatusAction({ json: true }, { cwd, claudeSettingsPath: settingsPath });
		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		const parsed = JSON.parse(printed) as {
			enabled: boolean;
			telemetry: boolean;
			install_id: string | null;
		};
		expect(parsed.enabled).toBe(false);
		expect(parsed.telemetry).toBe(true);
		expect(parsed.install_id).toBeNull();
	});

	it("status (non-json) reports telemetry off when disabled in config", async () => {
		await sponsorEnableAction({}, { cwd, claudeSettingsPath: settingsPath });
		const cfgBefore = localConfig();
		writeFileSync(
			join(cwd, ".interlinked", "config.local.json"),
			JSON.stringify({ ...cfgBefore, sponsor: { ...(cfgBefore.sponsor as object), telemetry: false } }),
		);
		const logSpy = vi.mocked(console.log);
		logSpy.mockClear();
		await sponsorStatusAction({}, { cwd, claudeSettingsPath: settingsPath });
		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("telemetry: off");
	});

	it("status (non-json) omits the creative text when the live status file has no text= line", async () => {
		await sponsorEnableAction({}, { cwd, claudeSettingsPath: settingsPath });
		writeFileSync(join(cwd, ".interlinked", SPONSOR_STATUS_FILE), "enabled=1\ncreative=alpha\n");
		const logSpy = vi.mocked(console.log);
		logSpy.mockClear();
		await sponsorStatusAction({}, { cwd, claudeSettingsPath: settingsPath });
		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("showing: alpha — ");
	});

	it("disable reports when settings.json is not parseable so verbs can't be removed", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const fetchImpl = (async () => ({ ok: true, text: async () => wire })) as unknown as typeof fetch;
		await sponsorEnableAction(
			{ spinner: true },
			{ cwd, claudeSettingsPath: settingsPath, fetchImpl },
		);
		// Corrupt settings.json AFTER the verb was written, then disable.
		writeFileSync(settingsPath, "{ not valid json");
		const errSpy = vi.mocked(console.error);
		errSpy.mockClear();
		await sponsorDisableAction({}, { cwd, claudeSettingsPath: settingsPath });
		const printed = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("Spinner verbs not removed: settings.json not parseable — left untouched");
	});
});
