import { describe, expect, it } from "vitest";
import { detectPayloadFieldCasing } from "./payload-casing.js";

const TS = "src/harness/foo.ts";

describe("detectPayloadFieldCasing", () => {
	it("flags a snake_case payload field read with no camelCase fallback", () => {
		const out = detectPayloadFieldCasing("const tp = rawInput.transcript_path;", TS);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toMatch(/transcriptPath/);
	});

	it("flags a camelCase payload field read with no snake_case fallback", () => {
		const out = detectPayloadFieldCasing("const s = nativeJson.sessionId;", TS);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toMatch(/session_id/);
	});

	it("flags input.<contract field> too (adapters read the raw payload as `input`)", () => {
		expect(detectPayloadFieldCasing("event.transcript_path = input.transcript_path;", TS)).toHaveLength(1);
	});

	it("does NOT flag a dual-read (both casings present on the line)", () => {
		expect(
			detectPayloadFieldCasing("const s = rawInput.session_id || rawInput.sessionId;", TS),
		).toEqual([]);
		expect(
			detectPayloadFieldCasing("const t = nativeJson.transcriptPath ?? nativeJson.transcript_path;", TS),
		).toEqual([]);
	});

	it("does NOT flag contract fields on non-payload objects (our own normalized event/record)", () => {
		expect(detectPayloadFieldCasing("const x = record.session_id;", TS)).toEqual([]);
		expect(detectPayloadFieldCasing("rec.transcript_path = event.transcript_path;", TS)).toEqual([]);
	});

	it("does NOT flag non-contract fields on a payload var", () => {
		expect(detectPayloadFieldCasing("const c = rawInput.cwd;", TS)).toEqual([]);
	});

	it("N1: does NOT flag a variable whose name only shares a prefix with a payload var (e.g. `rawInputs`, not `rawInput`)", () => {
		expect(detectPayloadFieldCasing("const t = rawInputs.transcript_path;", TS)).toEqual([]);
	});

	it("ignores test files and non-JS/TS files", () => {
		expect(detectPayloadFieldCasing("rawInput.transcript_path", "foo.test.ts")).toEqual([]);
		expect(detectPayloadFieldCasing("rawInput.transcript_path", "foo.py")).toEqual([]);
	});
});
