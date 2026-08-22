// ===========================================
// graph-prediction-cache.ts — survivor-kill campaign (wave w30)
// ===========================================
// Targets the isGraphPredictionRow type-guard chain and the
// findPredictionRow match logic. isGraphPredictionRow is not exported, so
// every case here exercises it indirectly through findPredictionRow by
// writing raw (sometimes malformed) JSONL lines and asserting the guard
// correctly rejects them.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendPredictionRow,
	findPredictionRow,
	type GraphPredictionRow,
	type PredictionRowKey,
} from "../graph-prediction-cache.js";

let dir: string;
let predPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "graph-pred-cache-w30-"));
	predPath = join(dir, ".interlinked", "graph-predictions.jsonl");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const sampleRow = (overrides: Partial<GraphPredictionRow> = {}): GraphPredictionRow => ({
	session_id: "sess-1",
	file_path: "src/foo.ts",
	source_mtime: "2026-05-10T12:00:00.000Z",
	shard_mtime: "2026-05-10T12:01:00.000Z",
	shard_path: "src/foo.graph.ts",
	emitted_at: "2026-05-10T12:02:00.000Z",
	tool_input_hash: "deadbeef",
	case: "E-fresh",
	prediction: {
		deps: { imports: ["node:net"], imported_by: ["src/index.ts"] },
		calls: { callers: [], callees: [] },
		impact: null,
	},
	comparison_status: "pending",
	...overrides,
});

const key: PredictionRowKey = {
	session_id: "sess-1",
	file_path: "src/foo.ts",
	source_mtime: "2026-05-10T12:00:00.000Z",
	shard_mtime: "2026-05-10T12:01:00.000Z",
};

/** Appends one raw text line to the predictions JSONL, creating the
 *  `.interlinked` dir first. Used to inject shapes the TS type system
 *  would refuse to construct (guard-bypass probes). */
function appendRawLine(line: string): void {
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	const existing = existsSync(predPath) ? readFileSync(predPath, "utf8") : "";
	writeFileSync(predPath, `${existing}${line}\n`);
}

function writeRawRow(raw: unknown): void {
	appendRawLine(JSON.stringify(raw));
}

describe("isGraphPredictionRow guard — single-field corruption rejects the row", () => {
	// test-contract: mutation-kill — corrupting shard_path alone must still reject (kills the
	// leaf shard_path check and every larger AND-chain-forced-true/OR-swap mutant whose range
	// includes it, since a valid tail after the corrupted field would otherwise mask it)
	it("rejects a row whose shard_path is not a string", () => {
		writeRawRow({ ...sampleRow(), shard_path: 42 });
		expect(findPredictionRow(dir, key)).toBeNull();
	});

	// test-contract: mutation-kill — corrupting emitted_at alone must still reject
	it("rejects a row whose emitted_at is not a string", () => {
		writeRawRow({ ...sampleRow(), emitted_at: 42 });
		expect(findPredictionRow(dir, key)).toBeNull();
	});

	// test-contract: mutation-kill — corrupting tool_input_hash alone must still reject
	it("rejects a row whose tool_input_hash is not a string", () => {
		writeRawRow({ ...sampleRow(), tool_input_hash: 42 });
		expect(findPredictionRow(dir, key)).toBeNull();
	});

	// test-contract: mutation-kill — corrupting case alone must still reject
	it("rejects a row whose case is not the E-fresh literal", () => {
		writeRawRow({ ...sampleRow(), case: "A" });
		expect(findPredictionRow(dir, key)).toBeNull();
	});

	// test-contract: mutation-kill — corrupting prediction to a non-object alone must still reject
	it("rejects a row whose prediction is not an object", () => {
		writeRawRow({ ...sampleRow(), prediction: "not-an-object" });
		expect(findPredictionRow(dir, key)).toBeNull();
	});

	// test-contract: mutation-kill — corrupting prediction to null alone must still reject
	it("rejects a row whose prediction is null", () => {
		writeRawRow({ ...sampleRow(), prediction: null });
		expect(findPredictionRow(dir, key)).toBeNull();
	});

	// test-contract: mutation-kill — corrupting comparison_status alone must still reject
	it("rejects a row whose comparison_status is not a string", () => {
		writeRawRow({ ...sampleRow(), comparison_status: 42 });
		expect(findPredictionRow(dir, key)).toBeNull();
	});
});

describe("isGraphPredictionRow guard — non-object / null input", () => {
	// test-contract: mutation-kill — a bare `null` JSON line must be rejected without throwing;
	// removing the `typeof value !== "object" || value === null` short-circuit (either by
	// forcing it to `false` or flipping the `||` to `&&`) lets `null` fall through to a
	// property read that throws instead of returning null
	it("rejects a bare `null` JSONL line without throwing", () => {
		writeRawRow(sampleRow());
		appendRawLine("null");
		expect(() => findPredictionRow(dir, key)).not.toThrow();
		expect(findPredictionRow(dir, key)?.shard_path).toBe("src/foo.graph.ts");
	});
});

describe("isGraphPredictionRow guard — cannot be bypassed wholesale", () => {
	// test-contract: mutation-kill — a row with only the 4 key fields (missing every other
	// required field) must still be rejected; this fails only if the `!isGraphPredictionRow(...)`
	// guard call itself is disabled (not merely weakened field-by-field)
	it("rejects a row that has only the key fields and nothing else", () => {
		writeRawRow({
			session_id: "sess-1",
			file_path: "src/foo.ts",
			source_mtime: "2026-05-10T12:00:00.000Z",
			shard_mtime: "2026-05-10T12:01:00.000Z",
		});
		expect(findPredictionRow(dir, key)).toBeNull();
	});
});

describe("findPredictionRow — file_path must match exactly", () => {
	// test-contract: mutation-kill — a row matching session_id/source_mtime/shard_mtime but
	// with a DIFFERENT file_path must not be returned for the query key
	it("rejects a row whose file_path differs from the query key", () => {
		appendPredictionRow(dir, sampleRow({ file_path: "src/OTHER.ts" }));
		expect(findPredictionRow(dir, key)).toBeNull();
	});
});
