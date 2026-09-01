import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertNoPendingFileRotation,
	fileRotationFencePath,
	PendingFileRotationError,
	UnverifiableFileRotationStateError,
} from "./file-rotation-fence.js";

describe("file rotation fence", () => {
	let root: string;
	let livePath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "interlinked-rotation-fence-"));
		livePath = join(root, ".interlinked", "timeline.jsonl");
		mkdirSync(join(root, ".interlinked", "archive"), { recursive: true });
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("allows a whole-file replacement when no rotation is pending", () => {
		expect(() => assertNoPendingFileRotation(livePath, "timeline")).not.toThrow();
	});

	it("refuses while the durable claim exists, even if its bytes are corrupt", () => {
		const fencePath = fileRotationFencePath(livePath, "timeline");
		writeFileSync(fencePath, "crash-left claim bytes");

		expect(() => assertNoPendingFileRotation(livePath, "timeline")).toThrow(
			PendingFileRotationError,
		);
	});

	it("refuses a legacy claim-less pending manifest", () => {
		const manifestPath = join(root, ".interlinked", "archive", "manifest-timeline.json");
		writeFileSync(
			manifestPath,
			JSON.stringify({ version: 1, segments: [{ pending_live_drop: { cut_bytes: 1 } }] }),
		);

		expect(() => assertNoPendingFileRotation(livePath, "timeline")).toThrow(
			PendingFileRotationError,
		);
	});

	it("allows a complete manifest but fails closed when manifest state is corrupt", () => {
		const manifestPath = join(root, ".interlinked", "archive", "manifest-timeline.json");
		writeFileSync(manifestPath, JSON.stringify({ version: 1, segments: [{ seq: 1 }] }));
		expect(() => assertNoPendingFileRotation(livePath, "timeline")).not.toThrow();

		writeFileSync(manifestPath, "{");
		expect(() => assertNoPendingFileRotation(livePath, "timeline")).toThrow(
			UnverifiableFileRotationStateError,
		);
	});
});
