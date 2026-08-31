import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { installHooks, manifestPath, readManifest, uninstallHooks } from "./installer.js";
import { verifyInstalledRunner } from "./installed-hooks-verify.js";
import { MANAGED_PROVIDER_FILE_MARKER } from "./managed-provider-file.js";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
    const root = mkdtempSync(join(tmpdir(), "interlinked-provider-install-"));
    roots.push(root);
    return root;
}

describe("managed provider bridge installation", () => {
    it.each([
        ["opencode", ".opencode/plugins/interlinked.ts"],
        ["pi", ".pi/extensions/interlinked.js"],
    ] as const)("installs and idempotently refreshes %s", (runner, relativePath) => {
        const cwd = repo();
        const binaryPath = join(cwd, "hook-entry.js");
        const first = installHooks({ cwd, binaryPath, runners: [runner] });
        const target = join(cwd, relativePath);

        expect(first.ok).toBe(true);
        expect(first.entries[0]).toMatchObject({
            runner,
            settings_path: target,
            added_paths: ["$file"],
            artifact_kind: "managed-file",
        });
        expect(readFileSync(target, "utf-8")).toContain(MANAGED_PROVIDER_FILE_MARKER);

        const second = installHooks({ cwd, binaryPath, runners: [runner] });
        expect(second.purged).toBe(0);
        expect(readManifest(manifestPath(cwd))).toHaveLength(1);
    });

	it("refuses to overwrite a foreign file at the managed path", () => {
        const cwd = repo();
        const target = join(cwd, ".opencode", "plugins", "interlinked.ts");
        mkdirSync(join(cwd, ".opencode", "plugins"), { recursive: true });
        writeFileSync(target, "export const userPlugin = true;\n");

        const result = installHooks({
            cwd,
            binaryPath: join(cwd, "hook-entry.js"),
            runners: ["opencode"],
        });

        expect(result.entries).toEqual([]);
        expect(result.skipped[0]?.reason).toContain("refusing to overwrite");
		expect(readFileSync(target, "utf-8")).toContain("userPlugin");
	});

	it("preserves a divergent managed-looking file when no manifest proves its bytes", () => {
		const cwd = repo();
		const target = join(cwd, ".opencode", "plugins", "interlinked.ts");
		mkdirSync(join(cwd, ".opencode", "plugins"), { recursive: true });
		const orphaned = `${MANAGED_PROVIDER_FILE_MARKER}\nexport const customized = true;\n`;
		writeFileSync(target, orphaned);

		const result = installHooks({
			cwd,
			binaryPath: join(cwd, "hook-entry.js"),
			runners: ["opencode"],
		});

		expect(result.entries).toEqual([]);
		expect(result.skipped[0]?.reason).toContain("without matching manifest ownership");
		expect(readFileSync(target, "utf-8")).toBe(orphaned);
	});

	it("refreshes divergent bridge source when the manifest proves the prior bytes", () => {
		const cwd = repo();
		const firstBinary = join(cwd, "hook-entry-v1.js");
		const secondBinary = join(cwd, "hook-entry-v2.js");
		installHooks({ cwd, binaryPath: firstBinary, runners: ["pi"] });
		const target = join(cwd, ".pi", "extensions", "interlinked.js");
		expect(readFileSync(target, "utf-8")).toContain(firstBinary);

		const refresh = installHooks({ cwd, binaryPath: secondBinary, runners: ["pi"] });

		expect(refresh.entries).toHaveLength(1);
		expect(refresh.purged).toBe(1);
		expect(readFileSync(target, "utf-8")).toContain(secondBinary);
	});

	it("preserves a modified bridge and its manifest row on uninstall", () => {
        const cwd = repo();
        const binaryPath = join(cwd, "hook-entry.js");
        installHooks({ cwd, binaryPath, runners: ["pi"] });
        const target = join(cwd, ".pi", "extensions", "interlinked.js");
        writeFileSync(target, `${readFileSync(target, "utf-8")}\n// local edit\n`);

        const result = uninstallHooks({ cwd, runners: ["pi"] });

        expect(result.removed).toEqual([]);
        expect(result.remaining).toHaveLength(1);
        expect(existsSync(target)).toBe(true);
    });

    it("refuses to refresh over a locally modified managed bridge", () => {
        const cwd = repo();
        const binaryPath = join(cwd, "hook-entry.js");
        installHooks({ cwd, binaryPath, runners: ["pi"] });
        const target = join(cwd, ".pi", "extensions", "interlinked.js");
        const modified = `${readFileSync(target, "utf-8")}\n// keep this edit\n`;
        writeFileSync(target, modified);

        const refresh = installHooks({ cwd, binaryPath, runners: ["pi"] });

        expect(refresh.entries).toEqual([]);
        expect(refresh.skipped[0]?.reason).toContain("changed after installation");
        expect(readFileSync(target, "utf-8")).toBe(modified);
        expect(readManifest(manifestPath(cwd))).toHaveLength(1);
    });

    it("verifies exact managed content and reports local edits", () => {
        const cwd = repo();
        const binaryPath = join(cwd, "hook-entry.js");
        const install = installHooks({ cwd, binaryPath, runners: ["opencode"] });
        const entry = nonNull(install.entries[0]);

        expect(verifyInstalledRunner(cwd, entry, binaryPath).verified).toBe(true);
        writeFileSync(entry.settings_path, `${readFileSync(entry.settings_path, "utf-8")}// local edit\n`);
        const drift = verifyInstalledRunner(cwd, entry, binaryPath);
        expect(drift.verified).toBe(false);
        expect(drift.problems.join(" ")).toContain("changed after installation");
    });

    it("dry-run records the intended artifact without writing it", () => {
        const cwd = repo();
        const result = installHooks({
            cwd,
            binaryPath: join(cwd, "hook-entry.js"),
            runners: ["opencode"],
            dryRun: true,
        });
        expect(result.entries).toHaveLength(1);
        expect(existsSync(join(cwd, ".opencode", "plugins", "interlinked.ts"))).toBe(false);
        expect(existsSync(manifestPath(cwd))).toBe(false);
    });
});
