import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	computeCompleteness,
	computeDedupKey,
	computeProvenanceId,
	normalizeFindingPath,
} from "./provenance.js";

const NUL = " ";

function sha256(input: string): string {
	return createHash("sha256").update(input, "utf-8").digest("hex");
}

function expectedId(parts: string[]): string {
	return sha256(parts.join(NUL)).slice(0, 16);
}

describe("normalizeFindingPath", () => {
	// test-contract: public-api — normalizeFindingPath docs "strip a leading ./",
	// not any "./" occurring anywhere in the path.
	it("strips only a LEADING './', not one occurring mid-path (kills unanchored regex)", () => {
		// No leading "./" here — a "./" appears only after "a/".
		expect(normalizeFindingPath("a/./b.ts")).toBe("a/./b.ts");
	});

	// test-contract: public-api — the documented common case.
	it("strips a genuinely leading './'", () => {
		expect(normalizeFindingPath("./src/a.ts")).toBe("src/a.ts");
	});

	// test-contract: public-api — normalizeFindingPath docs "forward slashes".
	it("converts backslashes to forward slashes", () => {
		expect(normalizeFindingPath("a\\b\\c.ts")).toBe("a/b/c.ts");
	});
});

describe("computeProvenanceId", () => {
	// test-contract: invariant — computeProvenanceId's identity string is a
	// fixed NUL-joined list of fields; this pins its exact composition when
	// every optional field defaults to "".
	it("matches the exact expected hash when every optional field is absent (kills all 7 '\"\" -> Stryker was here!' literal mutants)", () => {
		const result = computeProvenanceId({ source_runner: "claude" });
		const expected = expectedId(["claude", "", "", "", "", "", "", ""]);
		expect(result).toBe(expected);
	});

	// test-contract: invariant — pins the exact identity-string composition
	// when every optional field is populated (repo/pr/comment/sha/file/lines/raw).
	it("matches the exact expected hash when every optional field is populated (kills ?? -> && mutants for repo/comment_node_id/commit_sha, pr==null flip, pr!=null->false, and the lines template-literal mutant)", () => {
		const result = computeProvenanceId({
			source_runner: "claude",
			repo: "acme/widgets",
			pr: 42,
			comment_node_id: "PRRC_1",
			commit_sha: "deadbeef",
			file: "./src/a.ts",
			lines: [10, 12],
			raw_sha256: "abc123",
		});
		const expected = expectedId([
			"claude",
			"acme/widgets",
			"42",
			"PRRC_1",
			"deadbeef",
			normalizeFindingPath("./src/a.ts"),
			"10-12",
			"abc123",
		]);
		expect(result).toBe(expected);
	});

	it("uses the '' branch (not String(undefined)) when pr is absent (kills pr!=null -> true)", () => {
		const result = computeProvenanceId({ source_runner: "r", pr: undefined });
		const expected = expectedId(["r", "", "", "", "", "", "", ""]);
		expect(result).toBe(expected);
	});

	it("truncates the hash to 16 hex chars (kills the .slice(0, HASH_HEX_LENGTH) removal)", () => {
		const result = computeProvenanceId({ source_runner: "claude" });
		expect(result).toHaveLength(16);
	});

	it("uses NUL (' ') as a real separator between fields, not '' (kills the NUL constant mutant)", () => {
		const idA = computeProvenanceId({ source_runner: "ab", repo: "c" });
		const idB = computeProvenanceId({ source_runner: "a", repo: "bc" });
		// With a real separator "ab c" !== "a bc"; with an empty separator both
		// collapse to "abc" and would hash identically.
		expect(idA).not.toBe(idB);
	});

	it("produces different ids for different repos when all else is equal (kills repo ?? '' -> repo && '')", () => {
		const idA = computeProvenanceId({ source_runner: "r", repo: "repoA" });
		const idB = computeProvenanceId({ source_runner: "r", repo: "repoB" });
		expect(idA).not.toBe(idB);
	});
});

describe("computeCompleteness", () => {
	it("returns anchored_file (not anchored_sha) when file+sha present but no line (kills 'hasFile && hasLine' -> 'hasFile || hasLine' in the anchored_sha branch)", () => {
		const result = computeCompleteness({ file: "a.ts", commit_sha: "deadbeef" });
		expect(result).toBe("anchored_file");
	});

	it("returns anchored_file (not anchored_line) when file present but no line/sha (kills 'hasFile && hasLine' -> true in the anchored_line branch)", () => {
		const result = computeCompleteness({ file: "a.ts" });
		expect(result).toBe("anchored_file");
	});

	it("returns anchored_sha for a fully anchored sighting", () => {
		const result = computeCompleteness({ file: "a.ts", lines: [1, 2], commit_sha: "sha" });
		expect(result).toBe("anchored_sha");
	});

	it("returns unanchored with no fields at all", () => {
		expect(computeCompleteness({})).toBe("unanchored");
	});
});

describe("computeDedupKey", () => {
	it("does not tier as 'site' when line is 0 (falsy anchor) even though line != null (kills 'input.line != null && input.line > 0' -> true whole-condition swap)", () => {
		const result = computeDedupKey({ file: "a.ts", repo: "r", line: 0 });
		expect(result.tier).toBe("file");
	});

	it("does not tier as 'site' for a negative line (kills the && -> || swap and the 'input.line > 0' -> true swap)", () => {
		const result = computeDedupKey({ file: "a.ts", repo: "r", line: -5 });
		expect(result.tier).toBe("file");
	});

	it("does not tier as 'site' for line 0 via the >= 0 flip (kills 'input.line > 0' -> 'input.line >= 0')", () => {
		const result = computeDedupKey({ file: "a.ts", repo: "r", line: 0 });
		expect(result.tier).toBe("file");
		expect(result.key).toBe(sha256("r|a.ts"));
	});

	it("tiers as 'site' with the exact expected key for a valid positive line", () => {
		const result = computeDedupKey({ file: "a.ts", repo: "r", line: 7 });
		expect(result.tier).toBe("site");
		expect(result.key).toBe(sha256("r|a.ts|7"));
	});

	it("uses '${repo}|${file}' (not an empty template) for the file-tier key", () => {
		const result = computeDedupKey({ file: "a.ts", repo: "r" });
		expect(result.tier).toBe("file");
		expect(result.key).toBe(sha256("r|a.ts"));
		expect(result.key).not.toBe(sha256(""));
	});

	it("falls back to class tier with an empty key when no file is given", () => {
		const result = computeDedupKey({ repo: "r", line: 5 });
		expect(result).toEqual({ tier: "class", key: "" });
	});
});
