// ===========================================
// Supervisor spawn backoff
// ===========================================
// The startup mutex collapsed N SIMULTANEOUS starts into one. It did nothing
// about N SEQUENTIAL ones: every blocked call still asked the supervisor to
// spawn, so a daemon that could not stay up was respawned once per blocked
// call. These cases pin the decay, and pin that one successful RPC clears it.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readSupervisorBackoff,
	recordSupervisorSpawn,
	resetSupervisorBackoff,
	SUPERVISOR_BACKOFF_MAX_MS,
	SUPERVISOR_BACKOFF_MIN_MS,
	supervisorBackoffDelayMs,
	supervisorBackoffPath,
	supervisorSpawnAllowed,
} from "./supervisor-backoff.js";

const T0 = 1_700_000_000_000;
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "il-backoff-"));
	mkdirSync(join(root, ".interlinked"), { recursive: true });
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("supervisorBackoffDelayMs — positive (must fire: the ladder doubles)", () => {
	it("P1: the first attempt is immediate — a healthy daemon comes straight back", () => {
		expect(supervisorBackoffDelayMs(0)).toBe(0);
	});

	it("P2: one failed attempt costs the minimum wait", () => {
		expect(supervisorBackoffDelayMs(1)).toBe(SUPERVISOR_BACKOFF_MIN_MS);
	});

	it("P3: each further attempt doubles", () => {
		expect(supervisorBackoffDelayMs(2)).toBe(SUPERVISOR_BACKOFF_MIN_MS * 2);
		expect(supervisorBackoffDelayMs(3)).toBe(SUPERVISOR_BACKOFF_MIN_MS * 4);
	});

	it("P4: the doubling stops at the ceiling", () => {
		expect(supervisorBackoffDelayMs(20)).toBe(SUPERVISOR_BACKOFF_MAX_MS);
		expect(supervisorBackoffDelayMs(5_000)).toBe(SUPERVISOR_BACKOFF_MAX_MS);
	});
});

describe("supervisorBackoffDelayMs — negative (must not fire)", () => {
	it("N1: a negative counter never produces a negative wait", () => {
		expect(supervisorBackoffDelayMs(-5)).toBe(0);
	});

	it("N2: a huge counter never overflows past the ceiling", () => {
		expect(Number.isFinite(supervisorBackoffDelayMs(Number.MAX_SAFE_INTEGER))).toBe(true);
		expect(supervisorBackoffDelayMs(Number.MAX_SAFE_INTEGER)).toBe(SUPERVISOR_BACKOFF_MAX_MS);
	});
});

describe("supervisorSpawnAllowed — positive (must fire: allow)", () => {
	it("P1: no recorded state means spawn now", () => {
		expect(supervisorSpawnAllowed(root, T0)).toBe(true);
	});

	it("P2: allowed again once the decaying interval has elapsed", () => {
		recordSupervisorSpawn(root, T0);
		expect(supervisorSpawnAllowed(root, T0 + SUPERVISOR_BACKOFF_MIN_MS)).toBe(true);
	});

	it("P3: a successful RPC resets the ladder, so the next spawn is immediate", () => {
		recordSupervisorSpawn(root, T0);
		recordSupervisorSpawn(root, T0 + 1);
		recordSupervisorSpawn(root, T0 + 2);
		resetSupervisorBackoff(root);
		expect(readSupervisorBackoff(root)).toBeNull();
		expect(supervisorSpawnAllowed(root, T0 + 3)).toBe(true);
	});
});

describe("supervisorSpawnAllowed — negative (must not fire: throttle)", () => {
	it("N1: a second spawn inside the minimum wait is refused", () => {
		recordSupervisorSpawn(root, T0);
		expect(supervisorSpawnAllowed(root, T0 + SUPERVISOR_BACKOFF_MIN_MS - 1)).toBe(false);
	});

	it("N2: repeated failures widen the window — the storm's sequential half", () => {
		recordSupervisorSpawn(root, T0);
		recordSupervisorSpawn(root, T0 + SUPERVISOR_BACKOFF_MIN_MS);
		// Two attempts recorded → the next wait is 2x the minimum.
		expect(supervisorSpawnAllowed(root, T0 + SUPERVISOR_BACKOFF_MIN_MS * 2)).toBe(false);
		expect(supervisorSpawnAllowed(root, T0 + SUPERVISOR_BACKOFF_MIN_MS * 3)).toBe(true);
	});

	it("N3: a last_spawn_at in the FUTURE waits rather than spawning", () => {
		writeFileSync(
			supervisorBackoffPath(root),
			JSON.stringify({ attempts: 1, last_spawn_at: T0 + 60_000 }),
		);
		expect(supervisorSpawnAllowed(root, T0)).toBe(false);
	});

	it("N4: a garbage state file degrades to 'allow', never to a throw", () => {
		writeFileSync(supervisorBackoffPath(root), "{not json");
		expect(readSupervisorBackoff(root)).toBeNull();
		expect(supervisorSpawnAllowed(root, T0)).toBe(true);
	});

	it("N5: a non-finite counter is rejected rather than trusted", () => {
		writeFileSync(supervisorBackoffPath(root), '{"attempts":null,"last_spawn_at":1}');
		expect(readSupervisorBackoff(root)).toBeNull();
	});
});

describe("recordSupervisorSpawn — dry_run (a probe must not move real state)", () => {
	it("P1: a real spawn increments the counter and stamps the time", () => {
		recordSupervisorSpawn(root, T0);
		expect(readSupervisorBackoff(root)).toEqual({ attempts: 1, last_spawn_at: T0 });
		recordSupervisorSpawn(root, T0 + 99);
		expect(readSupervisorBackoff(root)).toEqual({ attempts: 2, last_spawn_at: T0 + 99 });
	});

	it("N1: a dry-run spawn writes nothing at all", () => {
		recordSupervisorSpawn(root, T0, { dryRun: true });
		expect(readSupervisorBackoff(root)).toBeNull();
	});

	it("N2: a dry-run spawn does not disturb existing state", () => {
		recordSupervisorSpawn(root, T0);
		recordSupervisorSpawn(root, T0 + 500, { dryRun: true });
		expect(readSupervisorBackoff(root)).toEqual({ attempts: 1, last_spawn_at: T0 });
		expect(JSON.parse(readFileSync(supervisorBackoffPath(root), "utf-8"))).toEqual({
			attempts: 1,
			last_spawn_at: T0,
		});
	});

	it("N3: resetting when nothing was recorded is a silent no-op", () => {
		expect(() => resetSupervisorBackoff(root)).not.toThrow();
	});
});
