// Mutation-survivor-kill companion for src/harness/ci-command-extractor.ts
// (fleet-r3, pass1_w23).
//
// Targets the 52 status="survived" mutants recorded against this file in
// .interlinked/mutation-manifest.json. 45 are killed below with
// exact-observable assertions reached entirely through the exported
// functions (isCIFile / extractWorkflowCommands / extractDockerfileCommands
// / extractMakefileCommands) — several targeted mutants live in the
// unexported helpers `unquote`, `indentOf`, `tryParseJsonArray`, and
// `parseDockerRun`, so they are reached only indirectly through the
// exported entry points that call them. 7 are suspected-equivalent: a
// downstream `.trim()` or truthiness check absorbs the mutated difference
// before it becomes observable through any of the five exported functions.
// See the structural argument for each at
// scratch/fleet-r3/receipts/src_harness_ci-command-extractor.ts.jsonl.

import { describe, expect, it } from "vitest";
import {
	extractDockerfileCommands,
	extractMakefileCommands,
	extractWorkflowCommands,
	isCIFile,
} from "./ci-command-extractor.js";

describe("isCIFile — survivor kills", () => {
	// test-contract: invariant — path normalization joins split segments
	// with "/" (not ""); a backslash-separated (Windows-style) workflow
	// path must still classify, which only holds if the join separator is real.
	it("normalizes backslash path separators before matching", () => {
		expect(isCIFile(".github\\workflows\\ci.yml")).toBe("workflow");
	});

	// test-contract: invariant — the Dockerfile/Makefile checks compare
	// only the basename (text after the last "/"), not the full relative path.
	it("classifies a bare Dockerfile/Makefile nested in a subdirectory by basename", () => {
		expect(isCIFile("docker/Dockerfile")).toBe("dockerfile");
		expect(isCIFile("build/Makefile")).toBe("makefile");
	});

	// test-contract: invariant — the workflow-path regex is anchored to the
	// start of the string; text before ".github/workflows/" must disqualify it.
	it("requires the .github/workflows path to start at the beginning of relPath", () => {
		expect(isCIFile("sub/.github/workflows/ci.yml")).toBe(null);
	});

	// test-contract: invariant — the workflow-path regex is anchored to the
	// end of the string; a trailing suffix after .yml/.yaml must disqualify it.
	it("requires the .yml/.yaml extension to be at the true end of relPath", () => {
		expect(isCIFile(".github/workflows/ci.yml.bak")).toBe(null);
	});

	// test-contract: invariant — the lowercase "makefile" spelling is
	// checked by its own comparison, independent of the "Makefile" one.
	it("classifies a lowercase 'makefile' filename", () => {
		expect(isCIFile("makefile")).toBe("makefile");
	});
});

describe("extractWorkflowCommands — survivor kills", () => {
	// test-contract: boundary — unquote()'s length guard (>=2) must reject
	// a single stray quote character rather than treating it as a matched pair.
	it("does not unquote a single stray quote character", () => {
		const yaml = ['  - run: "'].join("\n");
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds[0]?.command).toBe('"');
	});

	// test-contract: boundary — an exactly-2-char quoted value ("") is the
	// smallest input where unquote()'s length guard must accept, not
	// reject, stripping.
	it("unquotes an empty quoted string (exactly 2 chars) to empty content", () => {
		const yaml = ['  - run: ""'].join("\n");
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]?.command).toBe("");
	});

	// test-contract: invariant — unquote() strips single-quote wrapping,
	// not just double-quote wrapping.
	it("strips single-quote wrapping, not just double-quote wrapping", () => {
		const yaml = ["  - run: 'rm -rf /tmp/x'"].join("\n");
		expect(extractWorkflowCommands(yaml)[0]?.command).toBe("rm -rf /tmp/x");
	});

	// test-contract: invariant — unquote() must not strip a value whose
	// opening and closing characters are different quote kinds.
	it("does not strip mismatched quote characters (opening and closing differ)", () => {
		const yaml = ["  - run: \"rm -rf /tmp'"].join("\n");
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds[0]?.command).toBe("\"rm -rf /tmp'");
	});

	// test-contract: invariant — the run: key regex is anchored to line
	// start; "run:" appearing after other text must not be treated as a step.
	it("does not treat 'run:' appearing after other text as a run key", () => {
		const yaml = "  see run: rm -rf /tmp for details";
		expect(extractWorkflowCommands(yaml)).toHaveLength(0);
	});

	// test-contract: boundary — the run: key regex is anchored to the true
	// end of the line; a trailing CR (not consumed by ".") must fail the
	// match rather than being silently ignored.
	it("requires the run: value to reach the true end of the line (rejects a trailing CR)", () => {
		const yaml = "run: echo hi\r";
		expect(extractWorkflowCommands(yaml)).toHaveLength(0);
	});

	// test-contract: invariant — the dash-prefix group allows ONE OR MORE
	// spaces after "-", not exactly one.
	it("allows multiple spaces between the list-item dash and 'run:'", () => {
		const yaml = "-   run: rm -rf /tmp";
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds[0]?.command).toBe("rm -rf /tmp");
	});

	// test-contract: invariant — the space after "run:" is optional and
	// consumes at most one whitespace char; it must not eat a
	// non-whitespace character when no space is present.
	it("does not require or consume a space after the run: colon", () => {
		const yaml = "run:echo hi";
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]?.command).toBe("echo hi");
	});

	// test-contract: invariant — a run: value that is only whitespace must
	// not produce an entry (the truthiness gate runs on the raw,
	// pre-unquote value).
	it("does not emit an entry for a run: with only trailing whitespace", () => {
		const yaml = "run:   ";
		expect(extractWorkflowCommands(yaml)).toHaveLength(0);
	});

	// test-contract: invariant — the block-scalar indicator regex is
	// anchored to the start; a "|" appearing later in an inline value must
	// not trigger block-scalar collection.
	it("does not misdetect | appearing later in the value as a block scalar indicator", () => {
		const yaml = "run: xyz|";
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]?.command).toBe("xyz|");
	});

	// test-contract: invariant — the block-scalar indicator regex is
	// anchored to the end; "|" followed by real content is an inline
	// value, not a block-scalar opener.
	it("does not misdetect an inline value merely starting with | as a block scalar", () => {
		const yaml = "run: | echo hi";
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]?.command).toBe("| echo hi");
	});

	// test-contract: invariant — same end anchor, exercised through the
	// trailing \s*$ segment: "|" followed by non-whitespace text must not match.
	it("does not misdetect a pipe followed by arbitrary trailing text as a block scalar indicator", () => {
		const yaml = "run: |xyz";
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]?.command).toBe("|xyz");
	});

	// test-contract: invariant — a whitespace-only line inside a
	// block-scalar body counts as blank (its trimmed form is compared, not
	// its raw form).
	it("treats a whitespace-only line inside a block scalar body as blank", () => {
		const yaml = ["run: |", "  echo hi", "   ", "  echo bye"].join("\n");
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds[0]?.command).toBe("echo hi\n\necho bye");
	});

	// test-contract: invariant — the FIRST non-blank body line fixes the
	// shared base indent for the whole block; a later, more-deeply-indented
	// line must keep its relative (not absolute) indent.
	it("uses the first body line's indent as the shared base for all body lines", () => {
		const yaml = ["    run: |", "      echo top", "        echo nested"].join("\n");
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds[0]?.command).toBe("echo top\n  echo nested");
	});

	// test-contract: invariant — a leading blank line inside a
	// block-scalar body must be trimmed from the final joined command.
	it("trims a leading blank line inside a block scalar body", () => {
		const yaml = ["run: |", "", "  echo hi"].join("\n");
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds[0]?.command).toBe("echo hi");
	});

	// test-contract: invariant — trailing newlines are STRIPPED from a
	// block-scalar body, not replaced with other text.
	it("strips (does not replace) trailing newlines from a block scalar body", () => {
		const yaml = ["run: |", "  echo hi", ""].join("\n");
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds[0]?.command).toBe("echo hi");
	});

	// test-contract: invariant — an empty block-scalar body (no
	// deeper-indented line followed the run: | key) must produce no entry.
	it("does not emit an entry for a block scalar with an empty body", () => {
		const yaml = ["run: |", "env:"].join("\n");
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds).toHaveLength(0);
	});
});

describe("extractDockerfileCommands — survivor kills", () => {
	// test-contract: invariant — the RUN instruction regex is anchored to
	// line start; "RUN" appearing after other text must not match.
	it("does not treat RUN appearing mid-line as an instruction", () => {
		const df = "echo RUN rm -rf /tmp";
		expect(extractDockerfileCommands(df)).toHaveLength(0);
	});

	// test-contract: boundary — the RUN instruction regex is anchored to
	// the true end of the line; a trailing CR (not consumed by ".") must
	// fail the match.
	it("requires the RUN payload to reach the true end of the line (rejects a trailing CR)", () => {
		const df = "RUN echo hi\r";
		expect(extractDockerfileCommands(df)).toHaveLength(0);
	});

	// test-contract: invariant — leading whitespace before RUN is allowed
	// (zero or more), matching real-world indented Dockerfiles.
	it("allows an indented RUN instruction", () => {
		const df = "  RUN echo hi";
		const cmds = extractDockerfileCommands(df);
		expect(cmds[0]?.command).toBe("echo hi");
	});

	// test-contract: invariant — the backslash-continuation while loop
	// requires BOTH a trailing backslash AND an available next line; two
	// independent RUN lines (neither ending in backslash) must stay separate.
	it("does not merge two separate RUN lines when neither ends with a backslash", () => {
		const df = ["RUN echo hi", "RUN echo bye"].join("\n");
		const cmds = extractDockerfileCommands(df);
		expect(cmds).toHaveLength(2);
		expect(cmds.map((c) => c.command)).toEqual(["echo hi", "echo bye"]);
		expect(cmds.map((c) => c.line)).toEqual([1, 2]);
	});

	// test-contract: boundary — a trailing backslash on the LAST line of
	// the file (no next line to join) must not attempt an out-of-bounds read.
	it("does not attempt to join a trailing backslash past the last line", () => {
		const df = "RUN echo hi\\";
		const cmds = extractDockerfileCommands(df);
		expect(cmds[0]?.command).toBe("echo hi\\");
	});

	// test-contract: invariant — an empty JSON-array RUN instruction
	// (`RUN []`) parses to an empty command string, which must not be pushed.
	it("does not emit an entry for an empty JSON-array RUN instruction", () => {
		const df = "RUN []";
		expect(extractDockerfileCommands(df)).toHaveLength(0);
	});

	// test-contract: invariant — parseDockerRun's own trim() must strip
	// trailing whitespace from a shell-form RUN payload.
	it("trims trailing whitespace from a shell-form RUN command", () => {
		const df = "RUN echo hi   ";
		const cmds = extractDockerfileCommands(df);
		expect(cmds[0]?.command).toBe("echo hi");
	});
});

describe("extractMakefileCommands — survivor kills", () => {
	// test-contract: invariant — startLine reports the 1-based line of the
	// tab-indented recipe line itself.
	it("reports the 1-based source line for a recipe command", () => {
		const mk = ["clean:", "\trm -rf dist"].join("\n");
		const cmds = extractMakefileCommands(mk);
		expect(cmds[0]?.line).toBe(2);
	});

	// test-contract: boundary — a trailing backslash on the LAST recipe
	// line (no next line to join) must not attempt an out-of-bounds read.
	it("does not attempt to join a trailing backslash past the last recipe line", () => {
		const mk = "\trm -rf a \\";
		const cmds = extractMakefileCommands(mk);
		expect(cmds[0]?.command).toBe("rm -rf a \\");
	});

	// test-contract: invariant — only a LEADING tab is stripped from a
	// joined continuation line; a tab embedded later in the line is real
	// content and must survive.
	it("only strips a leading tab from a joined continuation line, not one embedded later", () => {
		const mk = ["wipe:", "\trm -rf \\", "b\tc"].join("\n");
		const cmds = extractMakefileCommands(mk);
		expect(cmds[0]?.command).toBe("rm -rf b\tc");
	});

	// test-contract: invariant — the final .trim() on the assembled
	// recipe must strip trailing whitespace from the command text.
	it("trims trailing whitespace from the final recipe command", () => {
		const mk = ["clean:", "\trm -rf dist   "].join("\n");
		const cmds = extractMakefileCommands(mk);
		expect(cmds[0]?.command).toBe("rm -rf dist");
	});

	// test-contract: invariant — the recipe-prefix strip is ONE OR MORE of
	// @/-/+; a combined prefix like "@-" must have BOTH characters removed.
	it("strips a combined recipe prefix (e.g. @- for silent + ignore-errors)", () => {
		const mk = ["clean:", "\t@-rm -f tmp"].join("\n");
		const cmds = extractMakefileCommands(mk);
		expect(cmds[0]?.command).toBe("rm -f tmp");
	});

	// test-contract: invariant — a recipe line that is only a prefix
	// marker (nothing left after stripping @/-/+) must not produce an entry.
	it("does not emit an entry for a recipe line that is only a prefix marker", () => {
		const mk = ["clean:", "\t@"].join("\n");
		const cmds = extractMakefileCommands(mk);
		expect(cmds).toHaveLength(0);
	});
});
