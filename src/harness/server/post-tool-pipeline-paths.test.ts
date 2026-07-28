import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "../types.js";
import { resolveEditedPaths } from "./post-tool-pipeline-paths.js";

/**
 * Generated build artifacts must never enter the quality pipeline. The bash
 * path extractor matched ANY source-looking path in a command, so `rg -c ...
 * dist/index.js` fed a 25,000-line bundle to the full inline-check family —
 * clone detection and AST parses over 300KB of generated code. Ledgered
 * 2026-07-28 as +922MB…+1078MB heap spikes in single 30s ticks, ending in
 * row-less daemon deaths (OOM): the direct mechanism behind "the harness keeps
 * going down".
 */
function bash(command: string): HarnessEvent {
	// SAFETY: only the fields resolveEditedPaths reads; the full event shape is
	// irrelevant to path resolution.
	return { tool_name: "Bash", tool_input: { command } } as unknown as HarnessEvent;
}

function edit(file_path: string): HarnessEvent {
	// SAFETY: as above — tool_name + file_path are the read surface.
	return { tool_name: "Edit", tool_input: { file_path } } as unknown as HarnessEvent;
}

describe("resolveEditedPaths — positive (must still resolve)", () => {
	it("P1: a source file edited via bash resolves for checking", () => {
		const r = resolveEditedPaths(bash("sed -i '' 's/a/b/' src/lib/config.ts"));
		expect(r.editedFilePath).toBe("src/lib/config.ts");
	});

	it("P2: a direct Edit to a source file resolves", () => {
		const r = resolveEditedPaths(edit("src/harness/server.ts"));
		expect(r.editedFilePaths).toContain("src/harness/server.ts");
	});
});

describe("resolveEditedPaths — negative (generated output must not be analyzed)", () => {
	it("N1: a dist bundle mentioned in a bash command is NOT picked up", () => {
		const r = resolveEditedPaths(bash('rg -c "USER_PROMPT" dist/hook-entry.js'));
		expect(r.editedFilePath).toBe("");
	});

	it("N2: nested build output is skipped wherever it sits", () => {
		for (const cmd of [
			"tail -3 cloud/.wrangler/tmp/dev-x/worker.js",
			"wc -l node_modules/@stryker-mutator/core/dist/src/stryker.js",
			"cat coverage/lcov-report/index.js",
		]) {
			expect(resolveEditedPaths(bash(cmd)).editedFilePath).toBe("");
		}
	});

	it("N3: a bash command mixing a bundle and a real source file resolves the source file", () => {
		// The exemption must skip PAST the artifact, not abandon the scan.
		const r = resolveEditedPaths(bash("diff dist/index.js src/index.ts"));
		expect(r.editedFilePath).toBe("src/index.ts");
	});

	it("N4: a direct edit to generated output resolves no paths to analyze", () => {
		// shouldRunChecks stays true for direct edits (the pipeline's marker
		// bookkeeping is cheap and other tests pin it); what matters for the OOM
		// class is that the PATH LIST is empty — nothing to fan the analyzers over.
		const r = resolveEditedPaths(edit("dist/harness/server.js"));
		expect(r.editedFilePaths).toEqual([]);
		expect(r.editedFilePath).toBe("");
	});

	it("N5: minified artifacts are skipped by suffix even outside known dirs", () => {
		expect(resolveEditedPaths(bash("head vendor/lib.min.js")).editedFilePath).toBe("");
	});
});
