import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKILL_INSTALL_MANIFEST } from "./skill-install-ownership.js";
import {
    installEnforceSkill,
    installSkills,
    uninstallEnforceSkill,
    uninstallSkills,
} from "./skill-installers.js";

let tmpRoot: string;

function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}

beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "skill-installer-safety-"));
});

afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
});

describe("skill install ownership", () => {
    it("refuses to overwrite an unowned runner skill", () => {
        const target = join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md");
        const userContent = "---\nname: enforce\ndescription: user-owned\n---\n# Mine\n";
        write(target, userContent);

        const [result] = installEnforceSkill(tmpRoot, ["claude"]);

        expect(result?.installed).toBe(false);
        expect(result?.error).toContain("Refusing to overwrite unowned skill file");
        expect(readFileSync(target, "utf-8")).toBe(userContent);
    });

    it("preserves a managed file after the user modifies it", () => {
        const target = join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md");
        expect(installEnforceSkill(tmpRoot, ["claude"])[0]?.installed).toBe(true);
        writeFileSync(target, "user modification\n");

        const [reinstall] = installEnforceSkill(tmpRoot, ["claude"]);
        expect(reinstall?.installed).toBe(false);
        expect(reinstall?.error).toContain("modified managed skill file");
        // Other unmodified resources may be removed, but the modified target is preserved.
        expect(uninstallEnforceSkill(tmpRoot, ["claude"])).toBe(true);
        expect(readFileSync(target, "utf-8")).toBe("user modification\n");
    });

    it("rejects a symlinked target parent without writing outside the repo", () => {
        const outside = mkdtempSync(join(tmpdir(), "skill-installer-outside-"));
        mkdirSync(join(tmpRoot, ".claude"), { recursive: true });
        symlinkSync(outside, join(tmpRoot, ".claude", "skills"), "dir");
        try {
            const [result] = installEnforceSkill(tmpRoot, ["claude"]);
            expect(result?.installed).toBe(false);
            expect(result?.error).toContain("symlinked directory");
            expect(existsSync(join(outside, "enforce", "SKILL.md"))).toBe(false);
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });

    it("uninstall leaves an unrelated Copilot teaching prompt untouched", () => {
        const prompt = join(
            tmpRoot,
            ".github",
            "prompts",
            "interlinked-setup.prompt.md",
        );
        write(prompt, "user teaching prompt\n");
        installSkills(tmpRoot, ["copilot"]);

        expect(uninstallSkills(tmpRoot, ["copilot"])).toBe(true);
        expect(readFileSync(prompt, "utf-8")).toBe("user teaching prompt\n");
    });

    it("rejects a forged manifest entry outside a runner skill root", () => {
        const readme = join(tmpRoot, "README.md");
        const content = "repository documentation\n";
        writeFileSync(readme, content);
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            `${JSON.stringify({
                version: 1,
                files: {
                    "README.md": {
                        sha256: createHash("sha256").update(content).digest("hex"),
                        skill: "enforce",
                        owner: "claude",
                        kind: "spec",
                    },
                },
            })}\n`,
        );

        expect(uninstallSkills(tmpRoot, ["claude"])).toBe(false);
        expect(readFileSync(readme, "utf-8")).toBe(content);
    });
});

describe("legacy skill migration", () => {
    it("migrates the old Codex directory only when its content is recognized", () => {
        const current = join(tmpRoot, ".agents", "skills", "enforce", "SKILL.md");
        expect(installEnforceSkill(tmpRoot, ["codex"])[0]?.installed).toBe(true);
        const managedContent = readFileSync(current);
        rmSync(join(tmpRoot, ".agents"), { recursive: true, force: true });

        const legacy = join(tmpRoot, ".codex", "skills", "enforce", "SKILL.md");
        mkdirSync(dirname(legacy), { recursive: true });
        writeFileSync(legacy, managedContent);

        expect(installEnforceSkill(tmpRoot, ["codex"])[0]?.installed).toBe(true);
        expect(existsSync(current)).toBe(true);
        expect(existsSync(legacy)).toBe(false);
    });

    it("repairs a recognized stale description from an unmanifested install", () => {
        const target = join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md");
        expect(installEnforceSkill(tmpRoot, ["claude"])[0]?.installed).toBe(true);
        const stale = readFileSync(target, "utf-8").replace(
            /^description:.*$/m,
            "description: stale unquoted description",
        );
        rmSync(join(tmpRoot, SKILL_INSTALL_MANIFEST), { force: true });
        rmSync(join(tmpRoot, ".interlinked", "skills", "enforce", "agents"), {
            recursive: true,
            force: true,
        });
        rmSync(join(tmpRoot, ".claude", "skills", "enforce", "agents"), {
            recursive: true,
            force: true,
        });
        writeFileSync(target, stale);

        const [result] = installEnforceSkill(tmpRoot, ["claude"]);
        expect(result?.installed).toBe(true);
        expect(readFileSync(target, "utf-8")).not.toContain(
            "description: stale unquoted description",
        );
    });

    it("refreshes matching stale canonical and runner copies from the old installer", () => {
        const canonical = join(
            tmpRoot,
            ".interlinked",
            "skills",
            "interlinked",
            "SKILL.md",
        );
        const runner = join(
            tmpRoot,
            ".claude",
            "skills",
            "interlinked",
            "SKILL.md",
        );
        installSkills(tmpRoot, ["claude"]);
        const oldGenerated = `${readFileSync(canonical, "utf-8")}\n<!-- old generated copy -->\n`;
        writeFileSync(canonical, oldGenerated);
        writeFileSync(runner, oldGenerated);
        rmSync(join(tmpRoot, SKILL_INSTALL_MANIFEST), { force: true });
        rmSync(join(dirname(canonical), "agents"), { recursive: true, force: true });
        rmSync(join(dirname(runner), "agents"), { recursive: true, force: true });

        const result = installSkills(tmpRoot, ["claude"]).find(
            (entry) => entry.skill === "interlinked",
        );

        expect(result?.installed).toBe(true);
        expect(readFileSync(canonical, "utf-8")).not.toContain("old generated copy");
        expect(readFileSync(runner, "utf-8")).not.toContain("old generated copy");
    });
});
