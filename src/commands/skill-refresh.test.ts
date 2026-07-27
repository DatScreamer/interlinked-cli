import { beforeEach, describe, expect, it, vi } from "vitest";

const installSkillsMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/skill-installers.js", () => ({ installSkills: installSkillsMock }));

import { refreshClientSkills } from "./skill-refresh.js";

describe("refreshClientSkills", () => {
    beforeEach(() => installSkillsMock.mockReset());

    it("is a no-op when no clients are detected", () => {
        expect(refreshClientSkills("/repo", [])).toEqual({
            results: [],
            outputLines: [],
            summary: { clients: [], installed: 0, changed: 0, warnings: [] },
        });
        expect(installSkillsMock).not.toHaveBeenCalled();
    });

    it("summarizes changes and every partial warning", () => {
        installSkillsMock.mockReturnValue([
            {
                skill: "enforce",
                client: "codex",
                path: "/repo/.agents/skills/enforce/SKILL.md",
                installed: true,
                changed: true,
            },
            {
                skill: "interlinked",
                client: "codex",
                path: "/repo/.agents/skills/interlinked/SKILL.md",
                installed: false,
                error: "user-owned target",
            },
        ]);

        const refresh = refreshClientSkills("/repo", ["codex"]);

        expect(installSkillsMock).toHaveBeenCalledWith("/repo", ["codex"]);
        expect(refresh.summary).toEqual({
            clients: ["codex"],
            installed: 1,
            changed: 1,
            warnings: ["interlinked/codex: user-owned target"],
        });
        expect(refresh.outputLines.join("\n")).toContain("1/2 installs");
        expect(refresh.outputLines.join("\n")).toContain("user-owned target");
    });
});
