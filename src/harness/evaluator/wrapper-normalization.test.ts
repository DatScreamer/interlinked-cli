import { describe, expect, it } from "vitest";
import { normalizeCommandWrappers } from "./wrapper-normalization.js";

describe("normalizeCommandWrappers", () => {
	it("strips a bare sudo prefix", () => {
		expect(normalizeCommandWrappers("sudo rm -rf /")).toBe("rm -rf /");
	});

	it("strips sudo with short flags", () => {
		expect(normalizeCommandWrappers("sudo -E rm -rf /")).toBe("rm -rf /");
	});

	it("strips sudo with long flags + values", () => {
		expect(normalizeCommandWrappers("sudo --preserve-env=PATH rm -rf /")).toBe("rm -rf /");
	});

	it("strips doas prefix", () => {
		expect(normalizeCommandWrappers("doas rm -rf /")).toBe("rm -rf /");
	});

	it("strips env VAR=value prefixes", () => {
		expect(normalizeCommandWrappers("env A=1 B=2 git push --force")).toBe("git push --force");
	});

	it("strips command -p", () => {
		expect(normalizeCommandWrappers("command -p git rebase -i")).toBe("git rebase -i");
	});

	it("strips alias-bypass backslash", () => {
		expect(normalizeCommandWrappers("\\git reset --hard")).toBe("git reset --hard");
	});

	it("composes wrappers (sudo + command -p + \\git)", () => {
		expect(normalizeCommandWrappers("sudo command -p \\git rebase -i")).toBe("git rebase -i");
	});

	it("is idempotent", () => {
		const cmd = "sudo -E env FOO=bar \\rm -rf /";
		const once = normalizeCommandWrappers(cmd);
		const twice = normalizeCommandWrappers(once);
		expect(twice).toBe(once);
	});

	it("leaves unwrapped commands untouched", () => {
		expect(normalizeCommandWrappers("rm -rf /")).toBe("rm -rf /");
		expect(normalizeCommandWrappers("git push")).toBe("git push");
		expect(normalizeCommandWrappers("npm install")).toBe("npm install");
	});

	it("does not strip prefixes that aren't wrappers", () => {
		// `sudoers` is not `sudo`; `envoy` is not `env`; `\1` is a regex backref shape, not alias bypass.
		expect(normalizeCommandWrappers("sudoers cmd")).toBe("sudoers cmd");
		expect(normalizeCommandWrappers("envoy run")).toBe("envoy run");
		expect(normalizeCommandWrappers("\\1abc")).toBe("\\1abc");
	});

	it("trims leading whitespace before applying wrappers", () => {
		expect(normalizeCommandWrappers("   sudo rm -rf /")).toBe("rm -rf /");
	});
});
