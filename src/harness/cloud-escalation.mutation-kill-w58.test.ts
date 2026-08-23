import { describe, expect, it } from "vitest";
import { applyEscalationWithBudget, mergeCloudVerdict } from "./cloud-escalation.js";
import type { HarnessDecision } from "./types.js";

function local(decision: HarnessDecision["decision"], extra: Partial<HarnessDecision> = {}): HarnessDecision {
	return { decision, ...extra };
}

const TIMEOUT_SENTINEL = "TIMEOUT_SENTINEL" as const;

function delay<T>(ms: number, value: T): Promise<T> {
	return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("mergeCloudVerdict — reason overwrite condition (strictest === cloudRank && cloud.reason)", () => {
	it("P1: does NOT overwrite reason when local is stricter than cloud, even if cloud.reason is set", () => {
		// test-contract: public-api — mergeCloudVerdict only adopts cloud.reason when cloud is the
		// strictest side; local=block outranks cloud=allow, so the local reason must survive.
		const merged = mergeCloudVerdict(
			local("block", { reason: "local reason" }),
			{ decision: "allow", reason: "cloud reason" },
		);
		expect(merged.reason).toBe("local reason");
	});

	it("P2: ConditionalExpression true — an always-true guard would overwrite reason with an undefined cloud.reason", () => {
		// test-contract: public-api — local=block (rank2) outranks cloud=allow (rank0) with no
		// cloud.reason at all; the strictest===cloudRank && cloud.reason guard must stay false so the
		// original local reason is preserved rather than clobbered by `merged.reason = cloud.reason`.
		const merged = mergeCloudVerdict(local("block", { reason: "keep me" }), { decision: "allow" });
		expect(merged.reason).toBe("keep me");
	});

	it("P3: additional_context only merges when cloud.additional_context is truthy", () => {
		// test-contract: public-api — cloud carries no additional_context, so mergeCloudVerdict must
		// leave the local additional_context exactly as-is (an always-true guard would corrupt it via
		// mergeContext(local, undefined)).
		const merged = mergeCloudVerdict(
			local("allow", { additional_context: "local ctx" }),
			{ decision: "allow" },
		);
		expect(merged.additional_context).toBe("local ctx");
	});
});

describe("mergeCloudVerdict — rankDecision/rankCloud/decisionFromRank switch integrity", () => {
	it("P4: local=allow, cloud=allow merges to allow (rank 0 round-trips through rankDecision/rankCloud/decisionFromRank)", () => {
		// test-contract: public-api — the documented result of mergeCloudVerdict's decision field.
		const merged = mergeCloudVerdict(local("allow"), { decision: "allow" });
		expect(merged.decision).toBe("allow");
	});

	it('P5: local=ask, cloud=allow merges to ask (rankDecision\'s "ask" case must match)', () => {
		// test-contract: public-api — ask (rank1) outranks the cloud's allow (rank0), so the merged
		// decision must stay "ask"; if rankDecision fails to match "ask" it falls through to NaN and
		// decisionFromRank's default branch reports "block" instead.
		const merged = mergeCloudVerdict(local("ask"), { decision: "allow" });
		expect(merged.decision).toBe("ask");
	});

	it('P6: local=block tied with cloud=deny overwrites reason with cloud\'s, proving rankDecision("block") is exactly rank 2', () => {
		// test-contract: public-api — only a real tie (both rank 2) triggers the reason overwrite; if
		// rankDecision's "block" case fails to return 2, strictest becomes NaN and NaN===cloudRank(2)
		// is false, so the reason overwrite would not happen.
		const merged = mergeCloudVerdict(
			local("block", { reason: "orig reason" }),
			{ decision: "deny", reason: "cloud reason" },
		);
		expect(merged.decision).toBe("block");
		expect(merged.reason).toBe("cloud reason");
	});
});

describe("mergeCloudVerdict — mergeContext falsy-a branch", () => {
	it("P7: when local has no additional_context, merged context is exactly the cloud context, not a concatenation with undefined", () => {
		// test-contract: public-api — mergeContext's documented falsy-a shortcut returns b verbatim.
		const merged = mergeCloudVerdict(local("allow"), {
			decision: "allow",
			additional_context: "cloud ctx",
		});
		expect(merged.additional_context).toBe("cloud ctx");
	});
});

describe("applyEscalationWithBudget — warnings array default and timeout path", () => {
	it("P8: on timeout with no prior local.warnings, the merged warnings array has exactly one entry", async () => {
		// test-contract: public-api — `local.warnings ?? []` must start from an empty array, not a
		// seeded placeholder array, when local carried no warnings of its own.
		const result = await applyEscalationWithBudget(
			local("allow"),
			() => new Promise(() => {}), // never resolves — forces the timeout branch
			15,
		);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings?.[0]).toContain("cloud escalation exceeded 15ms");
		expect(result.decision).toBe("allow");
	});

	it("P9: a fast successful cloudCall resolves promptly (does not hang) and merges the cloud verdict", async () => {
		// test-contract: bug — an always-true `if (settled) return;` guard on the success path would
		// return before ever calling resolve(), leaving applyEscalationWithBudget's promise pending
		// forever. Racing against a short sentinel delay turns that hang into a failing assertion.
		const racer: Promise<HarnessDecision | typeof TIMEOUT_SENTINEL> = Promise.race([
			applyEscalationWithBudget(local("allow"), () => Promise.resolve({ decision: "ask" }), 2000),
			delay(500, TIMEOUT_SENTINEL),
		]);
		const result = await racer;
		expect(result).not.toBe(TIMEOUT_SENTINEL);
		if (result === TIMEOUT_SENTINEL) throw new Error("unreachable"); // SAFETY: ruled out by the assertion above
		expect(result.decision).toBe("ask");
	});

	it("P10: a fast-rejecting cloudCall resolves promptly and falls back to the local decision", async () => {
		// test-contract: bug — an always-true `if (settled) return;` guard on the reject path (or the
		// reject handler's body being dropped entirely) would skip resolve() on rejection, so the
		// promise would only ever settle via the timeout branch. Racing against a short sentinel delay
		// turns that latency regression into a failing assertion.
		const racer: Promise<HarnessDecision | typeof TIMEOUT_SENTINEL> = Promise.race([
			applyEscalationWithBudget(local("allow"), () => Promise.reject(new Error("boom")), 2000),
			delay(500, TIMEOUT_SENTINEL),
		]);
		const result = await racer;
		expect(result).not.toBe(TIMEOUT_SENTINEL);
		if (result === TIMEOUT_SENTINEL) throw new Error("unreachable"); // SAFETY: ruled out by the assertion above
		expect(result.decision).toBe("allow");
	});
});
