import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerQualityCommands } from "./quality.js";

// ---------------------------------------------------------------------------
// Mock every lazily-imported command implementation so the .action bodies run
// end-to-end (option spreads, default cwd, verify target-merge, sync vs await
// baseline calls) without touching the real filesystem, git tree, or network.
// ---------------------------------------------------------------------------
const checkCommand = vi.fn();
const searchCommand = vi.fn();
const multiEditCommand = vi.fn();
const verifyCommand = vi.fn();
const writeCommand = vi.fn();
const structureInitCommand = vi.fn();
const structureScanCommand = vi.fn();
const structureStatusCommand = vi.fn();
const structureAcceptCommand = vi.fn();
const structureDoctorCommand = vi.fn();
const structureBaselineCommand = vi.fn();
const coverageCheckCommand = vi.fn();
const coverageBaselineCommand = vi.fn();
const metricsCommand = vi.fn();
const mutationCheckCommand = vi.fn();
const mutationBaselineCommand = vi.fn();

vi.mock("../commands/check.js", () => ({
	checkCommand: (...args: unknown[]) => checkCommand(...args),
}));
vi.mock("../commands/search.js", () => ({
	searchCommand: (...args: unknown[]) => searchCommand(...args),
}));
vi.mock("../commands/multi-edit.js", () => ({
	multiEditCommand: (...args: unknown[]) => multiEditCommand(...args),
}));
vi.mock("../commands/verify.js", () => ({
	verifyCommand: (...args: unknown[]) => verifyCommand(...args),
}));
vi.mock("../commands/write.js", () => ({
	writeCommand: (...args: unknown[]) => writeCommand(...args),
}));
vi.mock("../commands/structure.js", () => ({
	structureInitCommand: (...args: unknown[]) => structureInitCommand(...args),
	structureScanCommand: (...args: unknown[]) => structureScanCommand(...args),
	structureStatusCommand: (...args: unknown[]) => structureStatusCommand(...args),
	structureAcceptCommand: (...args: unknown[]) => structureAcceptCommand(...args),
	structureDoctorCommand: (...args: unknown[]) => structureDoctorCommand(...args),
	structureBaselineCommand: (...args: unknown[]) => structureBaselineCommand(...args),
}));
vi.mock("../commands/coverage.js", () => ({
	coverageCheckCommand: (...args: unknown[]) => coverageCheckCommand(...args),
	coverageBaselineCommand: (...args: unknown[]) => coverageBaselineCommand(...args),
}));
vi.mock("../commands/metrics.js", () => ({
	metricsCommand: (...args: unknown[]) => metricsCommand(...args),
}));
vi.mock("../commands/mutation.js", () => ({
	mutationCheckCommand: (...args: unknown[]) => mutationCheckCommand(...args),
	mutationBaselineCommand: (...args: unknown[]) => mutationBaselineCommand(...args),
}));

function sub(program: Command, parent: string): Command {
	const found = program.commands.find((c) => c.name() === parent);
	if (!found) throw new Error(`missing parent command: ${parent}`);
	return found;
}

function build(): Command {
	const program = new Command();
	program.exitOverride(); // throw instead of process.exit on parse errors
	registerQualityCommands(program);
	return program;
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ===========================================================================
// Structure (registration shape) — kept from the original suite, extended.
// ===========================================================================
describe("registerQualityCommands — structure", () => {
	it("registers the quality / edit top-level commands", () => {
		const program = new Command();
		registerQualityCommands(program);
		const top = program.commands.map((c) => c.name());
		for (const name of [
			"check",
			"search",
			"multi-edit",
			"verify",
			"write",
			"structure",
			"coverage",
			"mutation",
			"metrics",
		]) {
			expect(top).toContain(name);
		}
	});

	it("registers structure / coverage / mutation subcommands", () => {
		const program = new Command();
		registerQualityCommands(program);
		expect(sub(program, "structure").commands.map((c) => c.name()).sort()).toEqual(
			["accept", "baseline", "doctor", "init", "scan", "status"].sort(),
		);
		expect(sub(program, "coverage").commands.map((c) => c.name()).sort()).toEqual(
			["baseline", "check"].sort(),
		);
		expect(sub(program, "mutation").commands.map((c) => c.name()).sort()).toEqual(
			["baseline", "check"].sort(),
		);
	});

	it("wires the documented options on each top-level command", () => {
		const program = build();
		const optsOf = (name: string) =>
			program.commands
				.find((c) => c.name() === name)
				?.options.map((o) => o.long)
				.sort();
		expect(optsOf("check")).toEqual(["--cwd", "--json", "--only", "--report", "--tools"].sort());
		expect(optsOf("search")).toEqual(
			["--context", "--engine", "--full", "--glob", "--json", "--limit", "--path", "--short", "--type"].sort(),
		);
		expect(optsOf("multi-edit")).toEqual(["--json", "--manifest", "--stdin"].sort());
		expect(optsOf("verify")).toEqual(
			[
				"--adoption-gate",
				"--all-checks",
				"--branch",
				"--cwd",
				"--dead-code",
				"--details",
				"--json",
				"--only",
				"--show-suppressions",
				"--skip",
				"--structure",
				"--structure-only",
				"--subdir",
				"--suggestions",
				"--suppress",
			].sort(),
		);
		expect(optsOf("write")).toEqual(
			["--batch", "--from-file", "--json", "--stdin", "--unsafe-outside-repo"].sort(),
		);
		expect(optsOf("metrics")).toEqual(["--cwd", "--json", "--short", "--top"].sort());
	});

	it("wires the documented options on structure subcommands", () => {
		const program = build();
		const struct = sub(program, "structure");
		const optsOf = (name: string) =>
			struct.commands
				.find((c) => c.name() === name)
				?.options.map((o) => o.long)
				.sort();
		expect(optsOf("init")).toEqual(["--json", "--mode", "--with", "--write"].sort());
		expect(optsOf("scan")).toEqual(["--full", "--incremental", "--json"].sort());
		expect(optsOf("status")).toEqual(["--json"]);
		expect(optsOf("accept")).toEqual(["--json"]);
		expect(optsOf("doctor")).toEqual(["--json"]);
		expect(optsOf("baseline")).toEqual(["--json"]);
	});

	it("wires the documented options on coverage / mutation subcommands", () => {
		const program = build();
		const cov = sub(program, "coverage");
		const mut = sub(program, "mutation");
		const optsOf = (parent: Command, name: string) =>
			parent.commands
				.find((c) => c.name() === name)
				?.options.map((o) => o.long)
				.sort();
		expect(optsOf(cov, "check")).toEqual(
			["--baseline", "--json", "--summary", "--update-baseline"].sort(),
		);
		expect(optsOf(cov, "baseline")).toEqual(["--json"]);
		expect(optsOf(mut, "check")).toEqual(
			["--baseline", "--json", "--report", "--update-baseline"].sort(),
		);
		expect(optsOf(mut, "baseline")).toEqual(["--json"]);
	});

	it("applies the documented default option values", () => {
		const program = build();
		const defOf = (cmd: Command | undefined, long: string) =>
			cmd?.options.find((o) => o.long === long)?.defaultValue;
		const structInit = sub(program, "structure").commands.find((c) => c.name() === "init");
		const covCheck = sub(program, "coverage").commands.find((c) => c.name() === "check");
		const mutCheck = sub(program, "mutation").commands.find((c) => c.name() === "check");
		expect(defOf(structInit, "--mode")).toBe("standard");
		expect(defOf(covCheck, "--summary")).toBe("coverage/coverage-summary.json");
		expect(defOf(mutCheck, "--report")).toBe("reports/mutation/mutation.json");
	});
});

// ===========================================================================
// check — action wiring
// ===========================================================================
describe("check — action wiring", () => {
	it("forwards all options to checkCommand", async () => {
		const program = build();
		await program.parseAsync(
			["check", "--only", "tsc", "--tools", "biome,eslint", "--report", "--json", "--cwd", "/c"],
			{ from: "user" },
		);
		expect(checkCommand).toHaveBeenCalledWith({
			only: "tsc",
			tools: "biome,eslint",
			report: true,
			json: true,
			cwd: "/c",
		});
	});

	it("passes empty opts to checkCommand by default", async () => {
		const program = build();
		await program.parseAsync(["check"], { from: "user" });
		expect(checkCommand).toHaveBeenCalledWith({});
	});

	it("treats --tools as a boolean flag when its optional value is omitted", async () => {
		const program = build();
		await program.parseAsync(["check", "--tools"], { from: "user" });
		expect(checkCommand).toHaveBeenCalledWith({ tools: true });
	});
});

// ===========================================================================
// search — action wiring (required <query> arg)
// ===========================================================================
describe("search — action wiring", () => {
	it("forwards query + all options to searchCommand", async () => {
		const program = build();
		await program.parseAsync(
			[
				"search",
				"needle",
				"--path",
				"/src",
				"--glob",
				"*.ts",
				"--type",
				"ts",
				"--limit",
				"50",
				"--context",
				"3",
				"--engine",
				"ripgrep",
				"--json",
			],
			{ from: "user" },
		);
		expect(searchCommand).toHaveBeenCalledWith("needle", {
			path: "/src",
			glob: "*.ts",
			type: "ts",
			limit: "50",
			context: "3",
			engine: "ripgrep",
			json: true,
		});
	});

	it("forwards the query with empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["search", "foo"], { from: "user" });
		expect(searchCommand).toHaveBeenCalledWith("foo", {});
	});

	it("supports the --short / --full output flags", async () => {
		const program = build();
		await program.parseAsync(["search", "bar", "--short", "--full"], { from: "user" });
		expect(searchCommand).toHaveBeenCalledWith("bar", { short: true, full: true });
	});
});

// ===========================================================================
// multi-edit — action wiring (optional [path] arg)
// ===========================================================================
describe("multi-edit — action wiring", () => {
	it("forwards path + options to multiEditCommand", async () => {
		const program = build();
		await program.parseAsync(
			["multi-edit", "src/a.ts", "--manifest", "m.json", "--json"],
			{ from: "user" },
		);
		expect(multiEditCommand).toHaveBeenCalledWith("src/a.ts", {
			manifest: "m.json",
			json: true,
		});
	});

	it("passes undefined path and the --stdin flag when path omitted", async () => {
		const program = build();
		await program.parseAsync(["multi-edit", "--stdin"], { from: "user" });
		expect(multiEditCommand).toHaveBeenCalledWith(undefined, { stdin: true });
	});

	it("passes undefined path and empty opts when nothing supplied", async () => {
		const program = build();
		await program.parseAsync(["multi-edit"], { from: "user" });
		expect(multiEditCommand).toHaveBeenCalledWith(undefined, {});
	});
});

// ===========================================================================
// verify — action wiring (target folded into the opts object; both branches)
// ===========================================================================
describe("verify — action wiring + target merge", () => {
	it("merges an explicit target into the opts object", async () => {
		const program = build();
		await program.parseAsync(["verify", "/repo", "--only", "tsc", "--json"], { from: "user" });
		expect(verifyCommand).toHaveBeenCalledWith({ only: "tsc", json: true, target: "/repo" });
	});

	it("omits the target key entirely when no target is given", async () => {
		const program = build();
		await program.parseAsync(["verify", "--all-checks"], { from: "user" });
		expect(verifyCommand).toHaveBeenCalledWith({ allChecks: true });
		// belt-and-suspenders: the false branch of the spread must not add `target`.
		expect(verifyCommand.mock.calls[0]?.[0]).not.toHaveProperty("target");
	});

	it("forwards the full option surface (camelCased) plus variadic --suppress", async () => {
		const program = build();
		await program.parseAsync(
			[
				"verify",
				"https://github.com/o/r",
				"--only",
				"biome",
				"--suggestions",
				"--json",
				"--details",
				"--cwd",
				"/w",
				"--branch",
				"main",
				"--subdir",
				"pkg",
				"--skip",
				"semgrep,knip",
				"--suppress",
				"a.ts:rule",
				"b.ts:rule:why",
				"--show-suppressions",
				"--structure",
				"--structure-only",
				"--adoption-gate",
				"--all-checks",
				"--dead-code",
			],
			{ from: "user" },
		);
		expect(verifyCommand).toHaveBeenCalledWith({
			target: "https://github.com/o/r",
			only: "biome",
			suggestions: true,
			json: true,
			details: true,
			cwd: "/w",
			branch: "main",
			subdir: "pkg",
			skip: "semgrep,knip",
			suppress: ["a.ts:rule", "b.ts:rule:why"],
			showSuppressions: true,
			structure: true,
			structureOnly: true,
			adoptionGate: true,
			allChecks: true,
			deadCode: true,
		});
	});
});

// ===========================================================================
// write — action wiring (optional [path] arg)
// ===========================================================================
describe("write — action wiring", () => {
	it("forwards path + all options to writeCommand", async () => {
		const program = build();
		await program.parseAsync(
			[
				"write",
				"src/x.ts",
				"--stdin",
				"--from-file",
				"src.txt",
				"--batch",
				"b.json",
				"--unsafe-outside-repo",
				"--json",
			],
			{ from: "user" },
		);
		expect(writeCommand).toHaveBeenCalledWith("src/x.ts", {
			stdin: true,
			fromFile: "src.txt",
			batch: "b.json",
			unsafeOutsideRepo: true,
			json: true,
		});
	});

	it("passes undefined path and empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["write"], { from: "user" });
		expect(writeCommand).toHaveBeenCalledWith(undefined, {});
	});
});

// ===========================================================================
// structure subcommands — action wiring
// ===========================================================================
describe("structure subcommands — action wiring", () => {
	it("init forwards options including the default --mode standard", async () => {
		const program = build();
		await program.parseAsync(["structure", "init"], { from: "user" });
		expect(structureInitCommand).toHaveBeenCalledWith({ mode: "standard" });
	});

	it("init forwards explicit options", async () => {
		const program = build();
		await program.parseAsync(
			["structure", "init", "--mode", "strict", "--with", "module,env", "--write", "--json"],
			{ from: "user" },
		);
		expect(structureInitCommand).toHaveBeenCalledWith({
			mode: "strict",
			with: "module,env",
			write: true,
			json: true,
		});
	});

	it("scan forwards its options", async () => {
		const program = build();
		await program.parseAsync(["structure", "scan", "--full", "--incremental", "--json"], {
			from: "user",
		});
		expect(structureScanCommand).toHaveBeenCalledWith({
			full: true,
			incremental: true,
			json: true,
		});
	});

	it("scan passes empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["structure", "scan"], { from: "user" });
		expect(structureScanCommand).toHaveBeenCalledWith({});
	});

	it("status forwards --json", async () => {
		const program = build();
		await program.parseAsync(["structure", "status", "--json"], { from: "user" });
		expect(structureStatusCommand).toHaveBeenCalledWith({ json: true });
	});

	it("accept forwards --json", async () => {
		const program = build();
		await program.parseAsync(["structure", "accept", "--json"], { from: "user" });
		expect(structureAcceptCommand).toHaveBeenCalledWith({ json: true });
	});

	it("doctor passes empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["structure", "doctor"], { from: "user" });
		expect(structureDoctorCommand).toHaveBeenCalledWith({});
	});

	it("baseline forwards the action arg and opts", async () => {
		const program = build();
		await program.parseAsync(["structure", "baseline", "save", "--json"], { from: "user" });
		expect(structureBaselineCommand).toHaveBeenCalledWith("save", { json: true });
	});

	it("baseline forwards the action arg with empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["structure", "baseline", "clear"], { from: "user" });
		expect(structureBaselineCommand).toHaveBeenCalledWith("clear", {});
	});
});

// ===========================================================================
// coverage subcommands — action wiring (check is awaited; baseline is sync)
// ===========================================================================
describe("coverage subcommands — action wiring", () => {
	it("check forwards options including the default --summary", async () => {
		const program = build();
		await program.parseAsync(["coverage", "check"], { from: "user" });
		expect(coverageCheckCommand).toHaveBeenCalledWith({
			summary: "coverage/coverage-summary.json",
		});
	});

	it("check forwards explicit options", async () => {
		const program = build();
		await program.parseAsync(
			[
				"coverage",
				"check",
				"--summary",
				"cov.json",
				"--baseline",
				"base.json",
				"--update-baseline",
				"--json",
			],
			{ from: "user" },
		);
		expect(coverageCheckCommand).toHaveBeenCalledWith({
			summary: "cov.json",
			baseline: "base.json",
			updateBaseline: true,
			json: true,
		});
	});

	it("runs check as the default subcommand of `coverage`", async () => {
		const program = build();
		await program.parseAsync(["coverage"], { from: "user" });
		expect(coverageCheckCommand).toHaveBeenCalledWith({
			summary: "coverage/coverage-summary.json",
		});
	});

	it("baseline forwards --json (sync call)", async () => {
		const program = build();
		await program.parseAsync(["coverage", "baseline", "--json"], { from: "user" });
		expect(coverageBaselineCommand).toHaveBeenCalledWith({ json: true });
	});

	it("baseline passes empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["coverage", "baseline"], { from: "user" });
		expect(coverageBaselineCommand).toHaveBeenCalledWith({});
	});
});

// ===========================================================================
// metrics — action wiring
// ===========================================================================
describe("metrics — action wiring", () => {
	it("forwards all options to metricsCommand", async () => {
		const program = build();
		await program.parseAsync(
			["metrics", "--cwd", "/m", "--top", "10", "--json", "--short"],
			{ from: "user" },
		);
		expect(metricsCommand).toHaveBeenCalledWith({
			cwd: "/m",
			top: "10",
			json: true,
			short: true,
		});
	});

	it("passes empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["metrics"], { from: "user" });
		expect(metricsCommand).toHaveBeenCalledWith({});
	});
});

// ===========================================================================
// mutation subcommands — action wiring (check is awaited; baseline is sync)
// ===========================================================================
describe("mutation subcommands — action wiring", () => {
	it("check forwards options including the default --report", async () => {
		const program = build();
		await program.parseAsync(["mutation", "check"], { from: "user" });
		expect(mutationCheckCommand).toHaveBeenCalledWith({
			report: "reports/mutation/mutation.json",
		});
	});

	it("check forwards explicit options", async () => {
		const program = build();
		await program.parseAsync(
			[
				"mutation",
				"check",
				"--report",
				"mut.json",
				"--baseline",
				"mb.json",
				"--update-baseline",
				"--json",
			],
			{ from: "user" },
		);
		expect(mutationCheckCommand).toHaveBeenCalledWith({
			report: "mut.json",
			baseline: "mb.json",
			updateBaseline: true,
			json: true,
		});
	});

	it("runs check as the default subcommand of `mutation`", async () => {
		const program = build();
		await program.parseAsync(["mutation"], { from: "user" });
		expect(mutationCheckCommand).toHaveBeenCalledWith({
			report: "reports/mutation/mutation.json",
		});
	});

	it("baseline forwards --json (sync call)", async () => {
		const program = build();
		await program.parseAsync(["mutation", "baseline", "--json"], { from: "user" });
		expect(mutationBaselineCommand).toHaveBeenCalledWith({ json: true });
	});

	it("baseline passes empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["mutation", "baseline"], { from: "user" });
		expect(mutationBaselineCommand).toHaveBeenCalledWith({});
	});
});
