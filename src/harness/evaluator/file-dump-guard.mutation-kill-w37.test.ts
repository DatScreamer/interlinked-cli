import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateFileDumpGuard } from "./file-dump-guard.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fdg-w37-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("file-dump-guard mutation kill w37 — endsWithBoundingStage", () => {
	// test-contract: boundary — the last-pipeline-stage verb must be extracted
	// from the START of the trimmed segment; a non-word leading char must
	// produce "not bounded" (soft-ceiling warning fires) rather than matching
	// a word found later in the string.
	it("P: warns past the soft ceiling when the final pipe stage does not parse as a bounding verb", () => {
		const file = join(dir, "big.txt");
		writeFileSync(file, "x");
		const command = `head -n 2000 ${file} | grep foo | @wc -l`;
		const result = evaluateFileDumpGuard({ command, cwd: dir });
		expect(result).toEqual({
			kind: "warn",
			message:
				"[interlinked:file-dump] `head -n 2000` is past the 1000-line soft ceiling even with a filter. " +
				"If the filter is selective the output stays small, but tighten the line count if you can.",
		});
	});
});

describe("file-dump-guard mutation kill w37 — hasDownstreamFilter", () => {
	// test-contract: boundary — a downstream pipe segment whose first char is
	// not a word character must NOT be recognized as a filter command, even
	// though a filter name (grep) appears later in that segment's text.
	it("P: blocks on line count when the only downstream segment fails to parse as a filter verb", () => {
		const file = join(dir, "nope.txt"); // deliberately does not exist
		const command = `cat ${file} | !grep foo`;
		const result = evaluateFileDumpGuard({ command, cwd: dir });
		expect(result).toEqual({
			kind: "block",
			decision: {
				decision: "block",
				reason:
					`BLOCKED: \`cat\` requesting an entire file without a downstream filter caps out the tool-result budget. ` +
					`Cap at 200 lines, or narrow with a filter (jq / grep / awk / head). ` +
					`If you really need the raw bytes, redirect: \`cat ... > /tmp/sample\`.`,
				rule_id: "builtin-file-dump-too-many-lines",
				severity: "high",
				category: "command-shape",
			},
		});
	});
});

describe("file-dump-guard mutation kill w37 — followBlockResult", () => {
	// test-contract: boundary — a trailing "&" must be followed only by
	// whitespace (or nothing) to count as backgrounding; this asserts the
	// character class is whitespace, not non-whitespace.
	it("P: allows tail -f backgrounded with `&` even when trailing whitespace follows it", () => {
		const result = evaluateFileDumpGuard({ command: "tail -f file & ", cwd: dir });
		expect(result).toEqual({ kind: "allow" });
	});

	// test-contract: boundary — the nohup detector must be anchored to the
	// START of the raw command text, not merely present anywhere in it.
	it("P: still blocks tail -f when nohup only appears after a leading env-var prefix", () => {
		const result = evaluateFileDumpGuard({ command: "X=1 nohup tail -f file", cwd: dir });
		expect(result).toEqual({
			kind: "block",
			decision: {
				decision: "block",
				reason:
					"BLOCKED: `tail -f` in the foreground will hang the tool call indefinitely. " +
					"Run it in the background (`tail -f ... &`), use the runner's background flag, " +
					"or use the Monitor tool for streaming output.",
				rule_id: "builtin-tail-follow-foreground",
				severity: "high",
				category: "command-shape",
			},
		});
	});

	// test-contract: boundary — leading whitespace before "nohup" must be
	// tolerated (matched as whitespace), not required to be non-whitespace.
	it("P: allows a leading-whitespace nohup prefix ahead of tail -f", () => {
		const result = evaluateFileDumpGuard({ command: "  nohup tail -f file", cwd: dir });
		expect(result).toEqual({ kind: "allow" });
	});
});

describe("file-dump-guard mutation kill w37 — countCatNewlines", () => {
	// test-contract: boundary — a file over the size threshold must NOT be
	// read for a real newline count; skipping the read leaves the line count
	// at Infinity, which the filtered-verdict soft ceiling treats as silent
	// (not counted as "over 1000 lines").
	it("P: allows a filtered cat on an oversized file instead of counting its real newlines", () => {
		const file = join(dir, "huge.txt");
		// 2000 lines * 59 bytes = 118000 bytes, comfortably over the 102400-byte
		// block threshold, and comfortably over the 1000-line soft ceiling if
		// its newlines were (wrongly) counted.
		writeFileSync(file, `${"a".repeat(58)}\n`.repeat(2000));
		const command = `cat ${file} | grep x`;
		const result = evaluateFileDumpGuard({ command, cwd: dir });
		expect(result).toEqual({ kind: "allow" });
	});

	// test-contract: boundary — when a file's content has zero real newlines,
	// the regex-match-failure fallback must contribute exactly 0 to the
	// running newline count, not a synthetic 1-element array's length.
	it("P: allows 201 concatenated no-newline reads instead of drifting the count past 200", () => {
		const file = join(dir, "nonewline.txt");
		writeFileSync(file, "hello"); // no trailing newline — content.match(/\n/g) is null
		const repeated = new Array(201).fill(file).join(" ");
		const command = `cat ${repeated}`;
		const result = evaluateFileDumpGuard({ command, cwd: dir });
		expect(result).toEqual({ kind: "allow" });
	});
});

describe("file-dump-guard mutation kill w37 — unfilteredVerdict", () => {
	// test-contract: public-api — exact block payload (kind/decision/reason/
	// rule_id/severity/category) for the oversized-file path with no filter.
	it("P: blocks an oversized unfiltered head with the exact large-file payload", () => {
		const file = join(dir, "large.bin");
		writeFileSync(file, "a".repeat(150 * 1024)); // 150KB > 100KB threshold
		const command = `head ${file}`;
		const result = evaluateFileDumpGuard({ command, cwd: dir });
		expect(result).toEqual({
			kind: "block",
			decision: {
				decision: "block",
				reason:
					`BLOCKED: \`head\` on ${file} (150KB) without a downstream filter ` +
					`would dump a large payload into the tool result. Pipe through one of: ` +
					`jq | grep | rg | awk | sed | head | wc | cut | sort | uniq. ` +
					`If you need the raw bytes on disk, redirect: \`head ... > /tmp/sample\`. ` +
					`To check the file first, run \`wc -l ${file}\`.`,
				rule_id: "builtin-file-dump-large-file",
				severity: "high",
				category: "command-shape",
			},
		});
	});

	// test-contract: public-api — exact block payload for the too-many-lines
	// path (small file, no filter, explicit -n over the cap).
	it("P: blocks an unfiltered head requesting more than the no-filter line cap", () => {
		const file = join(dir, "small.txt");
		writeFileSync(file, "hi");
		const command = `head -n 300 ${file}`;
		const result = evaluateFileDumpGuard({ command, cwd: dir });
		expect(result).toEqual({
			kind: "block",
			decision: {
				decision: "block",
				reason:
					`BLOCKED: \`head\` requesting 300 lines without a downstream filter caps out the tool-result budget. ` +
					`Cap at 200 lines, or narrow with a filter (jq / grep / awk / head). ` +
					`If you really need the raw bytes, redirect: \`head ... > /tmp/sample\`.`,
				rule_id: "builtin-file-dump-too-many-lines",
				severity: "high",
				category: "command-shape",
			},
		});
	});
});
