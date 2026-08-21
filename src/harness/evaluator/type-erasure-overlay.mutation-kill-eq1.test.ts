// Mutation-kill / equivalence-falsification regression tests (fleet-r3, pass1_eq1).
//
// Targets two survived mutants from
// scratch/fleet-r3/equiv-briefs/src_harness_evaluator_type-erasure-overlay.ts.json:
//   - 8b2a088c51bee8b0 (`post.length === 0` -> `false`): killed here — the
//     early-return guard is the ONLY thing that stops the function from
//     touching the filesystem when there is nothing to report. Forcing it to
//     `false` makes an all-clean edit perform a disk read it should never
//     perform. That extra `existsSync`/`readFileSync` call is observable
//     through a fs spy even though the final `newFindings` array is
//     unaffected.
//   - 54f19a050289500d (`/\S+/` -> `/\S/` inside a `.test()` guard call):
//     NOT tested here — confirmed structurally equivalent. `.test()` only
//     reports match existence; "at least one non-whitespace char exists" is
//     the exact same boolean condition whether the quantifier requires one
//     match or one-or-more, for every possible input string. No test can
//     distinguish them because no observable of `.test()` depends on match
//     length. See the receipts file for the recorded verdict.

import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateTypeErasureOverlay } from "./type-erasure-overlay.js";

vi.mock("node:fs");

const mockFs = vi.mocked(fs);

afterEach(() => {
	vi.resetAllMocks();
});

describe("type-erasure overlay mutation kills (eq1)", () => {
	// test-contract: invariant (mutantId 8b2a088c51bee8b0) — the zero-findings
	// early return must fire before any disk I/O; forcing `post.length === 0`
	// to `false` removes that return, so an all-clean edit would fall through
	// into the disk-read branch and call `existsSync`/`readFileSync`.
	it("never consults the filesystem when the post-edit content has zero findings", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue("");

		const result = evaluateTypeErasureOverlay("/tmp/te-overlay-eq1-clean.ts", "const x = 1;\n");

		expect(result).toEqual({ newFindings: [], applicable: true });
		expect(mockFs.existsSync).not.toHaveBeenCalled();
		expect(mockFs.readFileSync).not.toHaveBeenCalled();
	});

	// test-contract: invariant (mutantId 8b2a088c51bee8b0, companion case) — a
	// non-empty `options.preContent` string, when post-edit content is clean,
	// also must not touch disk — the real early return fires before the
	// preContent-vs-disk branching is even reached, regardless of what
	// options were passed.
	it("never consults the filesystem when post is clean even with an explicit preContent option", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue("as any\n");

		const result = evaluateTypeErasureOverlay(
			"/tmp/te-overlay-eq1-clean-with-options.ts",
			"const x = 1;\n",
			{ preContent: "as any\n" },
		);

		expect(result).toEqual({ newFindings: [], applicable: true });
		expect(mockFs.existsSync).not.toHaveBeenCalled();
		expect(mockFs.readFileSync).not.toHaveBeenCalled();
	});
});
