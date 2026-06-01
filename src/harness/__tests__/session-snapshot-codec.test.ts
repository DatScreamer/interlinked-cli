import { describe, expect, it } from "vitest";
import {
	readActiveSkills,
	readCapturedPlan,
	readGitSessionBaseline,
	readSensitivity,
	readStringSet,
	readTaintSources,
	readTddCycles,
	serializeCapturedPlan,
} from "../session-snapshot-codec.js";
import type { CapturedPlan } from "../types/plan.js";

// The snapshot-codec module holds the defensive coercion + serialize helpers
// lifted verbatim out of session-state.ts. SessionTracker.serialize/hydrate
// delegate to these; the full round-trip is exercised in
// session-state-roundtrip.test.ts. Here we pin the individual coercions so a
// regression in the codec surfaces against the codec, not three layers up.

describe("readSensitivity", () => {
	it("passes through a valid level", () => {
		expect(readSensitivity("Confidential")).toBe("Confidential");
	});

	it("defaults unknown / malformed values to Public", () => {
		expect(readSensitivity("Bogus")).toBe("Public");
		expect(readSensitivity(42)).toBe("Public");
		expect(readSensitivity(undefined)).toBe("Public");
	});
});

describe("readStringSet", () => {
	it("builds a Set from a string array, dropping non-strings", () => {
		const s = readStringSet(["a", 1, "b", null, "a"]);
		expect([...s].sort()).toEqual(["a", "b"]);
	});

	it("returns an empty Set for non-arrays", () => {
		expect(readStringSet("nope").size).toBe(0);
		expect(readStringSet(undefined).size).toBe(0);
	});
});

describe("readTaintSources", () => {
	it("coerces a well-formed source and defaults provenance", () => {
		const out = readTaintSources([
			{ file: "src/a.ts", level: "Confidential", at_step: 4 },
		]);
		expect(out).toHaveLength(1);
		expect(out[0]).toEqual({
			file: "src/a.ts",
			level: "Confidential",
			at_step: 4,
			provenance: "local_read",
		});
	});

	it("drops entries without a file", () => {
		expect(readTaintSources([{ level: "Public", at_step: 0 }])).toHaveLength(0);
	});
});

describe("readTddCycles", () => {
	it("defaults an unknown state to no_test", () => {
		const out = readTddCycles({
			"src/a.ts": { source_file: "src/a.ts", state: "weird" },
		});
		expect(out.get("src/a.ts")?.state).toBe("no_test");
	});

	it("preserves a valid state", () => {
		const out = readTddCycles({
			"src/a.ts": { source_file: "src/a.ts", state: "green" },
		});
		expect(out.get("src/a.ts")?.state).toBe("green");
	});
});

describe("readGitSessionBaseline", () => {
	it("round-trips a serialized baseline", () => {
		const b = readGitSessionBaseline({
			head_sha: "abc123",
			modified: ["m.ts"],
			staged: ["s.ts"],
			untracked: ["u.ts"],
		});
		expect(b?.head_sha).toBe("abc123");
		expect(b?.modified.has("m.ts")).toBe(true);
		expect(b?.staged.has("s.ts")).toBe(true);
		expect(b?.untracked.has("u.ts")).toBe(true);
	});

	it("returns undefined for a non-object", () => {
		expect(readGitSessionBaseline(null)).toBeUndefined();
	});
});

describe("readActiveSkills", () => {
	it("returns undefined for an empty object (no markers)", () => {
		expect(readActiveSkills({})).toBeUndefined();
	});

	it("coerces a marker and defaults an unknown source to cli", () => {
		const out = readActiveSkills({
			ship: { name: "ship", entered_at: 1, expires_at: 2, source: "bogus" },
		});
		expect(out?.get("ship")?.source).toBe("cli");
		expect(out?.get("ship")?.expires_at).toBe(2);
	});
});

describe("serializeCapturedPlan / readCapturedPlan round-trip", () => {
	const plan: CapturedPlan = {
		session_id: "s1",
		agent_name: "agent",
		created_at_iso: "2026-05-27T00:00:00.000Z",
		created_at_step: 3,
		source: "ExitPlanMode",
		steps: [
			{ intent: "write tests", tool_hint: "Write", target_hint: "a.test.ts", status: "pending" },
			{ intent: "implement", status: "executed" },
		],
	};

	it("serializes then reads back to an equivalent plan", () => {
		const json = serializeCapturedPlan(plan);
		const back = readCapturedPlan(json);
		expect(back?.session_id).toBe("s1");
		expect(back?.source).toBe("ExitPlanMode");
		expect(back?.steps).toHaveLength(2);
		expect(back?.steps[0]?.tool_hint).toBe("Write");
		expect(back?.steps[1]?.status).toBe("executed");
	});

	it("defaults an unknown source to TaskCreate", () => {
		const back = readCapturedPlan({ ...serializeCapturedPlan(plan), source: "nope" });
		expect(back?.source).toBe("TaskCreate");
	});

	it("returns undefined for a malformed plan (missing required fields)", () => {
		expect(readCapturedPlan({ steps: [] })).toBeUndefined();
		expect(readCapturedPlan(null)).toBeUndefined();
	});
});
