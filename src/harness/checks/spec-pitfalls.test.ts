import { describe, expect, it } from "vitest";
import { checkSpecClaimUntagged, checkSpecPitfalls } from "./spec-pitfalls.js";

const MD = "docs/plan.md";

describe("checkSpecPitfalls", () => {
	it("fires on the seeded Sol-corpus claim shapes", () => {
		const positives = [
			"The trigger system provides exactly-once delivery to external webhooks.",
			"We will implement Argon2id and XChaCha20-Poly1305 in-house for the crypto layer.",
			"Every crate root carries #![forbid(unsafe_code)] with nested #[allow(unsafe_code)] islands.",
			"ObjectId is a truncated 128-bit hash and equality of ids proves content identity.",
			"Invisible nodes are handled by filtering them from the results under MVCC snapshots.",
			"We validate the serialization graphs using its own cycle detector as the oracle for correctness.",
			"Replay produces byte-identical results for parallel float aggregation on any machine.",
		];
		for (const line of positives) {
			const out = checkSpecPitfalls(`# Doc\n${line}`, MD);
			expect(out, line).toHaveLength(1);
			expect(out[0]?.line).toBe(2);
		}
	});

	it("stays silent on hedged/mitigated phrasings (the unless patterns)", () => {
		const negatives = [
			"Delivery is at-least-once; consumers must be idempotent via the outbox key.",
			"We wrap the audited libsodium implementation of XChaCha20-Poly1305.",
			"Store the full digest; the truncated hash is only an index key with collision resolution.",
			"Visibility binds traversal itself: routing only touches snapshot-legal candidates before expansion.",
			"An independent, deliberately simpler Tarjan checker validates the serialization graphs.",
			"Replay is byte-identical when scoped to identical builds under the strict numeric profile.",
		];
		for (const line of negatives) {
			expect(checkSpecPitfalls(`# Doc\n${line}`, MD), line).toEqual([]);
		}
	});

	it("requires same-line co-occurrence and markdown files", () => {
		// Patterns split across lines never fire (the FP control).
		const split = "# Doc\nThe system is exactly-once.\nWebhooks are documented elsewhere.";
		expect(checkSpecPitfalls(split, MD)).toEqual([]);
		expect(
			checkSpecPitfalls("exactly-once delivery to external webhooks", "src/a.ts"),
		).toEqual([]);
	});
});

describe("checkSpecClaimUntagged", () => {
	const optedIn = [
		"# Doc",
		"Replay is byte-identical. [claim: theorem]",
		"The commit protocol guarantees serializability under SSI.",
	].join("\n");

	it("nudges untagged guarantee claims only in opted-in files", () => {
		const out = checkSpecClaimUntagged(optedIn, MD);
		expect(out).toEqual([
			expect.objectContaining({ line: 3, text: expect.stringContaining("untagged") }),
		]);
	});

	it("stays silent without opt-in, without claims, and outside markdown", () => {
		expect(
			checkSpecClaimUntagged("# Doc\nThis guarantees serializability.", MD),
		).toEqual([]);
		expect(checkSpecClaimUntagged("# Doc\nplain prose [claim: theorem]", MD)).toEqual(
			[],
		);
		expect(checkSpecClaimUntagged(optedIn, "src/a.ts")).toEqual([]);
	});
});
