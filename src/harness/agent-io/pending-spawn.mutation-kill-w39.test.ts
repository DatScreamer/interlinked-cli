import { describe, it, expect, beforeEach } from "vitest";
import {
	rememberPendingSpawn,
	claimPendingSpawn,
	resetPendingSpawns,
	pendingSpawnCount,
	MAX_PENDING_SPAWNS,
	type PendingSpawn,
} from "./pending-spawn.js";

function spawn(session: string | null, subagentType: string | null): PendingSpawn {
	return { session, subagentType, toolUseId: null, ts: "2026-01-01T00:00:00Z" };
}

// This MUST run before anything else touches module state — it observes the
// module's initial array literal, which mutant 07d7d483e20cb7fe poisons.
describe("module init (run first, no reset)", () => {
	// test-contract: invariant — kills ArrayDeclaration mutant on the module-level `pending` initializer
	it("pending registry starts with zero rows", () => {
		expect(pendingSpawnCount()).toBe(0);
	});
});

describe("pending-spawn mutation kills", () => {
	beforeEach(() => {
		resetPendingSpawns();
	});

	// test-contract: invariant — kills EqualityOperator/ConditionalExpression-false mutants on the cap check
	it("trims the registry back down to the cap once it is exceeded", () => {
		for (let i = 0; i < MAX_PENDING_SPAWNS + 3; i++) {
			rememberPendingSpawn(spawn(`s${i}`, null));
		}
		expect(pendingSpawnCount()).toBe(MAX_PENDING_SPAWNS);
	});

	// test-contract: invariant — kills the session-equality guard mutated to false
	it("does not match a spawn from a different session", () => {
		rememberPendingSpawn(spawn("session-B", null));
		rememberPendingSpawn(spawn("session-A", null));
		const claimed = claimPendingSpawn("session-A", null);
		expect(claimed?.session).toBe("session-A");
		expect(pendingSpawnCount()).toBe(1); // session-B row untouched
	});

	// test-contract: invariant — kills the full mismatch-condition mutant collapsed to false
	it("rejects a candidate whose subagentType differs from the requested agentType", () => {
		rememberPendingSpawn(spawn("s1", "foo"));
		const claimed = claimPendingSpawn("s1", "bar");
		expect(claimed).toBeNull();
		expect(pendingSpawnCount()).toBe(1); // never claimed, still pending
	});

	// test-contract: invariant — kills the (subagentType!==null && agentType!==null) subexpression
	// mutated to true/||/true, and the subagentType!==null term flipped to ===null
	it("an untyped pending spawn matches any requested agentType", () => {
		rememberPendingSpawn(spawn("s1", null));
		const claimed = claimPendingSpawn("s1", "bar");
		expect(claimed).not.toBeNull();
		expect(claimed?.subagentType).toBeNull();
	});

	// test-contract: invariant — kills the agentType!==null term flipped to true/===null
	it("a typed pending spawn matches an unspecified (null) requested agentType", () => {
		rememberPendingSpawn(spawn("s1", "foo"));
		const claimed = claimPendingSpawn("s1", null);
		expect(claimed).not.toBeNull();
		expect(claimed?.subagentType).toBe("foo");
	});
});
