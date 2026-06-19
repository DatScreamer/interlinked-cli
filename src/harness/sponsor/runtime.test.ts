import { sign as edSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BEACON_FILE, DEFAULT_FEED_URL, SPONSOR_STATUS_FILE } from "./feed-client.js";
import {
	readSponsorSettingsFromConfig,
	type SponsorRuntimeSettings,
	startSponsorRuntime,
} from "./runtime.js";
import { ROTATION_WINDOW_MS, type SponsorFeed } from "./types.js";

const T0 = Date.parse("2026-06-12T00:00:05Z");

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

interface Call {
	url: string;
	body: string | undefined;
}

function makeFetchStub(wire: string, calls: Call[]): typeof fetch {
	return (async (url: unknown, init?: { body?: unknown }) => {
		const u = String(url);
		calls.push({ url: u, body: init?.body === undefined ? undefined : String(init.body) });
		if (u.endsWith("/v1/feed")) {
			return { ok: true, text: async () => wire } as Response;
		}
		return { ok: true, text: async () => "" } as Response;
	}) as typeof fetch;
}

describe("readSponsorSettingsFromConfig", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sponsor-cfg-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns disabled settings when config or sponsor block is missing", () => {
		expect(readSponsorSettingsFromConfig(dir)?.enabled).toBe(false);
		writeFileSync(join(dir, "config.local.json"), JSON.stringify({ sync_mode: "local" }));
		expect(readSponsorSettingsFromConfig(dir)?.enabled).toBe(false);
	});

	it("maps an enabled block, defaulting the feed url and gating telemetry on install_id", () => {
		writeFileSync(
			join(dir, "config.local.json"),
			JSON.stringify({ install_id: "inst-9", sponsor: { enabled: true } }),
		);
		const s = readSponsorSettingsFromConfig(dir);
		expect(s).toEqual({
			enabled: true,
			feedUrl: DEFAULT_FEED_URL,
			telemetry: true,
			installId: "inst-9",
		});
		// No install id ⇒ telemetry forced off (no identity, no beacons).
		writeFileSync(
			join(dir, "config.local.json"),
			JSON.stringify({ sponsor: { enabled: true, feed_url: "https://x.example/v1/feed" } }),
		);
		const s2 = readSponsorSettingsFromConfig(dir);
		expect(s2?.telemetry).toBe(false);
		expect(s2?.feedUrl).toBe("https://x.example/v1/feed");
	});

	it("returns null on malformed config rather than throwing", () => {
		writeFileSync(join(dir, "config.local.json"), "{nope");
		expect(readSponsorSettingsFromConfig(dir)).toBeNull();
	});
});

describe("startSponsorRuntime", () => {
	let dir: string;
	let savedEnv: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sponsor-rt-"));
		savedEnv = process.env.INTERLINKED_SPONSOR_PUBKEY;
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		if (savedEnv === undefined) delete process.env.INTERLINKED_SPONSOR_PUBKEY;
		else process.env.INTERLINKED_SPONSOR_PUBKEY = savedEnv;
	});

	function settings(overrides: Partial<SponsorRuntimeSettings> = {}): SponsorRuntimeSettings {
		return {
			enabled: true,
			feedUrl: "https://w.example/v1/feed",
			telemetry: true,
			installId: "inst-1",
			...overrides,
		};
	}

	it("writes a disabled status and never fetches when the flag is off", async () => {
		const calls: Call[] = [];
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings({ enabled: false }),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub("{}", calls),
			now: () => T0,
		});
		await rt.tick();
		rt.dispose();
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("enabled=0");
		expect(calls).toHaveLength(0);
	});

	it("fetches, verifies, renders, and counts one impression per window", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const calls: Call[] = [];
		let now = T0;
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub(wire, calls),
			now: () => now,
		});
		await rt.tick();
		await rt.tick(); // same window — no second impression
		const status = readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8");
		expect(status).toContain("enabled=1");
		expect(status).toContain("creative=alpha");
		expect(status).toContain("url=https://w.example/v1/c/alpha?i=inst-1");
		const rows = readFileSync(join(dir, BEACON_FILE), "utf8").trim().split("\n");
		expect(rows).toHaveLength(1);
		now = T0 + ROTATION_WINDOW_MS; // next window — one more impression...
		await rt.tick();
		rt.dispose();
		// ...which also crosses the flush interval: both buffered impressions
		// go out in one POST and the buffer truncates.
		const beaconPosts = calls.filter((c) => c.url.endsWith("/v1/beacon"));
		expect(beaconPosts).toHaveLength(1);
		expect(JSON.parse(beaconPosts[0]?.body ?? "{}").beacons).toHaveLength(2);
		expect(readFileSync(join(dir, BEACON_FILE), "utf8")).toBe("");
	});

	it("renders without beaconing when there is no recent activity or telemetry is off", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const callsIdle: Call[] = [];
		const idle = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => false,
			fetchImpl: makeFetchStub(wire, callsIdle),
			now: () => T0,
		});
		await idle.tick();
		idle.dispose();
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("enabled=1");
		expect(() => readFileSync(join(dir, BEACON_FILE), "utf8")).toThrow();

		// telemetry off: direct creative URL, no install id, no beacons.
		const dir2 = mkdtempSync(join(tmpdir(), "sponsor-rt2-"));
		const noTel = startSponsorRuntime({
			interlinkedDir: dir2,
			readSettings: () => settings({ telemetry: false }),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub(wire, []),
			now: () => T0,
		});
		await noTel.tick();
		noTel.dispose();
		const st = readFileSync(join(dir2, SPONSOR_STATUS_FILE), "utf8");
		expect(st).toContain("url=https://alpha.example");
		expect(() => readFileSync(join(dir2, BEACON_FILE), "utf8")).toThrow();
		rmSync(dir2, { recursive: true, force: true });
	});

	it("falls back to the verified disk cache when the network fails", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		// Seed the cache via a successful run.
		const okCalls: Call[] = [];
		const seed = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => false,
			fetchImpl: makeFetchStub(wire, okCalls),
			now: () => T0,
		});
		await seed.tick();
		seed.dispose();
		// Fresh runtime, dead network.
		const dead = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => false,
			fetchImpl: dead,
			now: () => T0,
		});
		await rt.tick();
		rt.dispose();
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("creative=alpha");
	});

	it("flushes buffered beacons once the flush interval elapses", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const calls: Call[] = [];
		let now = T0;
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub(wire, calls),
			now: () => now,
		});
		await rt.tick(); // impression buffered
		now = T0 + 6 * 60 * 1000; // past the 5-minute flush interval
		await rt.tick();
		rt.dispose();
		const beaconPosts = calls.filter((c) => c.url.endsWith("/v1/beacon"));
		expect(beaconPosts).toHaveLength(1);
		expect(JSON.parse(beaconPosts[0]?.body ?? "{}").beacons.length).toBeGreaterThan(0);
		expect(readFileSync(join(dir, BEACON_FILE), "utf8")).toBe("");
	});
});
