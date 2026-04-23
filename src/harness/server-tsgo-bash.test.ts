import { describe, expect, it } from "vitest";
import { isBashTsc } from "./server-tsgo-bash.js";

describe("isBashTsc — matching", () => {
	it("matches bare `tsc`", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc" } })).toBe(true);
	});
	it("matches `tsc --noEmit`", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --noEmit" } })).toBe(
			true,
		);
	});
	it("matches `npx tsc`", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "npx tsc --noEmit" } })).toBe(
			true,
		);
	});
	it("matches chained `cd foo && tsc`", () => {
		expect(
			isBashTsc({ tool_name: "Bash", tool_input: { command: "cd x && tsc --noEmit" } }),
		).toBe(true);
	});
});

describe("isBashTsc — non-matching", () => {
	it("does not match non-Bash tools", () => {
		expect(isBashTsc({ tool_name: "Read", tool_input: { command: "tsc" } })).toBe(false);
	});
	it("does not match when tsgo already in use", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "npx tsgo --noEmit" } })).toBe(
			false,
		);
	});
	it("does not match --build mode", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --build" } })).toBe(
			false,
		);
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc -b" } })).toBe(false);
	});
	it("does not match --watch mode", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --watch" } })).toBe(
			false,
		);
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc -w" } })).toBe(false);
	});
	it("does not match --declaration mode", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --declaration" } })).toBe(
			false,
		);
		expect(
			isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --emitDeclarationOnly" } }),
		).toBe(false);
	});
	it("does not match tsc mentioned inside a string", () => {
		expect(
			isBashTsc({ tool_name: "Bash", tool_input: { command: "echo 'run tsc later'" } }),
		).toBe(false);
	});
	it("does not match missing tool_input", () => {
		expect(isBashTsc({ tool_name: "Bash" })).toBe(false);
	});
});
