import { describe, expect, it } from "vitest";
import { isReadOnlyToolName, READ_ONLY_TOOL_NAMES } from "./hook-read-only-tools.js";

describe("READ_ONLY_TOOL_NAMES", () => {
	it("P1: names the file readers and collaboration-control tools", () => {
		expect([...READ_ONLY_TOOL_NAMES]).toEqual([
			"Read",
			"Glob",
			"Grep",
			"WebFetch",
			"WebSearch",
			"TodoRead",
			"NotebookRead",
			"ListFiles",
			"collaborationspawn_agent",
			"collaborationsend_message",
			"collaborationfollowup_task",
			"collaborationinterrupt_agent",
			"collaborationlist_agents",
			"collaborationwait_agent",
		]);
	});

	it("N1: does NOT list Bash — a shell command's effects are only knowable post-call", () => {
		expect([...READ_ONLY_TOOL_NAMES]).not.toContain("Bash");
	});

	it("N2: does NOT list any write tool", () => {
		for (const writer of ["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]) {
			expect([...READ_ONLY_TOOL_NAMES]).not.toContain(writer);
		}
	});
});

describe("isReadOnlyToolName — positive (must report read-only)", () => {
	it("P1: every canonical name in the list", () => {
		for (const name of READ_ONLY_TOOL_NAMES) {
			expect(isReadOnlyToolName(name)).toBe(true);
		}
	});

	it("P2: the normalized lowercase_snake spelling other runners deliver", () => {
		expect(isReadOnlyToolName("web_fetch")).toBe(true);
		expect(isReadOnlyToolName("web_search")).toBe(true);
		expect(isReadOnlyToolName("notebook_read")).toBe(true);
	});

	it("P3: plain lowercase", () => {
		expect(isReadOnlyToolName("read")).toBe(true);
		expect(isReadOnlyToolName("grep")).toBe(true);
	});

	it("P4: successful collaboration-control calls are non-writing", () => {
		for (const name of [
			"collaborationspawn_agent",
			"collaborationwait_agent",
			"collaboration.list_agents",
		]) {
			expect(isReadOnlyToolName(name)).toBe(true);
		}
	});
});

describe("isReadOnlyToolName — negative (must NOT report read-only)", () => {
	it("N1: Bash keeps its ChangeSet — it is the bash-edit obligation channel", () => {
		expect(isReadOnlyToolName("Bash")).toBe(false);
		expect(isReadOnlyToolName("bash")).toBe(false);
	});

	it("N2: the write tools", () => {
		expect(isReadOnlyToolName("Write")).toBe(false);
		expect(isReadOnlyToolName("Edit")).toBe(false);
		expect(isReadOnlyToolName("MultiEdit")).toBe(false);
		expect(isReadOnlyToolName("NotebookEdit")).toBe(false);
		expect(isReadOnlyToolName("apply_patch")).toBe(false);
	});

	it("N3: an unknown tool is NOT assumed read-only", () => {
		expect(isReadOnlyToolName("mcp__filesystem__write_file")).toBe(false);
		expect(isReadOnlyToolName("SomeFutureTool")).toBe(false);
	});

	it("N4: empty / absent names", () => {
		expect(isReadOnlyToolName("")).toBe(false);
		expect(isReadOnlyToolName(null)).toBe(false);
		expect(isReadOnlyToolName(undefined)).toBe(false);
	});

	it("N5: a name that merely CONTAINS a read-only name is not read-only", () => {
		expect(isReadOnlyToolName("ReadAndWrite")).toBe(false);
		expect(isReadOnlyToolName("GrepReplace")).toBe(false);
	});
});
