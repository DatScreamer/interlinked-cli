// Red-team F4 (docs/design/red-team-findings-2026-08-09.md): a daemon restart
// zeroed the live trajectory state mid-session, so every read from before the
// restart was forgotten while the session kept editing — and
// `reb_blind_edit_unread_file` fired on files the agent HAD read. Measured
// repeatedly during the 2026-08-09 session, which restarted after every build.
//
// The session's own `files_read` survives a restart (it is serialized into the
// `<id>.live.json` snapshot and hydrated). Only the trajectory detector's
// step-indexed `fileReadSteps` is dropped, because the detector is runtime-only
// and rebuilt empty. Seeding it from the surviving read set restores the fact
// the rules actually need ("was this file read this session"); the exact step
// index is not recoverable and not required.

import { describe, expect, it } from "vitest";
import { createState } from "./state.js";
import { seedReadsFromSession } from "./rehydrate.js";

describe("seedReadsFromSession — positive (must seed)", () => {
	it("P1: a hydrated read set repopulates fileReadSteps", () => {
		const state = createState("s1");
		seedReadsFromSession(state, ["/repo/src/a.ts", "/repo/src/b.ts"]);
		expect(state.fileReadSteps.has("/repo/src/a.ts")).toBe(true);
		expect(state.fileReadSteps.has("/repo/src/b.ts")).toBe(true);
	});

	it("P2: seeded reads count as orientation, so cold-start rules stay quiet", () => {
		const state = createState("s2");
		seedReadsFromSession(state, ["/repo/src/a.ts"]);
		expect(state.readCount).toBeGreaterThan(0);
	});

	it("P3: seeded steps are 0 — pre-restart reads are older than anything this process saw", () => {
		const state = createState("s3");
		seedReadsFromSession(state, ["/repo/src/a.ts"]);
		expect(state.fileReadSteps.get("/repo/src/a.ts")).toBe(0);
	});
});

describe("seedReadsFromSession — negative (must not distort live state)", () => {
	it("N1: an empty read set changes nothing", () => {
		const state = createState("s4");
		seedReadsFromSession(state, []);
		expect(state.fileReadSteps.size).toBe(0);
		expect(state.readCount).toBe(0);
	});

	it("N2: seeding never overwrites a read this process already observed", () => {
		const state = createState("s5");
		state.stepCount = 7;
		state.fileReadSteps.set("/repo/src/a.ts", 7);
		seedReadsFromSession(state, ["/repo/src/a.ts"]);
		expect(state.fileReadSteps.get("/repo/src/a.ts")).toBe(7);
	});

	it("N3: seeding is idempotent — a second call does not inflate readCount", () => {
		const state = createState("s6");
		seedReadsFromSession(state, ["/repo/src/a.ts"]);
		const after = state.readCount;
		seedReadsFromSession(state, ["/repo/src/a.ts"]);
		expect(state.readCount).toBe(after);
	});
});
