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

	// --- Linked workspace (multi-repo) ---

	it("permits writes to a declared linked project (absolute sibling root)", () => {
		const sibling = mkdtempSync(join(tmpdir(), "confine-linked-"));
		try {
			expect(
				evaluateRepoConfinement({
					rawPath: join(sibling, "cloud", "worker.ts"),
					cwd: tmpDir,
					allowlist: [],
					linkedProjects: [sibling],
				}),
			).toBeNull();
		} finally {
			rmSync(sibling, { recursive: true, force: true });
		}
	});

	it("resolves a relative linked project against the project root", () => {
		const sibling = mkdtempSync(join(tmpdir(), "confine-linked-"));
		try {
			const rel = join("..", sibling.split("/").pop() as string);
			expect(
				evaluateRepoConfinement({
					rawPath: join(sibling, "x.ts"),
					cwd: tmpDir,
					allowlist: [],
					linkedProjects: [rel],
				}),
			).toBeNull();
		} finally {
			rmSync(sibling, { recursive: true, force: true });
		}
	});

	it("still blocks paths outside primary + linked + allowlist", () => {
		const sibling = mkdtempSync(join(tmpdir(), "confine-linked-"));
		try {
			const decision = evaluateRepoConfinement({
				rawPath: "/tmp/elsewhere.txt",
				cwd: tmpDir,
				allowlist: [],
				linkedProjects: [sibling],
			});
			expect(decision?.decision).toBe("block");
			expect(decision?.rule_id).toBe("builtin-repo-confinement");
		} finally {
			rmSync(sibling, { recursive: true, force: true });
		}
	});

	it("does not change single-root behavior when linkedProjects is empty/absent", () => {
		expect(
			evaluateRepoConfinement({ rawPath: "/tmp/x.txt", cwd: tmpDir, allowlist: [], linkedProjects: [] })
				?.decision,
		).toBe("block");
		expect(evaluateRepoConfinement({ rawPath: "src/ok.ts", cwd: tmpDir, allowlist: [] })).toBeNull();
	});
});
