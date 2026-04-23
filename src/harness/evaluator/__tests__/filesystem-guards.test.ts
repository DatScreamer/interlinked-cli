import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateProtectedFiles, evaluateRepoConfinement } from "../filesystem-guards.js";

describe("evaluateProtectedFiles", () => {
	it("blocks a matching glob with a blanket block reason", () => {
		const decision = evaluateProtectedFiles({
			toolName: "Write",
			filePath: ".env",
			content: "SECRET=x",
			protectedFiles: [
				{ glob: "**/.env", reason: "nope", operations: ["Write"] as unknown as string[] },
			] as unknown as Parameters<typeof evaluateProtectedFiles>[0]["protectedFiles"],
			containsSecrets: () => true,
		});
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toBe("nope");
	});

	it("lets writes pass when the rule is secrets-only and content has no secrets", () => {
		const decision = evaluateProtectedFiles({
			toolName: "Write",
			filePath: ".env",
			content: "SAFE=1",
			protectedFiles: [
				{
					glob: "**/.env",
					reason: "secrets only",
					check: "secrets",
					operations: ["Write"] as unknown as string[],
				},
			] as unknown as Parameters<typeof evaluateProtectedFiles>[0]["protectedFiles"],
			containsSecrets: () => false,
		});
		expect(decision).toBeNull();
	});

	it("returns null when no rule glob matches", () => {
		expect(
			evaluateProtectedFiles({
				toolName: "Write",
				filePath: "src/x.ts",
				content: "x",
				protectedFiles: [
					{
						glob: "**/.env",
						reason: "env",
						operations: ["Write"] as unknown as string[],
					},
				] as unknown as Parameters<typeof evaluateProtectedFiles>[0]["protectedFiles"],
				containsSecrets: () => true,
			}),
		).toBeNull();
	});
});

describe("evaluateRepoConfinement", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "confine-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null for paths inside the repo", () => {
		expect(
			evaluateRepoConfinement({
				rawPath: "src/foo.ts",
				cwd: tmpDir,
				allowlist: [],
			}),
		).toBeNull();
	});

	it("blocks paths outside the repo that are not allowlisted", () => {
		const decision = evaluateRepoConfinement({
			rawPath: "/tmp/outside.txt",
			cwd: tmpDir,
			allowlist: [],
		});
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("builtin-repo-confinement");
	});

	it("permits paths in an allowlisted prefix", () => {
		expect(
			evaluateRepoConfinement({
				rawPath: "/tmp/outside.txt",
				cwd: tmpDir,
				allowlist: ["/tmp"],
			}),
		).toBeNull();
	});
});
