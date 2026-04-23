import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completionsCommand } from "./completions.js";

describe("completionsCommand", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		process.exitCode = 0;
	});

	afterEach(() => {
		logSpy.mockRestore();
		errSpy.mockRestore();
		process.exitCode = 0;
	});

	it("prints bash completions for 'bash'", async () => {
		await completionsCommand("bash");
		expect(logSpy).toHaveBeenCalled();
	});

	it("prints zsh completions for 'zsh'", async () => {
		await completionsCommand("zsh");
		expect(logSpy).toHaveBeenCalled();
	});

	it("prints fish completions for 'fish'", async () => {
		await completionsCommand("fish");
		expect(logSpy).toHaveBeenCalled();
	});

	it("is case-insensitive on the shell name", async () => {
		await completionsCommand("BASH");
		expect(logSpy).toHaveBeenCalled();
	});

	it("exits with code 1 for an unknown shell", async () => {
		await completionsCommand("powershell");
		expect(errSpy).toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});
});
