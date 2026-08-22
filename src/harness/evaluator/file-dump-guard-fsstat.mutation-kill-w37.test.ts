import { beforeEach, describe, expect, it, vi } from "vitest";

// test-contract: mocked-collaborator — node:fs is mocked so statDumpFiles's
// two existence/isFile guards can be forced into disagreement with a
// deliberately "large" stat result, which real files can never produce
// (existsSync and statSync always agree on a real filesystem).
const state = vi.hoisted(() => ({
	existsSyncImpl: (_p: string): boolean => true,
	statSyncImpl: (_p: string): { size: number; isFile: () => boolean } => ({ size: 0, isFile: () => true }),
}));

vi.mock("node:fs", () => ({
	existsSync: (p: string) => state.existsSyncImpl(p),
	statSync: (p: string) => state.statSyncImpl(p),
	readFileSync: () => "",
}));

import { evaluateFileDumpGuard } from "./file-dump-guard.js";

describe("file-dump-guard mutation kill w37 — statDumpFiles guards", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.existsSyncImpl = () => true;
		state.statSyncImpl = () => ({ size: 0, isFile: () => true });
	});

	// test-contract: boundary — a path existsSync reports as absent must never
	// be statted/counted, even if a (mocked) stat would call it huge.
	it("P: allows a large stat result when existsSync reports the path absent", () => {
		state.existsSyncImpl = () => false;
		state.statSyncImpl = () => ({ size: 999_999, isFile: () => true });
		const result = evaluateFileDumpGuard({ command: "head /fake/path.txt", cwd: "/fake" });
		expect(result).toEqual({ kind: "allow" });
	});

	// test-contract: boundary — a stat entry that is not a regular file
	// (isFile() false) must never be counted toward the size budget, even if
	// its (mocked) size is huge.
	it("P: allows a large stat result when isFile() reports false", () => {
		state.existsSyncImpl = () => true;
		state.statSyncImpl = () => ({ size: 999_999, isFile: () => false });
		const result = evaluateFileDumpGuard({ command: "head /fake/path.txt", cwd: "/fake" });
		expect(result).toEqual({ kind: "allow" });
	});
});
