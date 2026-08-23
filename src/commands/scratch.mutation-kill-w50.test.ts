// Mutation-kill suite for wave pass1_w50 survivors in src/commands/scratch.ts.
// Targets: hasLine trim, appendBlock joiner logic, initScratchDir literal/
// object-literal branches, scratchStatus dir-check, scratchStatusCommand
// template/conditional branches, and the README/IGNORE_MARKER constants.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initScratchDir, scratchStatus, scratchStatusCommand } from "./scratch.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-scratch-mk-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("hasLine — line.trim() (kills 1261c86c3ab36f5b)", () => {
	it("matches a marker line even when surrounded by whitespace", () => {
		writeFileSync(join(tmp, ".gitignore"), "  scratch/*\n");
		const result = initScratchDir(tmp);
		// hasLine must trim before comparing, so the padded line still matches
		// the marker and .gitignore entries are reported as already present.
		expect(result.skipped).toContain(".gitignore entries");
		expect(result.created).not.toContain(".gitignore entries");
	});
});

describe("appendBlock — joiner logic on existing.endsWith(\"\\n\") || existing === \"\"", () => {
	it("inserts a joining newline before the block when existing content has no trailing newline (kills 'true' and '\"\\n\"->\"\"' mutants)", () => {
		// test-contract: public-api — appendBlock's joiner is exercised only
		// through initScratchDir's on-disk .gitignore output.
		writeFileSync(join(tmp, ".gitignore"), "existing content");
		initScratchDir(tmp);
		const content = readFileSync(join(tmp, ".gitignore"), "utf8");
		// GITIGNORE_BLOCK itself starts with "\n", so a real joining "\n" here
		// produces a DOUBLE newline before "#"; the "true"/"\n"->""" mutants
		// collapse the joiner to "" and leave only a single newline.
		expect(content.startsWith("existing content\n\n#")).toBe(true);
		expect(content.startsWith("existing content\n#")).toBe(false);
	});

	it("does not add a joining newline when existing content already ends with one (kills 'false' mutant)", () => {
		// test-contract: public-api — same observable surface as above.
		writeFileSync(join(tmp, ".gitignore"), "existing content\n");
		initScratchDir(tmp);
		const content = readFileSync(join(tmp, ".gitignore"), "utf8");
		// existing already supplies the "\n"; the block's own leading "\n"
		// yields exactly two newlines before "#". The 'false' mutant forces
		// joiner="\n" unconditionally, producing three.
		expect(content.startsWith("existing content\n\n#")).toBe(true);
		expect(content.startsWith("existing content\n\n\n#")).toBe(false);
	});

	it("does not insert a leading newline when the existing file is empty (kills the '&&' and comparison-literal mutants)", () => {
		writeFileSync(join(tmp, ".gitignore"), "");
		initScratchDir(tmp);
		const content = readFileSync(join(tmp, ".gitignore"), "utf8");
		expect(content.startsWith("\n#")).toBe(true);
		expect(content.startsWith("\n\n#")).toBe(false);
	});

	it("uses endsWith, not startsWith, on the trailing check (kills MethodExpression mutant)", () => {
		writeFileSync(join(tmp, ".gitignore"), "\nexisting content");
		initScratchDir(tmp);
		const content = readFileSync(join(tmp, ".gitignore"), "utf8");
		// existing starts-with "\n" but does NOT end with it and is non-empty,
		// so the real endsWith check must still insert a joining newline —
		// giving a double newline before "#". The startsWith mutant reads the
		// leading "\n" as "already ends with a newline" and skips the join,
		// leaving only a single newline.
		expect(content.startsWith("\nexisting content\n\n#")).toBe(true);
		expect(content.startsWith("\nexisting content\n#")).toBe(false);
	});

	it("uses trimStart, not trimEnd, when writing a brand-new file (kills MethodExpression mutant)", () => {
		// .ignore does not exist yet in this fresh tmp dir.
		initScratchDir(tmp);
		const content = readFileSync(join(tmp, ".ignore"), "utf8");
		expect(content.startsWith("#")).toBe(true);
		expect(content.endsWith("\n")).toBe(true);
	});
});

describe("initScratchDir — README branch (symbol a2c4a4644e97fb0e)", () => {
	it("reports README as created (not skipped) when it did not exist", () => {
		const result = initScratchDir(tmp);
		expect(result.created).toContain("scratch/README.md");
		expect(result.skipped).not.toContain("scratch/README.md");
	});

	it("reports README as skipped (not created) when it already exists", () => {
		mkdirSync(join(tmp, "scratch"), { recursive: true });
		writeFileSync(join(tmp, "scratch", "README.md"), "pre-existing");
		const result = initScratchDir(tmp);
		expect(result.skipped).toContain("scratch/README.md");
		expect(result.created).not.toContain("scratch/README.md");
	});

	it("does not throw when scratch/ already exists as a bare directory (kills recursive:true/false mutants)", () => {
		mkdirSync(join(tmp, "scratch"));
		expect(() => initScratchDir(tmp)).not.toThrow();
		expect(existsSync(join(tmp, "scratch", "README.md"))).toBe(true);
	});
});

describe("initScratchDir — .gitignore branch literals", () => {
	it("reports '.gitignore entries' as created when the marker is absent", () => {
		const result = initScratchDir(tmp);
		expect(result.created).toContain(".gitignore entries");
		expect(result.skipped).not.toContain(".gitignore entries");
	});

	it("reports '.gitignore entries' as skipped when the marker is already present", () => {
		writeFileSync(join(tmp, ".gitignore"), "scratch/*\n");
		const result = initScratchDir(tmp);
		expect(result.skipped).toContain(".gitignore entries");
		expect(result.created).not.toContain(".gitignore entries");
	});
});

describe("initScratchDir — .ignore branch literals", () => {
	it("reports '.ignore entries' as created when the marker is absent", () => {
		const result = initScratchDir(tmp);
		expect(result.created).toContain(".ignore entries");
		expect(result.skipped).not.toContain(".ignore entries");
	});

	it("reports '.ignore entries' as skipped when the marker is already present", () => {
		writeFileSync(join(tmp, ".ignore"), "!scratch/\n");
		const result = initScratchDir(tmp);
		expect(result.skipped).toContain(".ignore entries");
		expect(result.created).not.toContain(".ignore entries");
	});
});

describe("scratchStatus — dir existence check (kills 'scratch'->'' mutant)", () => {
	it("reports dir=false when scratch/ does not exist, even though cwd itself exists", () => {
		const status = scratchStatus(tmp);
		expect(status.dir).toBe(false);
	});

	it("reports dir=true after scratch/ has been created", () => {
		initScratchDir(tmp);
		const status = scratchStatus(tmp);
		expect(status.dir).toBe(true);
	});
});

describe("scratchStatus — IGNORE_MARKER constant (kills '\"!scratch/\"'->'' mutant)", () => {
	it("does not treat an unrelated blank line as a match for the ignore-negation marker", () => {
		writeFileSync(join(tmp, ".ignore"), "\nsome-other-entry\n");
		const status = scratchStatus(tmp);
		expect(status.ignoreEntry).toBe(false);
	});
});

describe("initScratchDir — README_CONTENT constant (kills full-string->'' mutant)", () => {
	it("writes the real README body, not an empty file", () => {
		initScratchDir(tmp);
		const content = readFileSync(join(tmp, "scratch", "README.md"), "utf8");
		expect(content).toContain("sanctioned home for session & agent scripts");
		expect(content.length).toBeGreaterThan(100);
	});
});

describe("scratchStatusCommand — printed lines (symbol e191155ee5d5390f)", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	function printed(): string[] {
		return logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
	}

	it("prints a non-empty 'scratch/' status line (kills template->'' mutant)", () => {
		scratchStatusCommand({ cwd: tmp });
		expect(printed().some((l) => l.trim().endsWith("scratch/"))).toBe(true);
	});

	it("prints a non-empty '.gitignore carve-out' status line (kills template->'' mutant)", () => {
		scratchStatusCommand({ cwd: tmp });
		expect(printed().some((l) => l.includes(".gitignore carve-out"))).toBe(true);
	});

	it("prints a non-empty '.ignore search negation' status line (kills template->'' mutant)", () => {
		scratchStatusCommand({ cwd: tmp });
		expect(printed().some((l) => l.includes(".ignore search negation"))).toBe(true);
	});

	it("suggests running init when readme+gitignore are missing but ignore is present (kills 'readme && gitignore -> true' mutant)", () => {
		writeFileSync(join(tmp, ".ignore"), "!scratch/\n");
		scratchStatusCommand({ cwd: tmp });
		expect(printed().some((l) => l.includes("Run `interlinked scratch init`"))).toBe(true);
	});

	it("suggests running init when readme+gitignore are present but ignore is missing (kills '&&->||' second-operator mutant)", () => {
		mkdirSync(join(tmp, "scratch"), { recursive: true });
		writeFileSync(join(tmp, "scratch", "README.md"), "x");
		writeFileSync(join(tmp, ".gitignore"), "scratch/*\n");
		scratchStatusCommand({ cwd: tmp });
		expect(printed().some((l) => l.includes("Run `interlinked scratch init`"))).toBe(true);
	});

	it("suggests running init when readme+ignore are present but gitignore is missing (kills 'readme && gitignore -> readme || gitignore' mutant)", () => {
		mkdirSync(join(tmp, "scratch"), { recursive: true });
		writeFileSync(join(tmp, "scratch", "README.md"), "x");
		writeFileSync(join(tmp, ".ignore"), "!scratch/\n");
		scratchStatusCommand({ cwd: tmp });
		expect(printed().some((l) => l.includes("Run `interlinked scratch init`"))).toBe(true);
	});

	it("does not suggest running init when all three pieces are present", () => {
		mkdirSync(join(tmp, "scratch"), { recursive: true });
		writeFileSync(join(tmp, "scratch", "README.md"), "x");
		writeFileSync(join(tmp, ".gitignore"), "scratch/*\n");
		writeFileSync(join(tmp, ".ignore"), "!scratch/\n");
		scratchStatusCommand({ cwd: tmp });
		expect(printed().some((l) => l.includes("Run `interlinked scratch init`"))).toBe(false);
	});
});
