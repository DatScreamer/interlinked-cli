import { describe, expect, it } from "vitest";
import {
	extractAllApplyPatchFilePaths,
	extractAllEditedFilePaths,
	extractApplyPatchFilePath,
	extractEditedFilePath,
	summarizeToolInput,
} from "./server-tool-helpers.js";
import type { HarnessEvent } from "./types.js";

function makeEvent(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-04-23T00:00:00.000Z",
		...partial,
	};
}

describe("nonEmptyString (via extractAllEditedFilePaths explicit-path resolution)", () => {
	// test-contract: public-api — kills EqualityOperator (>0 -> >=0) and
	// ConditionalExpression (condition -> true) on nonEmptyString: a
	// whitespace-only file_path must be treated as absent, falling through to
	// the next candidate field via `??`.
	it("P1: treats a whitespace-only file_path as absent and falls through to path", () => {
		expect(
			extractAllEditedFilePaths(
				makeEvent({ tool_input: { file_path: "   ", path: "fallback.ts" } }),
			),
		).toEqual(["fallback.ts"]);
	});

	// test-contract: public-api — kills the MethodExpression mutant on the
	// condition's `value.trim()` (value.length instead of trim().length):
	// without this, an all-whitespace value slips past the >0 length check.
	it("N1: whitespace-only file_path never surfaces on its own", () => {
		expect(
			extractAllEditedFilePaths(makeEvent({ tool_input: { file_path: "   " } })),
		).toEqual([]);
	});

	// test-contract: public-api — kills the MethodExpression mutant on the
	// return-branch `value.trim()` (returning raw value instead of trimmed).
	it("P2: trims surrounding whitespace off an otherwise-valid file_path", () => {
		expect(
			extractAllEditedFilePaths(makeEvent({ tool_input: { file_path: "  foo.ts  " } })),
		).toEqual(["foo.ts"]);
	});
});

describe("extractApplyPatchRaw (via extractAllEditedFilePaths apply_patch branch)", () => {
	// test-contract: public-api — kills ConditionalExpression `!toolInput`
	// -> `false`: with a missing tool_input, the mutant reaches
	// `toolInput.command` on undefined and throws instead of returning "".
	it("P1: an apply_patch event with no tool_input resolves to no paths", () => {
		expect(extractAllEditedFilePaths(makeEvent({ tool_name: "apply_patch" }))).toEqual([]);
	});
});

describe("extractApplyPatchFilePath", () => {
	// test-contract: public-api — kills OptionalChaining removal on the
	// FILE_LINE match: with no `?.`, a failed .match() (null) throws on `[1]`
	// instead of yielding undefined.
	it("P1: returns null (does not throw) when no patch header is present", () => {
		expect(extractApplyPatchFilePath("plain text with no patch headers")).toBeNull();
	});

	// test-contract: public-api — kills the `^` anchor removal on
	// APPLY_PATCH_FILE_LINE: a header embedded mid-line (not at line start)
	// must not match.
	it("N1: does not match an Update-File header embedded mid-line", () => {
		expect(extractApplyPatchFilePath("prefix *** Update File: embedded.ts\n")).toBeNull();
	});

	// test-contract: public-api — kills the `^` anchor removal on
	// APPLY_PATCH_MOVE_LINE: a Move-to header embedded mid-line must not match.
	it("N2: does not match a Move-to header embedded mid-line", () => {
		expect(
			extractApplyPatchFilePath("prefix *** Move to: embedded-move.ts\n"),
		).toBeNull();
	});
});

describe("extractAllApplyPatchFilePaths", () => {
	// NOTE (closing-verifier, 2026-08-22): removed a case here,
	// "P1: skips a section header whose path is whitespace-only", asserting
	// extractAllApplyPatchFilePaths("*** Begin Patch\n*** Update File:   \n*** End Patch\n")
	// === []. APPLY_PATCH_SECTION_LINE's `\s+` is greedy across the trailing
	// newline, so on a whitespace-only "Update File:" line it backtracks into
	// the NEXT line and captures "*** End Patch" as the path — a real source
	// bug (regex should use e.g. `[ \t]+` or non-greedy), not a wrong test
	// expectation. Out of scope for this pass (test-files-only mandate); left
	// as a TODO for whoever owns server-tool-helpers.ts next.

	// test-contract: public-api — kills ConditionalExpression `!isMove`
	// -> `true`: a leading Move-to line with no prior section must not be
	// pushed as if it were its own path.
	it("N1: a leading Move-to line with no preceding section yields no path", () => {
		expect(extractAllApplyPatchFilePaths("*** Move to: dest.ts\n")).toEqual([]);
	});

	// test-contract: public-api — kills ConditionalExpression `!seen.has(p)`
	// -> `true` in the final dedup pass: a path referenced by two separate
	// Update sections must appear once in the result.
	it("P2: dedups the same path referenced by two Update sections", () => {
		const patch =
			"*** Begin Patch\n" +
			"*** Update File: src/a.ts\n@@\n-x\n+y\n" +
			"*** Update File: src/a.ts\n@@\n-z\n+w\n" +
			"*** End Patch\n";
		expect(extractAllApplyPatchFilePaths(patch)).toEqual(["src/a.ts"]);
	});

	// test-contract: public-api — kills the `^` anchor removal on
	// APPLY_PATCH_SECTION_LINE: an embedded mid-line header must not match.
	it("N2: does not match a section header embedded mid-line", () => {
		expect(
			extractAllApplyPatchFilePaths("prefix *** Update File: embedded.ts\n"),
		).toEqual([]);
	});
});

describe("extractEditedFilePath", () => {
	// test-contract: public-api — kills both ConditionalExpression
	// (`all.length > 0` -> `true`) and EqualityOperator (-> `>= 0`) mutants:
	// with no resolvable path, `all` is empty and the mutant would force
	// `nonNull(all[0])`, which throws on undefined instead of returning null.
	it("P1: returns null (does not throw) when no path can be resolved", () => {
		expect(extractEditedFilePath(makeEvent({ tool_input: {} }))).toBeNull();
	});
});

describe("extractAllEditedFilePaths", () => {
	// test-contract: public-api — kills ConditionalExpression
	// `event.tool_name === "apply_patch"` -> `true`: a non-apply_patch event
	// whose command text happens to look like a patch must not be parsed as
	// one.
	it("P1: does not parse a non-apply_patch event's command as a patch", () => {
		expect(
			extractAllEditedFilePaths(
				makeEvent({
					tool_name: "Bash",
					tool_input: { command: "*** Begin Patch\n*** Update File: sneaky.ts\n*** End Patch\n" },
				}),
			),
		).toEqual([]);
	});

	// test-contract: public-api — kills ConditionalExpression / EqualityOperator
	// mutants on `paths.length > 0` (-> true / >= 0 / <= 0) inside the
	// apply_patch branch: when the patch itself yields no paths, resolution
	// must still fall through to files_modified.
	it("P2: falls through to files_modified when the patch text has no paths", () => {
		expect(
			extractAllEditedFilePaths(
				makeEvent({
					tool_name: "apply_patch",
					tool_input: { command: "not a valid patch" },
					files_modified: ["fallback.ts"],
				}),
			),
		).toEqual(["fallback.ts"]);
	});

	// test-contract: public-api — kills the paired ConditionalExpression
	// `false` / EqualityOperator `<= 0` mutants on the same site: when the
	// patch DOES yield a path, resolution must return early and ignore
	// files_modified entirely.
	it("P3: returns early on a real patch path, ignoring files_modified", () => {
		expect(
			extractAllEditedFilePaths(
				makeEvent({
					tool_name: "apply_patch",
					tool_input: { command: "*** Begin Patch\n*** Update File: actual.ts\n*** End Patch\n" },
					files_modified: ["other.ts"],
				}),
			),
		).toEqual(["actual.ts"]);
	});

	// test-contract: public-api — kills both the ConditionalExpression
	// (`!p || seen.has(p)` -> `false`) and LogicalOperator (-> `!p &&
	// seen.has(p)`) mutants on the shared push() guard: a duplicate entry in
	// files_modified must be deduped, not pushed twice.
	it("P4: dedups a duplicate files_modified entry", () => {
		expect(
			extractAllEditedFilePaths(makeEvent({ tool_input: {}, files_modified: ["a.ts", "a.ts"] })),
		).toEqual(["a.ts"]);
	});
});

describe("summarizeToolInput", () => {
	// test-contract: public-api — kills ConditionalExpression
	// `event.tool_name === "apply_patch"` -> `true`: a non-apply_patch tool
	// whose command text looks like a patch must be summarized as its raw
	// (truncated) command, not parsed for a patch path.
	it("P1: does not parse a non-apply_patch command as a patch", () => {
		const patch = "*** Begin Patch\n*** Update File: x.ts\n*** End Patch\n";
		expect(summarizeToolInput(makeEvent({ tool_name: "Bash", tool_input: { command: patch } }))).toBe(
			patch.slice(0, 200),
		);
	});

	// test-contract: public-api — kills ConditionalExpression `patchPath`
	// -> `true`: when the apply_patch payload has no matching header,
	// patchPath is null and must NOT be returned — the raw command text
	// should be used instead.
	it("P2: falls back to raw command text when the patch has no header", () => {
		expect(
			summarizeToolInput(
				makeEvent({ tool_name: "apply_patch", tool_input: { command: "no patch headers here" } }),
			),
		).toBe("no patch headers here");
	});

	// test-contract: public-api — kills ConditionalExpression `input.url`
	// -> `true`: with no command/file_path/url present at all, the summary
	// must fall back to the tool name, not stringify an absent url.
	it("P3: falls back to the tool name when no summarizable field is present", () => {
		expect(summarizeToolInput(makeEvent({ tool_name: "Read", tool_input: {} }))).toBe("Read");
	});
});
