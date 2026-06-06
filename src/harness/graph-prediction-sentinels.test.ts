// Behavioral coverage for graph-prediction-sentinels.ts.
//
// The four collaborators that touch disk / parse YAML are mocked at the
// module boundary so every branch can be driven deterministically without
// real shard files: classifyCase (classifier), appendPredictionRow +
// findPredictionRow (cache I/O), parseBarePrediction (parser). The path
// parsers (parseSentinelPath / parseSentinelAckPath) and the bespoke ack
// YAML parser (parseAckSubmission) run for real — they are pure.

import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseResult } from "./graph-prediction-classifier.js";
import type {
	GraphPredictionRow,
	PredictionRowKey,
} from "./graph-prediction-cache.js";
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

import { classifyCase } from "./graph-prediction-classifier.js";
import {
	appendPredictionRow,
	findPredictionRow,
} from "./graph-prediction-cache.js";
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

afterEach(() => {
	vi.restoreAllMocks();
});

// ── builders ────────────────────────────────────────────────────────────────

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

function priorRow(over: Partial<GraphPredictionRow> = {}): GraphPredictionRow {
	return {
		session_id: "sess-1",
		file_path: "/repo/src/foo.ts",
		source_mtime: "2026-05-01T00:00:00.000Z",
		shard_mtime: "2026-05-01T00:00:01.000Z",
		shard_path: "/repo/src/foo.graph.ts",
		emitted_at: "2026-05-01T00:00:00.000Z",
		tool_input_hash: "",
		case: "E-fresh",
		prediction: { deps: null, calls: null, impact: null },
		comparison_status: "pending",
		...over,
	};
}

function okPrediction(over: Partial<ParsedGraphPrediction> = {}): ParsedGraphPrediction {
	return {
		file: "src/foo.ts",
		deps: { imports: ["a"], imported_by: "unknown" },
		calls: { callers: [], callees: ["b"] },
		impact: {
			risk: "low",
			domains: [],
			direct: 1,
			transitive: 2,
			affects: [],
		},
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
// parseSentinelPath
// ════════════════════════════════════════════════════════════════════════════

describe("parseSentinelPath", () => {
	it("returns null on empty filePath (!filePath branch)", () => {
		expect(parseSentinelPath("", CWD)).toBeNull();
	});

	it("matches a relative incoming path and captures the session id", () => {
		const match = parseSentinelPath(
			".interlinked/predictions/incoming/sess-99/pred.yaml",
			CWD,
		);
		expect(match).toEqual({
			sessionId: "sess-99",
			absPath: resolve(CWD, ".interlinked/predictions/incoming/sess-99/pred.yaml"),
		});
	});

	it("matches an absolute incoming path (isAbsolute true branch) and .yml extension", () => {
		const abs = resolve(CWD, ".interlinked/predictions/incoming/sX/p.yml");
		const match = parseSentinelPath(abs, CWD);
		expect(match).toEqual({ sessionId: "sX", absPath: abs });
	});

	it("returns null when path is outside the incoming prefix", () => {
		expect(
			parseSentinelPath(".interlinked/predictions/ack/sess/p.yaml", CWD),
		).toBeNull();
	});

	it("returns null when the prefix matches but the shape is wrong (no session dir)", () => {
		expect(
			parseSentinelPath(".interlinked/predictions/incoming/flat.yaml", CWD),
		).toBeNull();
	});

	it("returns null when the file is not .yaml/.yml", () => {
		expect(
			parseSentinelPath(".interlinked/predictions/incoming/sess/pred.json", CWD),
		).toBeNull();
	});

	it("returns null when there is an extra nested directory (regex anchors reject)", () => {
		expect(
			parseSentinelPath(
				".interlinked/predictions/incoming/sess/sub/pred.yaml",
				CWD,
			),
		).toBeNull();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// parseSentinelAckPath
// ════════════════════════════════════════════════════════════════════════════

describe("parseSentinelAckPath", () => {
	it("returns null on empty filePath", () => {
		expect(parseSentinelAckPath("", CWD)).toBeNull();
	});

	it("matches a relative ack path", () => {
		const match = parseSentinelAckPath(
			".interlinked/predictions/ack/sess-7/ack.yaml",
			CWD,
		);
		expect(match).toEqual({
			sessionId: "sess-7",
			absPath: resolve(CWD, ".interlinked/predictions/ack/sess-7/ack.yaml"),
		});
	});

	it("matches an absolute ack path (isAbsolute true branch)", () => {
		const abs = resolve(CWD, ".interlinked/predictions/ack/sQ/a.yml");
		expect(parseSentinelAckPath(abs, CWD)).toEqual({
			sessionId: "sQ",
			absPath: abs,
		});
	});

	it("returns null outside the ack prefix (an incoming path)", () => {
		expect(
			parseSentinelAckPath(
				".interlinked/predictions/incoming/sess/p.yaml",
				CWD,
			),
		).toBeNull();
	});

	it("returns null when the shape is wrong under the ack prefix", () => {
		expect(
			parseSentinelAckPath(".interlinked/predictions/ack/onlyfile.yaml", CWD),
		).toBeNull();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// parseAckSubmission
// ════════════════════════════════════════════════════════════════════════════

describe("parseAckSubmission", () => {
	it("errors when the top-level key is missing", () => {
		const r = parseAckSubmission("file: src/foo.ts\n");
		expect(r).toEqual({
			file: "",
			acknowledged_triggers: [],
			parse_error: "missing `graph_prediction_ack:` top-level key",
		});
	});

	it("errors when the file field is absent under the key", () => {
		const r = parseAckSubmission("graph_prediction_ack:\n  acknowledged_triggers:\n    - x\n");
		expect(r).toEqual({
			file: "",
			acknowledged_triggers: ["x"],
			parse_error: "missing `file:` field",
		});
	});

	it("parses file + a list of triggers, stripping quotes on both", () => {
		const yaml = [
			'graph_prediction_ack:',
			'  file: "src/foo.ts"',
			'  acknowledged_triggers:',
			"    - 'high-risk'",
			'    - cycle',
		].join("\n");
		expect(parseAckSubmission(yaml)).toEqual({
			file: "src/foo.ts",
			acknowledged_triggers: ["high-risk", "cycle"],
		});
	});

	it("allows an empty acknowledged_triggers list", () => {
		const yaml = "graph_prediction_ack:\n  file: src/foo.ts\n  acknowledged_triggers:\n";
		expect(parseAckSubmission(yaml)).toEqual({
			file: "src/foo.ts",
			acknowledged_triggers: [],
		});
	});

	it("skips comment lines (^\\s*# branch) and tolerates CRLF", () => {
		const yaml = [
			"# a comment",
			"graph_prediction_ack:\r",
			"  # nested comment",
			"  file: src/foo.ts\r",
			"  acknowledged_triggers:\r",
			"    - one\r",
		].join("\n");
		expect(parseAckSubmission(yaml)).toEqual({
			file: "src/foo.ts",
			acknowledged_triggers: ["one"],
		});
	});

	it("ignores content before the key (!inAck continue) and after a dedent (^\\S resets inAck)", () => {
		const yaml = [
			"preamble: ignored", // !inAck → continue
			"graph_prediction_ack:",
			"  file: src/foo.ts",
			"  acknowledged_triggers:",
			"    - keep",
			"other_top_key:", // ^\S → inAck=false
			"  file: should-be-ignored", // not consumed: inAck is false
			"  acknowledged_triggers:",
			"    - dropped",
		].join("\n");
		expect(parseAckSubmission(yaml)).toEqual({
			file: "src/foo.ts",
			acknowledged_triggers: ["keep"],
		});
	});

	it("exits trigger mode on an indented non-item, non-keyword line (^\\s+\\S true branch sets inTriggers=false)", () => {
		// The line `    junk: x` is indented with content, is not a `- ` item,
		// does not match the `file:` regex, and is not `acknowledged_triggers:`.
		// So control reaches line 133, /^\s+\S/ is TRUE, and inTriggers flips
		// off — the dash that follows is therefore NOT collected.
		const yaml = [
			"graph_prediction_ack:",
			"  file: src/foo.ts",
			"  acknowledged_triggers:",
			"    - first",
			"    junk: x", // indented, has content, not an item/file/triggers key → inTriggers=false
			"    - notATrigger", // inTriggers is now false → ignored
		].join("\n");
		const r = parseAckSubmission(yaml);
		expect(r.file).toBe("src/foo.ts");
		expect(r.acknowledged_triggers).toEqual(["first"]);
	});

	it("keeps trigger mode across a blank line (else-if false branch on line 133)", () => {
		// A whitespace-only line inside the trigger list is not a fully-dedented
		// line (so inAck survives), not an item, and does NOT match ^\s+\S — so
		// the `else if` test is false and inTriggers stays true: the trigger
		// after the blank line is still collected.
		const yaml = [
			"graph_prediction_ack:",
			"  file: src/foo.ts",
			"  acknowledged_triggers:",
			"    - first",
			"   ", // whitespace-only line: leading spaces, no non-space content
			"    - second",
		].join("\n");
		expect(parseAckSubmission(yaml)).toEqual({
			file: "src/foo.ts",
			acknowledged_triggers: ["first", "second"],
		});
	});

	it("does not treat a list item before acknowledged_triggers as a trigger", () => {
		// Covers the loop reaching an item line while inTriggers is false:
		// the item-match `if` is gated on inTriggers, so this dash is a no-op.
		const yaml = [
			"graph_prediction_ack:",
			"  file: src/foo.ts",
			"  - stray", // inTriggers is false here → ignored entirely
		].join("\n");
		expect(parseAckSubmission(yaml)).toEqual({
			file: "src/foo.ts",
			acknowledged_triggers: [],
		});
	});
});

// ════════════════════════════════════════════════════════════════════════════
// handleAckSubmission
// ════════════════════════════════════════════════════════════════════════════

describe("handleAckSubmission", () => {
	const sentinel: SentinelMatch = {
		sessionId: "sess-1",
		absPath: "/repo/.interlinked/predictions/ack/sess-1/a.yaml",
	};

	it("blocks when the content is empty (non-string tool_input.content)", () => {
		const ev = writeEvent({ tool_input: { content: 123 } });
		const r = handleAckSubmission(ev, CWD, sentinel);
		expect(r.decision).toBe("block");
		expect(r.reason).toContain("ack submission is empty");
		expect(classifyCaseMock).not.toHaveBeenCalled();
	});

	it("blocks when the ack YAML does not parse", () => {
		const ev = writeEvent({ tool_input: { content: "not an ack doc" } });
		const r = handleAckSubmission(ev, CWD, sentinel);
		expect(r.decision).toBe("block");
		expect(r.reason).toContain("did not parse");
		expect(r.reason).toContain("missing `graph_prediction_ack:` top-level key");
	});

	it("blocks when the ack target is not E-fresh and resolves a relative path", () => {
		classifyCaseMock.mockReturnValue(efreshClassification({ case: "D" }));
		const content = "graph_prediction_ack:\n  file: src/foo.ts\n";
		const r = handleAckSubmission(writeEvent({ tool_input: { content } }), CWD, sentinel);
		expect(r.decision).toBe("block");
		expect(r.reason).toContain("classifies as Case D");
		expect(r.reason).toContain("not E-fresh");
		// relative file path → resolved against cwd
		expect(classifyCaseMock).toHaveBeenCalledWith(resolve(CWD, "src/foo.ts"), CWD);
	});

	it("resolves an absolute ack file path without re-rooting it (isAbsolute true)", () => {
		classifyCaseMock.mockReturnValue(efreshClassification({ case: "A" }));
		const content = "graph_prediction_ack:\n  file: /abs/foo.ts\n";
		handleAckSubmission(writeEvent({ tool_input: { content } }), CWD, sentinel);
		expect(classifyCaseMock).toHaveBeenCalledWith(resolve("/abs/foo.ts"), CWD);
	});

	it("blocks when shard metadata cannot be resolved (missing shardPath)", () => {
		classifyCaseMock.mockReturnValue(
			efreshClassification({ shardPath: null }),
		);
		const content = "graph_prediction_ack:\n  file: src/foo.ts\n";
		const r = handleAckSubmission(writeEvent({ tool_input: { content } }), CWD, sentinel);
		expect(r.decision).toBe("block");
		expect(r.reason).toContain("Could not resolve shard metadata");
		expect(findPredictionRowMock).not.toHaveBeenCalled();
	});

	it("blocks when sourceMtime is missing (second clause of the OR)", () => {
		classifyCaseMock.mockReturnValue(
			efreshClassification({ sourceMtime: null }),
		);
		const content = "graph_prediction_ack:\n  file: src/foo.ts\n";
		const r = handleAckSubmission(writeEvent({ tool_input: { content } }), CWD, sentinel);
		expect(r.decision).toBe("block");
		expect(r.reason).toContain("Could not resolve shard metadata");
	});

	it("blocks when shardMtime is missing (third clause of the OR)", () => {
		classifyCaseMock.mockReturnValue(
			efreshClassification({ shardMtime: null }),
		);
		const content = "graph_prediction_ack:\n  file: src/foo.ts\n";
		const r = handleAckSubmission(writeEvent({ tool_input: { content } }), CWD, sentinel);
		expect(r.decision).toBe("block");
		expect(r.reason).toContain("Could not resolve shard metadata");
	});

	it("blocks when no prior prediction row exists for this session", () => {
		classifyCaseMock.mockReturnValue(efreshClassification());
		findPredictionRowMock.mockReturnValue(null);
		const content = "graph_prediction_ack:\n  file: src/foo.ts\n";
		const r = handleAckSubmission(writeEvent({ tool_input: { content } }), CWD, sentinel);
		expect(r.decision).toBe("block");
		expect(r.reason).toContain("No prior prediction found");
		// findPredictionRow keyed on classification + sentinel session
		const key: PredictionRowKey = {
			session_id: "sess-1",
			file_path: "/repo/src/foo.ts",
			source_mtime: "2026-05-01T00:00:00.000Z",
			shard_mtime: "2026-05-01T00:00:01.000Z",
		};
		expect(findPredictionRowMock).toHaveBeenCalledWith(CWD, key);
		expect(appendPredictionRowMock).not.toHaveBeenCalled();
	});

	it("accepts an ack with triggers: stamps the row and returns trigger text", () => {
		classifyCaseMock.mockReturnValue(efreshClassification());
		findPredictionRowMock.mockReturnValue(priorRow());
		const content = [
			"graph_prediction_ack:",
			"  file: src/foo.ts",
			"  acknowledged_triggers:",
			"    - high-risk",
			"    - cycle",
		].join("\n");
		const r = handleAckSubmission(
			writeEvent({ tool_input: { content }, timestamp: "2026-06-01T12:00:00Z" }),
			CWD,
			sentinel,
		);
		expect(r.decision).toBe("allow");
		expect(r.additional_context).toContain("Acknowledgement for /repo/src/foo.ts accepted");
		expect(r.additional_context).toContain("(high-risk, cycle).");
		expect(r.additional_context).toContain("retry the original Edit");

		expect(appendPredictionRowMock).toHaveBeenCalledTimes(1);
		const [, persisted] = appendPredictionRowMock.mock.calls[0];
		expect(persisted).toMatchObject({
			...priorRow(),
			emitted_at: "2026-06-01T12:00:00Z",
			ack_required: true,
			ack_text: "triggers: high-risk, cycle",
			acknowledged_at: "2026-06-01T12:00:00Z",
		});
	});

	it("accepts an ack with no triggers: ack_text='acknowledged', period-terminated context", () => {
		classifyCaseMock.mockReturnValue(efreshClassification());
		findPredictionRowMock.mockReturnValue(priorRow());
		const content = "graph_prediction_ack:\n  file: src/foo.ts\n  acknowledged_triggers:\n";
		const r = handleAckSubmission(
			writeEvent({ tool_input: { content }, timestamp: "2026-06-02T00:00:00Z" }),
			CWD,
			sentinel,
		);
		expect(r.decision).toBe("allow");
		expect(r.additional_context).toContain("accepted.");
		expect(r.additional_context).not.toContain("(");
		const [, persisted] = appendPredictionRowMock.mock.calls[0];
		expect(persisted.ack_text).toBe("acknowledged");
	});

	it("falls back to a generated timestamp when the event has none (|| branch)", () => {
		classifyCaseMock.mockReturnValue(efreshClassification());
		findPredictionRowMock.mockReturnValue(priorRow());
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-04T08:09:10.000Z"));
		const content = "graph_prediction_ack:\n  file: src/foo.ts\n";
		const r = handleAckSubmission(
			writeEvent({ tool_input: { content }, timestamp: "" }),
			CWD,
			sentinel,
		);
		vi.useRealTimers();
		expect(r.decision).toBe("allow");
		const [, persisted] = appendPredictionRowMock.mock.calls[0];
		expect(persisted.emitted_at).toBe("2026-07-04T08:09:10.000Z");
		expect(persisted.acknowledged_at).toBe("2026-07-04T08:09:10.000Z");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// handleSentinelSubmission
// ════════════════════════════════════════════════════════════════════════════

describe("handleSentinelSubmission", () => {
	const sentinelFile = ".interlinked/predictions/incoming/sess-1/pred.yaml";

	it("returns null when file_path is not a sentinel path (and non-string file_path → '')", () => {
		// non-string file_path exercises the `: ""` side of the ternary, which
		// then fails parseSentinelPath's !filePath guard → overall null.
		const r = handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: 42, content: "x" } }),
			CWD,
		);
		expect(r).toBeNull();
		expect(parseBarePredictionMock).not.toHaveBeenCalled();
	});

	it("returns null for a path that does not match the incoming sentinel shape", () => {
		const r = handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: "src/foo.ts", content: "x" } }),
			CWD,
		);
		expect(r).toBeNull();
	});

	it("blocks when content is empty (non-string content → '')", () => {
		const r = handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: sentinelFile, content: 0 } }),
			CWD,
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("must contain a `graph_prediction:` block");
	});

	it("blocks when content is present but lacks the graph_prediction: marker", () => {
		const r = handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: sentinelFile, content: "nope: true" } }),
			CWD,
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("must contain a `graph_prediction:` block");
	});

	it("blocks when the bare prediction fails to parse", () => {
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
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("did not parse: bad indent");
	});

	it("blocks when the parsed prediction has no file field", () => {
		parseBarePredictionMock.mockReturnValue(okPrediction({ file: "" }));
		const r = handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: sentinelFile, content: "graph_prediction:\n" } }),
			CWD,
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("missing the `file:` field");
		expect(classifyCaseMock).not.toHaveBeenCalled();
	});

	it("blocks when the prediction target is not E-fresh; resolves a relative path", () => {
		parseBarePredictionMock.mockReturnValue(okPrediction({ file: "src/foo.ts" }));
		classifyCaseMock.mockReturnValue(efreshClassification({ case: "E-stale" }));
		const r = handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: sentinelFile, content: "graph_prediction:\n" } }),
			CWD,
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("classifies as Case E-stale");
		expect(classifyCaseMock).toHaveBeenCalledWith(resolve(CWD, "src/foo.ts"), CWD);
	});

	it("resolves an absolute prediction file path without re-rooting (isAbsolute true)", () => {
		parseBarePredictionMock.mockReturnValue(okPrediction({ file: "/abs/foo.ts" }));
		classifyCaseMock.mockReturnValue(efreshClassification({ case: "B" }));
		handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: sentinelFile, content: "graph_prediction:\n" } }),
			CWD,
		);
		expect(classifyCaseMock).toHaveBeenCalledWith(resolve("/abs/foo.ts"), CWD);
	});

	it("blocks when shard metadata is unresolved (missing shardPath)", () => {
		parseBarePredictionMock.mockReturnValue(okPrediction());
		classifyCaseMock.mockReturnValue(efreshClassification({ shardPath: null }));
		const r = handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: sentinelFile, content: "graph_prediction:\n" } }),
			CWD,
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("Could not resolve shard metadata");
		expect(appendPredictionRowMock).not.toHaveBeenCalled();
	});

	it("blocks when sourceMtime is missing (second OR clause)", () => {
		parseBarePredictionMock.mockReturnValue(okPrediction());
		classifyCaseMock.mockReturnValue(efreshClassification({ sourceMtime: null }));
		const r = handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: sentinelFile, content: "graph_prediction:\n" } }),
			CWD,
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("Could not resolve shard metadata");
	});

	it("blocks when shardMtime is missing (third OR clause)", () => {
		parseBarePredictionMock.mockReturnValue(okPrediction());
		classifyCaseMock.mockReturnValue(efreshClassification({ shardMtime: null }));
		const r = handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: sentinelFile, content: "graph_prediction:\n" } }),
			CWD,
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("Could not resolve shard metadata");
	});

	it("persists and allows on a clean prediction (status ok → pending, single ack part)", () => {
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
		expect(r?.decision).toBe("allow");
		expect(r?.additional_context).toContain(
			"Prediction for /repo/src/foo.ts accepted.",
		);
		expect(r?.additional_context).toContain("retry the original Edit");
		// no format-violation line
		expect(r?.additional_context).not.toContain("Format violation");

		expect(appendPredictionRowMock).toHaveBeenCalledTimes(1);
		const [, row] = appendPredictionRowMock.mock.calls[0];
		expect(row).toMatchObject({
			session_id: "sess-1",
			file_path: "/repo/src/foo.ts",
			source_mtime: "2026-05-01T00:00:00.000Z",
			shard_mtime: "2026-05-01T00:00:01.000Z",
			shard_path: "/repo/src/foo.graph.ts",
			emitted_at: "2026-06-03T01:02:03Z",
			tool_input_hash: "",
			case: "E-fresh",
			comparison_status: "pending",
			prediction: {
				deps: prediction.deps,
				calls: prediction.calls,
				impact: prediction.impact,
			},
		});
	});

	it("on format_violation: persists comparison_status=parse_failed and appends the violation note", () => {
		parseBarePredictionMock.mockReturnValue(
			okPrediction({ parse_status: "format_violation", parse_error: "too many imports" }),
		);
		classifyCaseMock.mockReturnValue(efreshClassification());
		const r = handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: sentinelFile, content: "graph_prediction:\n" } }),
			CWD,
		);
		expect(r?.decision).toBe("allow");
		expect(r?.additional_context).toContain("Format violation noted (too many imports)");
		expect(r?.additional_context).toContain("retry the original Edit");
		const [, row] = appendPredictionRowMock.mock.calls[0];
		expect(row.comparison_status).toBe("parse_failed");
	});

	it("on format_violation with no parse_error: uses the 'exceeded entry cap' fallback (?? branch)", () => {
		// okPrediction never sets parse_error, so omitting it here leaves the
		// field genuinely absent (not `undefined`) — which is what drives the
		// `parsed.parse_error ?? "exceeded entry cap"` fallback.
		parseBarePredictionMock.mockReturnValue(
			okPrediction({ parse_status: "format_violation" }),
		);
		classifyCaseMock.mockReturnValue(efreshClassification());
		const r = handleSentinelSubmission(
			writeEvent({ tool_input: { file_path: sentinelFile, content: "graph_prediction:\n" } }),
			CWD,
		);
		expect(r?.additional_context).toContain("Format violation noted (exceeded entry cap)");
	});

	it("falls back to a generated emitted_at when the event timestamp is empty (|| branch)", () => {
		parseBarePredictionMock.mockReturnValue(okPrediction());
		classifyCaseMock.mockReturnValue(efreshClassification());
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-09T10:11:12.000Z"));
		handleSentinelSubmission(
			writeEvent({
				tool_input: { file_path: sentinelFile, content: "graph_prediction:\n" },
				timestamp: "",
			}),
			CWD,
		);
		vi.useRealTimers();
		const [, row] = appendPredictionRowMock.mock.calls[0];
		expect(row.emitted_at).toBe("2026-08-09T10:11:12.000Z");
	});
});
