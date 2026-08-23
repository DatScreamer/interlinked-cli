import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	initEffectAttributionStore,
	partitionResidueByAttribution,
	RECONCILED_PATH_CEILING,
	recordReconciledEffects,
	resetReconciledEffectRegistry,
} from "./workspace-effect-attribution.js";
import type { WorkspaceFileEffect } from "./workspace-effects.js";

function effect(path: string, sha: string | null, kind: WorkspaceFileEffect["kind"] = "modified"): WorkspaceFileEffect {
	return { path, kind, before_sha256: "before", after_sha256: sha };
}

beforeEach(() => {
	resetReconciledEffectRegistry();
});

describe("partitionResidueByAttribution — positive (must attribute elsewhere)", () => {
	it("P1: drops a residue effect whose hash matches another session's reconciled write", () => {
		recordReconciledEffects("session-b", [effect("src/foo.ts", "abc")]);
		const result = partitionResidueByAttribution("session-a", [effect("src/foo.ts", "abc")]);
		expect(result.own).toEqual([]);
		expect(result.attributedElsewhere).toBe(1);
	});

	it("P2: attributes a deletion via null-hash equality", () => {
		recordReconciledEffects("session-b", [effect("src/gone.ts", null, "deleted")]);
		const result = partitionResidueByAttribution("session-a", [effect("src/gone.ts", null, "deleted")]);
		expect(result.own).toEqual([]);
		expect(result.attributedElsewhere).toBe(1);
	});

	it("P3: a later reconciliation for the same path wins over an earlier one", () => {
		recordReconciledEffects("session-a", [effect("src/foo.ts", "old")]);
		recordReconciledEffects("session-b", [effect("src/foo.ts", "new")]);
		const result = partitionResidueByAttribution("session-a", [effect("src/foo.ts", "new")]);
		expect(result.attributedElsewhere).toBe(1);
	});
});

describe("partitionResidueByAttribution — negative (must keep as own residue)", () => {
	it("N1: keeps an effect on a path no session ever reconciled", () => {
		const result = partitionResidueByAttribution("session-a", [effect("src/unknown.ts", "abc")]);
		expect(result.own).toHaveLength(1);
		expect(result.attributedElsewhere).toBe(0);
	});

	it("P-widened (2026-08-23): attributes a hash-MISMATCHED effect on a path another session owns — the concurrent writer edited its file again after reconciling, which was the residual leak into innocent sessions", () => {
		recordReconciledEffects("session-b", [effect("src/foo.ts", "theirs")]);
		const result = partitionResidueByAttribution("session-a", [effect("src/foo.ts", "later-change")]);
		expect(result.own).toHaveLength(0);
		expect(result.attributedElsewhere).toBe(1);
	});

	it("N3: keeps an effect reconciled by the SAME session — own work is never excluded", () => {
		recordReconciledEffects("session-a", [effect("src/foo.ts", "abc")]);
		const result = partitionResidueByAttribution("session-a", [effect("src/foo.ts", "abc")]);
		expect(result.own).toHaveLength(1);
		expect(result.attributedElsewhere).toBe(0);
	});
});

describe("registry bounds", () => {
	it("prunes the stalest attribution once past the ceiling", () => {
		recordReconciledEffects("session-b", [effect("src/first.ts", "first")]);
		for (let i = 0; i < RECONCILED_PATH_CEILING; i++) {
			recordReconciledEffects("session-b", [effect(`src/f${i}.ts`, "x")]);
		}
		// The oldest entry was pruned, so the matching residue is no longer attributed.
		const first = partitionResidueByAttribution("session-a", [effect("src/first.ts", "first")]);
		expect(first.attributedElsewhere).toBe(0);
		// A fresh entry is still present.
		const fresh = partitionResidueByAttribution("session-a", [
			effect(`src/f${RECONCILED_PATH_CEILING - 1}.ts`, "x"),
		]);
		expect(fresh.attributedElsewhere).toBe(1);
	});
});

describe("durable registry — survives a daemon restart", () => {
	it("P-persist: attributes across a registry reset when a store root is set (simulated daemon restart)", () => {
		const root = mkdtempSync(join(tmpdir(), "effect-attr-store-"));
		try {
			initEffectAttributionStore(root);
			recordReconciledEffects("session-b", [effect("src/foo.ts", "theirs")]);
			// Simulate the daemon dying: wipe all in-memory state, then re-init
			// against the same root — the JSON store must restore the evidence.
			resetReconciledEffectRegistry();
			initEffectAttributionStore(root);
			const result = partitionResidueByAttribution("session-a", [effect("src/foo.ts", "theirs")]);
			expect(result.own).toHaveLength(0);
			expect(result.attributedElsewhere).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("N-persist: without a store root, a reset loses the evidence (old in-memory semantics)", () => {
		recordReconciledEffects("session-b", [effect("src/foo.ts", "theirs")]);
		resetReconciledEffectRegistry();
		const result = partitionResidueByAttribution("session-a", [effect("src/foo.ts", "theirs")]);
		expect(result.own).toHaveLength(1);
		expect(result.attributedElsewhere).toBe(0);
	});
});
