import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerSimplifyCommands } from "./simplification.js";

describe("registerSimplifyCommands", () => {
	// test-contract: public-api — the namespace exposes three report depths and
	// the local recorded-run view without changing the top-level audit command
	it("registers scan, review, audit, and status", () => {
		const program = new Command();
		registerSimplifyCommands(program);
		const simplify = program.commands.find((command) => command.name() === "simplify");
		expect(simplify?.commands.map((command) => command.name())).toEqual([
			"scan",
			"review",
			"audit",
			"status",
		]);
	});

	// test-contract: public-api — review and audit advertise the git-scope and
	// explicit non-submitting deep-handoff switches
	it("registers scope and handoff options", () => {
		const program = new Command();
		registerSimplifyCommands(program);
		const simplify = program.commands.find((command) => command.name() === "simplify");
		const review = simplify?.commands.find((command) => command.name() === "review");
		const audit = simplify?.commands.find((command) => command.name() === "audit");
		expect(review?.options.map((option) => option.long)).toContain("--range");
		expect(audit?.options.map((option) => option.long)).toContain("--deep-handoff");
		expect(review?.options.map((option) => option.long)).toContain("--deep-handoff");
	});

	// test-contract: public-api — persistence is consistent and opt-in for
	// every local report execution while status remains a read-only view
	it("registers record on all report commands but not status", () => {
		const program = new Command();
		registerSimplifyCommands(program);
		const simplify = program.commands.find((command) => command.name() === "simplify");
		for (const name of ["scan", "review", "audit"]) {
			const command = simplify?.commands.find((candidate) => candidate.name() === name);
			expect(command?.options.map((option) => option.long)).toContain("--record");
		}
		const status = simplify?.commands.find((command) => command.name() === "status");
		expect(status?.options.map((option) => option.long)).not.toContain("--record");
		expect(status?.options.map((option) => option.long)).toEqual(["--cwd", "--json"]);
	});
});
