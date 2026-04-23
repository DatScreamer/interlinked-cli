import { describe, expect, it } from "vitest";
import {
	applyEscalationWithBudget,
	type CloudVerdict,
	mergeCloudVerdict,
} from "./cloud-escalation.js";
import type { HarnessDecision } from "./types.js";

describe("mergeCloudVerdict — conservative override", () => {
	it("cloud can tighten allow → ask", () => {
		const local: HarnessDecision = { decision: "allow" };
		const cloud: CloudVerdict = { decision: "ask", reason: "confirm" };
		const merged = mergeCloudVerdict(local, cloud);
		expect(merged.decision).toBe("ask");
		expect(merged.reason).toBe("confirm");
	});

	it("cloud can tighten allow → deny", () => {
		const local: HarnessDecision = { decision: "allow" };
		const cloud: CloudVerdict = { decision: "deny", reason: "unsafe" };
		const merged = mergeCloudVerdict(local, cloud);
		expect(merged.decision).toBe("block");
		expect(merged.reason).toBe("unsafe");
	});

	it("cloud cannot loosen block → allow", () => {
		const local: HarnessDecision = { decision: "block", reason: "local said no" };
		const cloud: CloudVerdict = { decision: "allow" };
		const merged = mergeCloudVerdict(local, cloud);
		expect(merged.decision).toBe("block");
		expect(merged.reason).toBe("local said no");
	});

	it("propagates cloud receipt_id", () => {
		const local: HarnessDecision = { decision: "allow" };
		const cloud: CloudVerdict = { decision: "allow", receipt_id: "rcpt_x" };
		const merged = mergeCloudVerdict(local, cloud);
		expect(merged.telemetry_receipt_id).toBe("rcpt_x");
	});

	it("merges additional_context from both tiers", () => {
		const local: HarnessDecision = { decision: "allow", additional_context: "local note" };
		const cloud: CloudVerdict = { decision: "allow", additional_context: "cloud note" };
		const merged = mergeCloudVerdict(local, cloud);
		expect(merged.additional_context).toBe("local note\n---\ncloud note");
	});
});

describe("applyEscalationWithBudget", () => {
	it("returns merged verdict when cloud responds in time", async () => {
		const local: HarnessDecision = { decision: "allow" };
		const verdict: CloudVerdict = { decision: "ask", reason: "cloud" };
		const out = await applyEscalationWithBudget(local, async () => verdict, 1000);
		expect(out.decision).toBe("ask");
		expect(out.reason).toBe("cloud");
	});

	it("falls back to local on budget exceeded", async () => {
		const local: HarnessDecision = { decision: "allow" };
		const slow = async (): Promise<CloudVerdict> =>
			new Promise((r) => setTimeout(() => r({ decision: "deny" }), 500));
		const out = await applyEscalationWithBudget(local, slow, 50);
		expect(out.decision).toBe("allow");
		expect(out.warnings?.some((w) => w.includes("cloud escalation exceeded"))).toBe(true);
	});

	it("falls back to local on cloud error", async () => {
		const local: HarnessDecision = { decision: "allow" };
		const broken = async (): Promise<CloudVerdict> => {
			throw new Error("oops");
		};
		const out = await applyEscalationWithBudget(local, broken, 1000);
		expect(out.decision).toBe("allow");
		expect(out.warnings?.some((w) => w.includes("cloud escalation exceeded"))).toBe(true);
	});
});
