import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSpecCommands } from "./spec.js";

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("interlinked spec agenda", () => {
	it("writes the review-agenda artifact for the repo's markdown corpus", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "spec-cli-")));
		roots.push(cwd);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(
			join(cwd, "PLAN.md"),
			// FG-INV sits under its OWN heading so "## The seven bets" binds only to
			// B — a shared section would spuriously bind "bet"→FG-INV (sol-max #14).
			"## The seven bets\n- B1 a\n- B2 b\n- B3 c\n- B4 d\n- B5 e\n- B6 f\n- B7 g\n## Invariants\n| FG-INV-01 | x |\n| FG-INV-02 | y |",
		);
		writeFileSync(
			join(cwd, "README.md"),
			// "Six bets" on its OWN line: co-locating it with the FG-INV ids would
			// bind "bet"→FG-INV by same-line co-occurrence and re-poison the noun.
			"Six bets do the work.\nFG-INV-01 and FG-INV-02 both apply here.",
		);
		// SPY, not process.chdir(): chdir THROWS in a worker thread
		// ("process.chdir() is not supported in workers"), and Stryker's vitest
		// runner pins its own pool, so a real chdir here fails the mutation dry
		// run for any file whose graph-selected test scope includes this one.
		// The spec command action handlers read `process.cwd()` explicitly, so
		// the spy exercises the same path; `cwd` is already realpathSync'd
		// above, matching what a real chdir would have resolved through.
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const program = new Command();
			registerSpecCommands(program);
			await program.parseAsync(["node", "interlinked", "spec", "agenda"]);
		} finally {
			cwdSpy.mockRestore();
			log.mockRestore();
		}
		const path = join(cwd, ".interlinked", "review-agenda.md");
		expect(existsSync(path)).toBe(true);
		const agenda = readFileSync(path, "utf8");
		expect(agenda).toContain("# Review agenda");
		expect(agenda).toContain("Compose-checks");
		expect(agenda).toContain("FG-INV");
		expect(agenda).toContain("Six bets");
	});
});

describe("interlinked spec invariants", () => {
	it("extracts a markdown registry into a taxonomy artifact", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "spec-inv-")));
		roots.push(cwd);
		writeFileSync(
			join(cwd, "plan.md"),
			"| **FG-INV-18** | indexes never authoritative |\nThe commit stream MUST remain sole truth for recovery.",
		);
		// SPY, not process.chdir(): chdir THROWS in a worker thread
		// ("process.chdir() is not supported in workers"), and Stryker's vitest
		// runner pins its own pool, so a real chdir here fails the mutation dry
		// run for any file whose graph-selected test scope includes this one.
		// The spec command action handler reads `process.cwd()` explicitly for
		// the OUTPUT dir, so the spy covers that; but it also does
		// `readFileSync(file, ...)` on the raw <file> arg, which Node resolves
		// against the REAL OS cwd (not the process.cwd() spy) — so the input
		// path is passed absolute instead. `basename(file)` (used for the
		// output artifact name) is unaffected by that, so the assertions below
		// are unchanged.
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const program = new Command();
			registerSpecCommands(program);
			await program.parseAsync([
				"node",
				"interlinked",
				"spec",
				"invariants",
				join(cwd, "plan.md"),
			]);
		} finally {
			cwdSpy.mockRestore();
			log.mockRestore();
		}
		const artifact = readFileSync(
			join(cwd, ".interlinked", "policies", "plan.md.invariants.md"),
			"utf8",
		);
		expect(artifact).toContain("FG-INV-18");
		expect(artifact).toContain("doctrine");
		expect(artifact).toContain("sole truth");
	});
});
