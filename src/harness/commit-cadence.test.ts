import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_DOC_GLOBS,
	formatMidSessionBackstop,
	formatStopNudge,
	isDocFile,
	readSessionTokens,
} from "./commit-cadence.js";

describe("isDocFile", () => {
	it("treats markdown / mdx / txt / rst as docs", () => {
		expect(isDocFile("README.md")).toBe(true);
		expect(isDocFile("docs/intro.mdx")).toBe(true);
		expect(isDocFile("notes.txt")).toBe(true);
		expect(isDocFile("CHANGELOG.rst")).toBe(true);
	});

	it("treats files under docs/ plans/ notes/ as docs even when not .md", () => {
		expect(isDocFile("docs/architecture.svg")).toBe(true);
		expect(isDocFile("plans/q3-roadmap.yaml")).toBe(true);
		expect(isDocFile("notes/scratch.json")).toBe(true);
	});

	it("treats CLAUDE.md / AGENTS.md / PLAN*.md as docs anywhere in the tree", () => {
		expect(isDocFile("CLAUDE.md")).toBe(true);
		expect(isDocFile("subdir/AGENTS.md")).toBe(true);
		expect(isDocFile("PLAN-2026.md")).toBe(true);
	});

	it("treats source code as non-doc", () => {
		expect(isDocFile("src/index.ts")).toBe(false);
		expect(isDocFile("packages/cli/foo.tsx")).toBe(false);
		expect(isDocFile("server.py")).toBe(false);
		expect(isDocFile("Cargo.toml")).toBe(false);
	});

	it("respects custom doc globs override", () => {
		expect(isDocFile("rfc/proposal.adoc", ["rfc/**", "**/*.adoc"])).toBe(true);
		expect(isDocFile("src/index.ts", ["rfc/**"])).toBe(false);
	});

	it("DEFAULT_DOC_GLOBS contains markdown and the common doc dirs", () => {
		expect(DEFAULT_DOC_GLOBS).toContain("**/*.md");
		expect(DEFAULT_DOC_GLOBS).toContain("docs/**");
		expect(DEFAULT_DOC_GLOBS).toContain("plans/**");
	});
});

describe("readSessionTokens", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "commit-cadence-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns null when transcriptPath is missing or unreadable", () => {
		expect(readSessionTokens(undefined)).toBeNull();
		expect(readSessionTokens(join(tmp, "does-not-exist.jsonl"))).toBeNull();
	});

	it("sums input + output tokens across assistant messages", () => {
		const path = join(tmp, "transcript.jsonl");
		const lines = [
			JSON.stringify({ type: "user", message: { content: "hi" } }),
			JSON.stringify({
				type: "assistant",
				message: { usage: { input_tokens: 1000, output_tokens: 500 } },
			}),
			JSON.stringify({
				type: "assistant",
				message: { usage: { input_tokens: 2000, output_tokens: 750 } },
			}),
		].join("\n");
		writeFileSync(path, `${lines}\n`);
		const tokens = readSessionTokens(path);
		expect(tokens).not.toBeNull();
		expect(tokens!.input).toBe(3000);
		expect(tokens!.output).toBe(1250);
		expect(tokens!.total).toBe(4250);
	});

	it("ignores non-assistant rows and rows missing usage", () => {
		const path = join(tmp, "mixed.jsonl");
		const lines = [
			JSON.stringify({ type: "user", message: { content: "hi" } }),
			JSON.stringify({ type: "assistant", message: {} }),
			JSON.stringify({
				type: "assistant",
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
			}),
		].join("\n");
		writeFileSync(path, `${lines}\n`);
		const tokens = readSessionTokens(path);
		expect(tokens!.total).toBe(150);
	});

	it("tolerates malformed JSONL lines without throwing", () => {
		const path = join(tmp, "broken.jsonl");
		const lines = [
			"not valid json",
			JSON.stringify({
				type: "assistant",
				message: { usage: { input_tokens: 10, output_tokens: 5 } },
			}),
			"another bad line",
		].join("\n");
		writeFileSync(path, `${lines}\n`);
		const tokens = readSessionTokens(path);
		expect(tokens!.total).toBe(15);
	});
});

describe("formatStopNudge", () => {
	const baseOpts = {
		threshold: 5,
		tokenBandLow: 200_000,
		tokenBandHigh: 400_000,
	};

	it("returns null when below threshold", () => {
		expect(
			formatStopNudge({
				...baseOpts,
				uncommittedNonDocCount: 3,
				docFilesExcluded: 1,
			}),
		).toBeNull();
	});

	it("returns a base message at the file-count threshold", () => {
		const msg = formatStopNudge({
			...baseOpts,
			uncommittedNonDocCount: 6,
			docFilesExcluded: 2,
		});
		expect(msg).not.toBeNull();
		expect(msg!).toContain("6 uncommitted code-file edit");
		expect(msg!).toContain("2 doc/plan");
		expect(msg!).toContain("Don't push");
	});

	it("escalates wording above the low token band", () => {
		const msg = formatStopNudge({
			...baseOpts,
			uncommittedNonDocCount: 6,
			docFilesExcluded: 0,
			cumulativeTokens: 250_000,
		});
		expect(msg!).toContain("long session");
		expect(msg!).toMatch(/250k tokens/);
	});

	it("escalates further above the high token band", () => {
		const msg = formatStopNudge({
			...baseOpts,
			uncommittedNonDocCount: 6,
			docFilesExcluded: 0,
			cumulativeTokens: 450_000,
		});
		expect(msg!).toContain("very long session");
		expect(msg!).toContain("context window is degrading");
	});

	it("does not mention tokens when the count is unknown", () => {
		const msg = formatStopNudge({
			...baseOpts,
			uncommittedNonDocCount: 6,
			docFilesExcluded: 0,
		});
		expect(msg!).not.toMatch(/tokens/);
	});
});

describe("formatMidSessionBackstop", () => {
	it("returns null below threshold", () => {
		expect(
			formatMidSessionBackstop({ uncommittedNonDocCount: 39, threshold: 40 }),
		).toBeNull();
	});

	it("returns a mid-session warning at threshold crossing", () => {
		const msg = formatMidSessionBackstop({
			uncommittedNonDocCount: 41,
			threshold: 40,
		});
		expect(msg!).toContain("41 distinct code file");
		expect(msg!).toContain("Commit incrementally");
		expect(msg!).toContain("Don't push");
	});
});
