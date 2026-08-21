// Mutation-kill campaign (wave 26) for graph-prediction-sentinels.ts.
// Targets the 46 mutants the manifest recorded as `survived` at
// .interlinked/mutation-manifest.json (files["src/harness/graph-prediction-sentinels.ts"]).
// Collaborators are mocked at the module boundary, matching the pattern used
// by the companion graph-prediction-sentinels.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseResult } from "./graph-prediction-classifier.js";
import type { ParsedGraphPrediction } from "./graph-prediction-parser.js";
import type { HarnessEvent } from "./types.js";

vi.mock("./graph-prediction-classifier.js", () => ({
	classifyCase: vi.fn(),
}));
vi.mock("./graph-prediction-cache.js", () => ({
	appendPredictionRow: vi.fn(),
	findPredictionRow: vi.fn(),
}));
vi.mock("./graph-prediction-parser.js", () => ({
	parseBarePrediction: vi.fn(),
}));

import {
	appendPredictionRow,
	findPredictionRow,
} from "./graph-prediction-cache.js";
import { classifyCase } from "./graph-prediction-classifier.js";
import { parseBarePrediction } from "./graph-prediction-parser.js";
import {
	handleAckSubmission,
	handleSentinelSubmission,
	parseAckSubmission,
	parseSentinelAckPath,
	parseSentinelPath,
	type SentinelMatch,
} from "./graph-prediction-sentinels.js";

const classifyCaseMock = vi.mocked(classifyCase);
const appendPredictionRowMock = vi.mocked(appendPredictionRow);
const findPredictionRowMock = vi.mocked(findPredictionRow);
const parseBarePredictionMock = vi.mocked(parseBarePrediction);

const CWD = "/repo";

beforeEach(() => {
	vi.clearAllMocks();
});

function efreshClassification(over: Partial<CaseResult> = {}): CaseResult {
	return {
		case: "E-fresh",
		sourcePath: "/repo/src/foo.ts",
		shardPath: "/repo/src/foo.graph.ts",
		sourceMtime: "2026-05-01T00:00:00.000Z",
		shardMtime: "2026-05-01T00:00:01.000Z",
		...over,
	};
}

function okPrediction(over: Partial<ParsedGraphPrediction> = {}): ParsedGraphPrediction {
	return {
		file: "src/foo.ts",
		deps: { imports: ["a"], imported_by: "unknown" },
		calls: { callers: [], callees: ["b"] },
		impact: { risk: "low", domains: [], direct: 1, transitive: 2, affects: [] },
		parse_status: "ok",
		...over,
	};
}

function writeEvent(over: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: {},
		timestamp: "2026-05-10T00:00:00Z",
		cwd: CWD,
		...over,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// parseSentinelPath / parseSentinelAckPath
// ════════════════════════════════════════════════════════════════════════════

describe("parseSentinelPath — mutation kills", () => {
	// test-contract: boundary — kills 5e01b4240c0ade59 (`!abs.startsWith` -> false) and
	// a208a223dce4106e (`${expectedPrefix}/` -> ``). A file directly under
	// predictions/ (sibling to incoming/, NOT inside it) must be rejected —
	// without the prefix guard, `relative()` from the incoming dir produces
	// "../x.yaml", which the shape regex would wrongly accept.
	it("rejects a file outside the incoming/ dir even though its relative path matches the shape", () => {
		expect(parseSentinelPath(".interlinked/predictions/x.yaml", CWD)).toBeNull();
	});

	// test-contract: boundary — kills 48fe9841c5fdbd9a (drop trailing `$` from the shape
	// regex). Without the anchor, "p.yaml.bak" backtrack-matches on the
	// embedded ".yaml" substring even though the real extension is ".bak".
	it("rejects a filename with a real suffix after the yaml extension", () => {
		expect(parseSentinelPath(".interlinked/predictions/incoming/s/p.yaml.bak", CWD)).toBeNull();
	});
});

describe("parseSentinelAckPath — mutation kills", () => {
	// test-contract: boundary — kills 37ce5f5ec7333424 and c73ef63871d6e224 (ack mirror
	// of the incoming-dir prefix guard mutants above).
	it("rejects a file outside the ack/ dir even though its relative path matches the shape", () => {
		expect(parseSentinelAckPath(".interlinked/predictions/x.yaml", CWD)).toBeNull();
	});

	// test-contract: boundary — kills 78f269c13d261c2d (drop leading `^` from the shape
	// regex). Without the anchor, a nested "session/sub/a.yaml" path
	// backtrack-matches starting at "sub/a.yaml".
	it("rejects a nested directory under the ack session dir", () => {
		expect(parseSentinelAckPath(".interlinked/predictions/ack/session/sub/a.yaml", CWD)).toBeNull();
	});

	// test-contract: boundary — kills a89d98b2f41d458a (drop trailing `$`, ack mirror of
	// the p.yaml.bak case above).
	it("rejects an ack filename with a real suffix after the yaml extension", () => {
		expect(parseSentinelAckPath(".interlinked/predictions/ack/session/a.yaml.bak", CWD)).toBeNull();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// parseAckSubmission
// ════════════════════════════════════════════════════════════════════════════

describe("parseAckSubmission — mutation kills", () => {
	// test-contract: boundary — kills 8e9fab0849073927 (`let inAck = false` -> true).
	// If inAck started true, an indented "file:" line appearing BEFORE the
	// real `graph_prediction_ack:` header would be captured as the file.
	it("ignores an indented file: line that appears before the ack header", () => {
		const result = parseAckSubmission(
			"  file: src/decoy.ts\ngraph_prediction_ack:\n  acknowledged_triggers:\n    - x\n",
		);
		expect(result).toEqual({
			file: "",
			acknowledged_triggers: ["x"],
			parse_error: "missing `file:` field",
		});
	});

	// test-contract: boundary — kills 882f6c05181bf3f5 (the `inTriggers = false` reset
	// that fires on every ack-header match -> true). Without the reset, a
	// stray indented item appearing between the header and the real
	// acknowledged_triggers: key would be captured as a trigger.
	it("does not treat a stray indented item right after the header as a trigger", () => {
		const result = parseAckSubmission("graph_prediction_ack:\n  - stray\n  file: src/a.ts\n");
		expect(result).toEqual({ file: "src/a.ts", acknowledged_triggers: [] });
	});

	// test-contract: boundary — kills 136118a1d6867854 (`/\r$/` -> `/\r/`). An embedded
	// \r NOT at the line end must survive un-stripped (breaking the `.`-based
	// field regex, since `.` never matches \r) rather than being removed as
	// if it were a trailing CRLF artifact.
	it("does not strip a carriage return that is not at the line end", () => {
		const result = parseAckSubmission("graph_prediction_ack:\n  file: a\r.ts\n");
		expect(result).toEqual({
			file: "",
			acknowledged_triggers: [],
			parse_error: "missing `file:` field",
		});
	});

	// test-contract: boundary — kills 81e3c8bc35e8f95d (comment-check condition -> false).
	// A comment line inside the triggers block must be skipped via `continue`,
	// not treated as content that closes trigger-listening mode.
	it("skips a comment line inside the triggers block without closing it", () => {
		const result = parseAckSubmission(
			"graph_prediction_ack:\n  acknowledged_triggers:\n    # a comment\n    - one\n",
		);
		expect(result).toEqual({ file: "", acknowledged_triggers: ["one"], parse_error: "missing `file:` field" });
	});

	// test-contract: boundary — kills eba41e473e1d1f42 (`/^\s*#/` -> `/\s*#/`, drop `^`).
	// A real "file:" line with a trailing "#note" must NOT be swallowed as a
	// full-line comment just because " #" occurs somewhere in it.
	it("does not treat a file: line with trailing hash text as a comment", () => {
		const result = parseAckSubmission("graph_prediction_ack:\n  file: src/a.ts #note\n");
		expect(result).toEqual({ file: "src/a.ts #note", acknowledged_triggers: [] });
	});

	// test-contract: boundary — kills 3b3a1d25412589fa (`/^\s*#/` -> `/^\s#/`, `\s*` ->
	// `\s`). A column-0 "#comment" (zero leading whitespace) must still be
	// recognized as a comment; without the `*` it is misread as a dedent
	// that ends the ack block early.
	it("still treats a column-0 comment line as a comment (does not dedent on it)", () => {
		const result = parseAckSubmission("graph_prediction_ack:\n#comment\n  file: src/a.ts\n");
		expect(result).toEqual({ file: "src/a.ts", acknowledged_triggers: [] });
	});

	// test-contract: boundary — kills a95d2bd3ba7992cc (`/^\s*#/` -> `/^\S*#/`, `\s`
	// swapped for `\S`). An indented "# comment" must still be recognized as
	// a comment inside the triggers block; misreading it as content closes
	// trigger-listening mode and drops the following item.
	it("still treats an indented comment inside the triggers block as a comment", () => {
		const result = parseAckSubmission(
			"graph_prediction_ack:\n  acknowledged_triggers:\n    # comment\n    - one\n",
		);
		expect(result).toEqual({ file: "", acknowledged_triggers: ["one"], parse_error: "missing `file:` field" });
	});

	// test-contract: boundary — kills 2177542277c67da4 (drop leading `^` from the header
	// regex). An indented "graph_prediction_ack:" (nested under another key)
	// must NOT be recognized as the top-level header.
	it("does not treat an indented graph_prediction_ack: line as the header", () => {
		const result = parseAckSubmission("outer:\n  graph_prediction_ack:\n  file: src/a.ts\n");
		expect(result).toEqual({
			file: "",
			acknowledged_triggers: [],
			parse_error: "missing `file:` field",
		});
	});

	// test-contract: boundary — kills 5bff2bddb336b92c (drop trailing `$` from the
	// header regex). "graph_prediction_ack: extra" must NOT be recognized as
	// the header — trailing non-whitespace after the colon disqualifies it.
	it("does not treat a header line with trailing garbage as the real header", () => {
		const result = parseAckSubmission("graph_prediction_ack: extra\n  file: src/a.ts\n");
		expect(result).toEqual({
			file: "",
			acknowledged_triggers: [],
			parse_error: "missing `file:` field",
		});
	});

	// test-contract: boundary — kills 5c8cd91077bfad4b (`\s*$` -> `\S*$` on the header
	// regex). "graph_prediction_ack:extra" (no space, non-whitespace tail)
	// must NOT be recognized as the header.
	it("does not treat a header line with an unspaced non-whitespace tail as the header", () => {
		const result = parseAckSubmission("graph_prediction_ack:extra\n  file: src/a.ts\n");
		expect(result).toEqual({
			file: "",
			acknowledged_triggers: [],
			parse_error: "missing `file:` field",
		});
	});

	// test-contract: boundary — kills e868a2c7efe38be6 (drop leading `^` from the file:
	// field regex). A line with extra leading text before "file:" must NOT
	// match the field pattern.
	it("does not treat a line with a prefix before file: as the file field", () => {
		const result = parseAckSubmission("graph_prediction_ack:\n  extra file: src/a.ts\n");
		expect(result).toEqual({
			file: "",
			acknowledged_triggers: [],
			parse_error: "missing `file:` field",
		});
	});

	// test-contract: boundary — kills 3e1bbaaf25557fd4 (`\s*(.+?)` -> `\s(.+?)` on the
	// file: field regex, requiring exactly one whitespace char instead of
	// zero-or-more). A directly-unspaced "file:src/a.ts" must still match.
	it("matches file: with no space between the colon and the value", () => {
		const result = parseAckSubmission("graph_prediction_ack:\n  file:src/a.ts\n");
		expect(result).toEqual({ file: "src/a.ts", acknowledged_triggers: [] });
	});

	// test-contract: boundary — kills a045e12b79abdc6b and f27e251ffde6f79c (both
	// mutations of the file-value quote-strip regex `/^["']|["']$/g` that
	// turn one of its two alternatives unanchored, stripping every quote
	// character in the value instead of only leading/trailing ones).
	it("strips only leading/trailing quotes from the file value, not interior ones", () => {
		const result = parseAckSubmission("graph_prediction_ack:\n  file: a'b'c\n");
		expect(result).toEqual({ file: "a'b'c", acknowledged_triggers: [] });
	});

	// test-contract: boundary — kills 7fcdd3a7e28957c3 (drop leading `^` from the
	// acknowledged_triggers: header regex). A prefixed line must not be
	// mistaken for the real triggers header.
	it("does not treat a line with a prefix before acknowledged_triggers: as the triggers header", () => {
		const result = parseAckSubmission(
			"graph_prediction_ack:\n  extra acknowledged_triggers:\n    - one\n",
		);
		expect(result).toEqual({
			file: "",
			acknowledged_triggers: [],
			parse_error: "missing `file:` field",
		});
	});

	// test-contract: boundary — kills 78e7197125a13f00 (drop trailing `$` from the
	// acknowledged_triggers: header regex). Trailing garbage after the colon
	// must disqualify the line from being the triggers header.
	it("does not treat acknowledged_triggers: with trailing garbage as the triggers header", () => {
		const result = parseAckSubmission(
			"graph_prediction_ack:\n  acknowledged_triggers: extra\n    - one\n  file: src/a.ts\n",
		);
		expect(result).toEqual({ file: "src/a.ts", acknowledged_triggers: [] });
	});

	// test-contract: boundary — kills 514f5304bf70f8fa (`\s*$` -> `\S*$` on the
	// acknowledged_triggers: header regex).
	it("does not treat an unspaced acknowledged_triggers: tail as the triggers header", () => {
		const result = parseAckSubmission(
			"graph_prediction_ack:\n  acknowledged_triggers:extra\n    - one\n  file: src/a.ts\n",
		);
		expect(result).toEqual({ file: "src/a.ts", acknowledged_triggers: [] });
	});

	// test-contract: boundary — kills 06cb7626f451ddb8 (drop leading `^` from the list
	// item regex). A line with a prefix before "- one" must not be captured
	// as a trigger item.
	it("does not treat a line with a prefix before the dash as a trigger item", () => {
		const result = parseAckSubmission(
			"graph_prediction_ack:\n  acknowledged_triggers:\n    extra - one\n",
		);
		expect(result).toEqual({
			file: "",
			acknowledged_triggers: [],
			parse_error: "missing `file:` field",
		});
	});

	// test-contract: boundary — kills d8f6be34a889c8f6 (`\s+(.+?)` -> `\s(.+?)` on the
	// list item regex, requiring exactly one whitespace after the dash
	// instead of one-or-more). Two spaces after the dash must all be
	// consumed, not leave a leading space in the captured item.
	it("consumes all whitespace after the dash marker, not just one char", () => {
		const result = parseAckSubmission(
			"graph_prediction_ack:\n  acknowledged_triggers:\n    -  one\n",
		);
		expect(result).toEqual({
			file: "",
			acknowledged_triggers: ["one"],
			parse_error: "missing `file:` field",
		});
	});

	// test-contract: boundary — kills 3a853fa51134b044 and 2b60d2b331e1587e (the same
	// two quote-strip-regex mutations as above, applied to the SECOND call
	// site — trigger item values instead of the file value).
	it("strips only leading/trailing quotes from a trigger item, not interior ones", () => {
		const result = parseAckSubmission(
			"graph_prediction_ack:\n  acknowledged_triggers:\n    - a'b'c\n",
		);
		expect(result).toEqual({
			file: "",
			acknowledged_triggers: ["a'b'c"],
			parse_error: "missing `file:` field",
		});
	});
});

// ════════════════════════════════════════════════════════════════════════════
// handleAckSubmission
// ════════════════════════════════════════════════════════════════════════════

describe("handleAckSubmission — mutation kills", () => {
	const sentinel: SentinelMatch = {
		sessionId: "sess-1",
		absPath: "/repo/.interlinked/predictions/ack/sess-1/a.yaml",
	};

	// test-contract: boundary — kills 73266cd83e568960 (`event.tool_input?.content` ->
	// `event.tool_input.content`). With tool_input itself absent, the
	// optional-chained read must resolve safely to "" rather than throw.
	it("treats a missing tool_input as empty content instead of throwing", () => {
		const ev = writeEvent({ tool_input: undefined });
		const r = handleAckSubmission(ev, CWD, sentinel);
		expect(r).toEqual({
			decision: "block",
			reason:
				"[interlinked:graph-pred][ack] Sentinel-path ack submission is empty. " +
				"Write the bare YAML (graph_prediction_ack: with `file:` + `acknowledged_triggers:`) as the file content.",
		});
	});

	// test-contract: boundary — kills 33b3e8be5584af37 (deletes the "Write the bare
	// YAML ..." suffix of the empty-content block reason). Exact string match
	// so the deleted literal is provably present.
	it("blocks empty content with the full instructional reason text", () => {
		const ev = writeEvent({ tool_input: { content: 123 } });
		const r = handleAckSubmission(ev, CWD, sentinel);
		expect(r.reason).toBe(
			"[interlinked:graph-pred][ack] Sentinel-path ack submission is empty. " +
				"Write the bare YAML (graph_prediction_ack: with `file:` + `acknowledged_triggers:`) as the file content.",
		);
	});

	// test-contract: boundary — kills 0eb1baa54f85a9a6 (deletes the "in this session at
	// the current source/shard mtimes. Submit the prediction first." suffix
	// of the no-prior-prediction block reason).
	it("blocks a missing prior prediction with the full reason text", () => {
		classifyCaseMock.mockReturnValue(efreshClassification());
		findPredictionRowMock.mockReturnValue(null);
		const content = "graph_prediction_ack:\n  file: src/foo.ts\n";
		const r = handleAckSubmission(writeEvent({ tool_input: { content } }), CWD, sentinel);
		expect(r.reason).toBe(
			"[interlinked:graph-pred][ack] No prior prediction found for /repo/src/foo.ts " +
				"in this session at the current source/shard mtimes. Submit the prediction first.",
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// handleSentinelSubmission
// ════════════════════════════════════════════════════════════════════════════

describe("handleSentinelSubmission — mutation kills", () => {
	const sentinelFile = ".interlinked/predictions/incoming/sess-1/pred.yaml";

	// test-contract: boundary — kills 161e5fd8a987e34e (`event.tool_input?.file_path` ->
	// `event.tool_input.file_path`). With tool_input itself absent, the
	// optional-chained read must resolve safely (filePath="") and return
	// null rather than throw.
	it("returns null for a missing tool_input instead of throwing", () => {
		const r = handleSentinelSubmission(writeEvent({ tool_input: undefined }), CWD);
		expect(r).toBeNull();
	});

	// test-contract: boundary — kills 526725c31720facd (`typeof event.tool_input?.content
	// === "string"` -> `true`). A truthy, non-string content value (here a
	// number) must be coerced to "" by the type guard rather than passed
	// straight through to `.includes(...)`, which numbers do not have.
	it("treats a truthy non-string content as empty instead of calling .includes on it", () => {
		const r = handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: sentinelFile, content: 42 } }),
			CWD,
		);
		expect(r).toEqual({
			decision: "block",
			reason:
				"[interlinked:graph-pred] Sentinel-path submission must contain a `graph_prediction:` block. " +
				"Write the bare YAML (no fences needed) as the file content.",
		});
	});

	// test-contract: boundary — kills 87b704237ccdd542 (deletes the "Write the bare
	// YAML (no fences needed) ..." suffix of the missing-marker reason).
	it("blocks a missing graph_prediction: marker with the full reason text", () => {
		const r = handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: sentinelFile, content: "nope: true" } }),
			CWD,
		);
		expect(r?.reason).toBe(
			"[interlinked:graph-pred] Sentinel-path submission must contain a `graph_prediction:` block. " +
				"Write the bare YAML (no fences needed) as the file content.",
		);
	});

	// test-contract: boundary — kills 565900cc7d8a9b82 (deletes the "Re-write the
	// submission with corrected YAML." suffix of the parse-failed reason).
	it("blocks a parse failure with the full reason text", () => {
		parseBarePredictionMock.mockReturnValue({
			file: "",
			deps: null,
			calls: null,
			impact: null,
			parse_status: "parse_failed",
			parse_error: "bad indent",
		});
		const r = handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: sentinelFile, content: "graph_prediction:\n" } }),
			CWD,
		);
		expect(r?.reason).toBe(
			"[interlinked:graph-pred] Prediction did not parse: bad indent. " +
				"Re-write the submission with corrected YAML.",
		);
	});

	// test-contract: boundary — kills 01ba9f011e7691e2 (deletes the "match this
	// submission to the target edit." suffix of the missing-file reason).
	it("blocks a missing file field with the full reason text", () => {
		parseBarePredictionMock.mockReturnValue(okPrediction({ file: "" }));
		const r = handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: sentinelFile, content: "graph_prediction:\n" } }),
			CWD,
		);
		expect(r?.reason).toBe(
			"[interlinked:graph-pred] Prediction is missing the `file:` field — needed so the harness can " +
				"match this submission to the target edit.",
		);
	});

	// test-contract: boundary — kills 830317de82aebc97 (deletes the "If you intended to
	// edit a different file, ..." suffix of the not-E-fresh reason).
	it("blocks a non-E-fresh target with the full reason text", () => {
		parseBarePredictionMock.mockReturnValue(okPrediction({ file: "src/foo.ts" }));
		classifyCaseMock.mockReturnValue(efreshClassification({ case: "E-stale" }));
		const r = handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: sentinelFile, content: "graph_prediction:\n" } }),
			CWD,
		);
		expect(r?.reason).toBe(
			"[interlinked:graph-pred] Prediction target src/foo.ts classifies as Case E-stale, " +
				"not E-fresh. Only E-fresh files (source exists + fresh shard colocated) need predictions. " +
				"If you intended to edit a different file, retry the Edit and the harness will tell you which file is in scope.",
		);
	});

	// test-contract: boundary — kills 43413f52ce34abed (the bare `""` literal for
	// tool_input_hash -> "Stryker was here!") and 8e8bda555da36148 (the
	// `"\n"` join separator for the accept-message parts -> ""). Full-object
	// equality on the persisted row plus an exact join-with-newline string.
	it("persists tool_input_hash='' and joins the accept message with a real newline", () => {
		const prediction = okPrediction();
		parseBarePredictionMock.mockReturnValue(prediction);
		classifyCaseMock.mockReturnValue(efreshClassification());
		const r = handleSentinelSubmission(
			writeEvent({
				tool_input: { file_path: sentinelFile, content: "graph_prediction:\n" },
				timestamp: "2026-06-03T01:02:03Z",
			}),
			CWD,
		);
		expect(r).toEqual({
			decision: "allow",
			additional_context:
				"[interlinked:graph-pred] Prediction for /repo/src/foo.ts accepted.\n" +
				"You can now retry the original Edit; the cache will be consulted.",
		});
		expect(appendPredictionRowMock).toHaveBeenCalledTimes(1);
		const call = appendPredictionRowMock.mock.calls[0];
		expect(call?.[1]).toEqual({
			session_id: "sess-1",
			file_path: "/repo/src/foo.ts",
			source_mtime: "2026-05-01T00:00:00.000Z",
			shard_mtime: "2026-05-01T00:00:01.000Z",
			shard_path: "/repo/src/foo.graph.ts",
			emitted_at: "2026-06-03T01:02:03Z",
			tool_input_hash: "",
			case: "E-fresh",
			prediction: {
				deps: prediction.deps,
				calls: prediction.calls,
				impact: prediction.impact,
			},
			comparison_status: "pending",
		});
	});
});
