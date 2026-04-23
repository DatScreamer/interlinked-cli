// ===========================================
// Cloud escalation — conservative merge of cloud verdict over local decision
// ===========================================
// Per `docs/design/free-cli-architecture.md` §10: cloud can only TIGHTEN the
// verdict, never loosen. When a check declares `escalation.mcp_method` and
// cloud is opted in, the daemon invokes the Portal after running the local
// check; this module implements the merge.
//
// The actual Portal call is the caller's responsibility — we take the cloud
// response as input and merge it with the local decision. Keeps the
// escalation layer testable without a live Portal.

import type { HarnessDecision } from "./types.js";

export interface CloudVerdict {
	decision: "allow" | "ask" | "deny";
	reason?: string;
	additional_context?: string;
	receipt_id?: string;
}

/** Merge a cloud verdict over a local decision. Conservative: the result is
 *  the STRICTER of the two. deny > ask > allow. Local "block" is treated as
 *  deny for comparison. */
export function mergeCloudVerdict(local: HarnessDecision, cloud: CloudVerdict): HarnessDecision {
	const localRank = rankDecision(local.decision);
	const cloudRank = rankCloud(cloud.decision);
	const strictest = Math.max(localRank, cloudRank);
	const merged: HarnessDecision = {
		...local,
		decision: decisionFromRank(strictest),
		telemetry_receipt_id: cloud.receipt_id ?? local.telemetry_receipt_id,
	};
	if (strictest === cloudRank && cloud.reason) {
		merged.reason = cloud.reason;
	}
	if (cloud.additional_context) {
		merged.additional_context = mergeContext(
			local.additional_context,
			cloud.additional_context,
		);
	}
	return merged;
}

function rankDecision(d: HarnessDecision["decision"]): number {
	switch (d) {
		case "allow":
			return 0;
		case "ask":
			return 1;
		case "block":
			return 2;
	}
}

function rankCloud(d: CloudVerdict["decision"]): number {
	switch (d) {
		case "allow":
			return 0;
		case "ask":
			return 1;
		case "deny":
			return 2;
	}
}

function decisionFromRank(r: number): HarnessDecision["decision"] {
	if (r === 0) return "allow";
	if (r === 1) return "ask";
	return "block";
}

function mergeContext(a: string | undefined, b: string): string {
	if (!a) return b;
	return `${a}\n---\n${b}`;
}

/** Apply a cloud verdict with a hard budget. If the cloud call exceeds the
 *  budget, return the local decision unchanged and append a warning. Exposed
 *  so the daemon can wire this without reinventing the timing semantics. */
export async function applyEscalationWithBudget(
	local: HarnessDecision,
	cloudCall: () => Promise<CloudVerdict>,
	budgetMs: number,
): Promise<HarnessDecision> {
	const result = await runWithBudget(cloudCall, budgetMs);
	if (!result.ok) {
		return {
			...local,
			warnings: [
				...(local.warnings ?? []),
				`[interlinked] cloud escalation exceeded ${budgetMs}ms; using local verdict`,
			],
		};
	}
	return mergeCloudVerdict(local, result.verdict);
}

async function runWithBudget(
	fn: () => Promise<CloudVerdict>,
	budgetMs: number,
): Promise<{ ok: true; verdict: CloudVerdict } | { ok: false; reason: string }> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve({ ok: false, reason: "timeout" });
		}, budgetMs);
		fn().then(
			(verdict) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve({ ok: true, verdict });
			},
			(err: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve({ ok: false, reason: err.message });
			},
		);
	});
}
