import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	hashHookDefinition,
	HOOK_RUNTIME_RECEIPT_FILE,
	readHookRuntimeReceipt,
	recordHookRuntime,
} from "./hook-runtime-receipt.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("hook runtime receipt", () => {
	it("records provider execution and the installed definition hash without payload data", () => {
		const root = mkdtempSync(join(tmpdir(), "interlinked-hook-receipt-"));
		roots.push(root);
		const dataDir = join(root, ".interlinked");
		const definitionPath = join(root, "hooks.json");
		writeFileSync(definitionPath, '{"hooks":{}}\n');

		recordHookRuntime({
			dataDir,
			provider: "codex",
			nativeEvent: "SessionStart",
			definitionPath,
			now: () => new Date("2026-08-30T12:00:00.000Z"),
		});

		const path = join(dataDir, HOOK_RUNTIME_RECEIPT_FILE);
		const receipt = readHookRuntimeReceipt(path);
		expect(receipt?.providers.codex).toEqual({
			observed_at: "2026-08-30T12:00:00.000Z",
			native_event: "SessionStart",
			definition_sha256: hashHookDefinition(definitionPath),
		});
		expect(readFileSync(path, "utf-8")).not.toContain("session_id");
		expect(readFileSync(path, "utf-8")).not.toContain("tool_input");
	});

	it("preserves observations from other providers", () => {
		const root = mkdtempSync(join(tmpdir(), "interlinked-hook-receipt-"));
		roots.push(root);
		const dataDir = join(root, ".interlinked");
		mkdirSync(dataDir);
		recordHookRuntime({ dataDir, provider: "codex", nativeEvent: "Stop" });
		recordHookRuntime({ dataDir, provider: "claude-code", nativeEvent: "SessionEnd" });
		const receipt = readHookRuntimeReceipt(join(dataDir, HOOK_RUNTIME_RECEIPT_FILE));
		expect(Object.keys(receipt?.providers ?? {}).sort()).toEqual(["claude-code", "codex"]);
	});

	it("ignores unsafe provider keys", () => {
		const root = mkdtempSync(join(tmpdir(), "interlinked-hook-receipt-"));
		roots.push(root);
		const dataDir = join(root, ".interlinked");
		mkdirSync(dataDir);
		recordHookRuntime({ dataDir, provider: "../escape", nativeEvent: "Stop" });
		expect(readHookRuntimeReceipt(join(dataDir, HOOK_RUNTIME_RECEIPT_FILE))).toBeNull();
	});
});
