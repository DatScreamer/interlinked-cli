// ===========================================
// Per-edit mutation — sharded runner
// ===========================================
// Fans one file's measurement out across N runners, each measuring a contiguous
// line range, then merges the results into a single verdict.
//
// A fixed per-edit budget bounds how much mutation work can finish before the
// gate must answer. Partitioning the file across runners is how that budget buys
// more mutants: N runners cover N slices in the wall-clock of the slowest one.
//
// DEGRADATION IS THE POINT. A peer being down, slow, or missing must never turn
// into a forged clean pass, and must never turn into "no signal at all" when one
// runner is still healthy:
//
//   all shards ok        -> merged findings
//   some shards fail     -> the surviving shards' findings (partial, still real)
//   every shard fails    -> THROW, so the gate reports honest not-measured
//   one runner available -> whole file, unsharded
//   no runner available  -> available() is false; the gate never calls run()
//
// The partial case is deliberate: a survivor found in the healthy half is a real
// survivor. Suppressing it because the other half was unreachable would trade a
// true finding for silence.

import { MutationNotMeasurableError, MutationRunPendingError } from "./cloud-runner.js";
import type { MutationRange, MutationRunner } from "./gate.js";
import { planShards } from "./shard-plan.js";
import type { MutationRunOutput } from "./stryker-adapter.js";

/**
 * Every shard failed, but some may only have run out of budget.
 *
 * `pending` carries those handles so the caller can record them and harvest the
 * results in a later window. Empty means every shard failed for a real reason
 * and there is nothing to come back for.
 */
export class ShardedRunFailure extends Error {
	readonly pending: readonly MutationRunPendingError[];

	constructor(message: string, pending: readonly MutationRunPendingError[]) {
		super(message);
		this.name = "ShardedRunFailure";
		this.pending = pending;
	}
}

/**
 * Collapse mutants that describe the SAME mutation.
 *
 * Shards are meant to be disjoint, but overlap is reachable: a runner that
 * ignores the range measures the whole file, and the degraded single-runner path
 * deliberately does. Without this, one real survivor is reported once per shard —
 * which reads as N separate defects and inflates every count built on it.
 * Observed live: 12 survivors rendered as 24 across two shards.
 *
 * Identity is (file, mutator, offset, replacement): the same operator applied at
 * the same place with the same substitution IS the same mutant, whichever shard
 * measured it. The separator is written as an ESCAPE, never a raw byte — a raw
 * control character makes grep treat the whole file as binary.
 */
function dedupeMutants<
	T extends { raw: { file: string; mutator: string; startOffset: number; replacement: string } },
>(mutants: T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const m of mutants) {
		const key = [m.raw.file, m.raw.mutator, String(m.raw.startOffset), m.raw.replacement].join(
			"\x00",
		);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(m);
	}
	return out;
}

/** Lines in the proposed content — the span the shards tile. Empty content has
 *  no lines to mutate, which is distinct from a one-line file. */
function lineCount(content: string): number {
	if (content.length === 0) return 0;
	return content.split("\n").length;
}

/**
 * Combine N runners into one that splits a file by line range.
 *
 * Order is significant only for reporting; shard i goes to runner i.
 */
export function createShardedMutationRunner(runners: readonly MutationRunner[]): MutationRunner {
	const usable = (): MutationRunner[] => runners.filter((r) => r.available());

	return {
		available: () => usable().length > 0,

		run: async (file, overlayContent, overlays): Promise<MutationRunOutput> => {
			const live = usable();
			if (live.length === 0) throw new Error("no mutation runner available");

			const shards = planShards(lineCount(overlayContent), live.length);
			// An empty plan (zero-line content) still deserves a real attempt rather
			// than a fabricated empty pass, so fall back to one whole-file run.
			const plan: (MutationRange | undefined)[] =
				shards.length === 0 ? [undefined] : shards;

			const settled = await Promise.allSettled(
				plan.map((range, i) => {
					const runner = live[i % live.length];
					if (!runner) throw new Error("shard has no runner");
					// A single usable runner measures the whole file: a lone shard that
					// happens to span 1..N is the same work, and passing no range keeps
					// the request identical to the unsharded path.
					const scope = plan.length === 1 ? undefined : range;
					return runner.run(file, overlayContent, overlays, scope);
				}),
			);

			const ok = settled.filter(
				(s): s is PromiseFulfilledResult<MutationRunOutput> => s.status === "fulfilled",
			);
			if (ok.length === 0) {
				// Preserve the pending HANDLES. A shard that merely ran out of budget
				// is still computing and its report is retained by the runner, so
				// collapsing it into a generic error throws away the only thing that
				// makes a later harvest possible — the job id. Losing these silently
				// is what made the PostToolUse window unimplementable.
				// If EVERY shard agrees there is nothing to measure, that IS the
				// answer for the whole file — propagate it with its type intact.
				// Collapsing it into a generic failure is the same mistake that lost
				// the pending handles below: the caller can only report what survives
				// the wrapper, and "runner failed" is the least useful answer of all.
				const reasons = settled
					.map((s) => (s.status === "rejected" ? s.reason : null))
					.filter((r): r is MutationNotMeasurableError => r instanceof MutationNotMeasurableError);
				if (reasons.length === settled.length && reasons[0]) throw reasons[0];

				const pending = settled
					.map((s) => (s.status === "rejected" ? s.reason : null))
					.filter((r): r is MutationRunPendingError => r instanceof MutationRunPendingError);
				const why = settled
					.map((s) => (s.status === "rejected" ? String(s.reason?.message ?? s.reason) : ""))
					.filter(Boolean)
					.join("; ");
				throw new ShardedRunFailure(`all ${settled.length} mutation shard(s) failed: ${why}`, pending);
			}

			const mutants = dedupeMutants(ok.flatMap((s) => s.value.mutants));
			// Keep the FIRST shard's testRun signal: overlayGreen and the RED-witness
			// describe the suite as a whole, not a line range, so they are identical
			// across shards and must not be re-derived from a partial set.
			const testRun = ok.find((s) => s.value.testRun !== undefined)?.value.testRun;
			return testRun ? { mutants, testRun } : { mutants };
		},
	};
}
