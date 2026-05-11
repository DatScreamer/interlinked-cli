// Tests for child_process / shell-injection footgun detectors.

import { describe, expect, it } from "vitest";
import { CHILD_PROCESS_FOOTGUNS } from "./child-process.js";

function find(id: string) {
	const f = CHILD_PROCESS_FOOTGUNS.find((g) => g.id === id);
	if (!f) throw new Error(`footgun ${id} not registered`);
	return f;
}

describe("child_process_exec_interpolated", () => {
	const fg = find("child_process_exec_interpolated");

	it("fires on exec(template literal with ${...})", () => {
		const content = "exec(`ls -l ${userPath}`);";
		expect(fg.detect(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it("fires on execSync(template literal with ${...})", () => {
		const content = "execSync(`grep ${pattern} *.log`);";
		expect(fg.detect(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it("fires on exec with string concat", () => {
		const content = `exec("rm -rf " + userArg);`;
		expect(fg.detect(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire on exec(literal string)", () => {
		const content = `exec("ls -l");`;
		expect(fg.detect(content, "src/x.ts")).toEqual([]);
	});

	it("does NOT fire on spawn / execFile (already safe argv form)", () => {
		const content = "spawn('ls', ['-l', userPath]);";
		expect(fg.detect(content, "src/x.ts")).toEqual([]);
	});
});
