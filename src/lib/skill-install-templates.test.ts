import { describe, expect, it } from "vitest";
import {
    buildSkillConfig,
    ENFORCE_SHORT_DESCRIPTION,
    renderTargetContent,
    runnerTargets,
    swapFrontmatterDescription,
} from "./skill-install-templates.js";

const SKILL = `---
name: enforce
description: "Long canonical description"
---

# Enforce
`;

describe("skill install templates", () => {
    it("uses each runner's native project skill directory", () => {
        const config = buildSkillConfig("interlinked");
        expect(runnerTargets("claude", "interlinked", config)).toEqual([
            { kind: "spec", relPath: ".claude/skills/interlinked/SKILL.md" },
        ]);
        expect(runnerTargets("codex", "interlinked", config)).toEqual([
            { kind: "spec", relPath: ".agents/skills/interlinked/SKILL.md" },
        ]);
        expect(runnerTargets("gemini", "interlinked", config)).toEqual([
            { kind: "spec", relPath: ".gemini/skills/interlinked/SKILL.md" },
        ]);
        expect(runnerTargets("cursor", "interlinked", config)).toEqual([
            { kind: "spec", relPath: ".cursor/skills/interlinked/SKILL.md" },
        ]);
        expect(runnerTargets("copilot", "interlinked", config)).toEqual([
            { kind: "spec", relPath: ".github/skills/interlinked/SKILL.md" },
        ]);
    });

    it("adds only the intentional Copilot prompt alias", () => {
        const config = buildSkillConfig("enforce");
        expect(runnerTargets("copilot", "enforce", config)).toEqual([
            { kind: "spec", relPath: ".github/skills/enforce/SKILL.md" },
            {
                kind: "copilot-prompt-alias",
                relPath: ".github/prompts/enforce.prompt.md",
            },
        ]);
    });

    it("uses a validator-safe short description where a runner requires it", () => {
        const config = buildSkillConfig("enforce");
        const [codexTarget] = runnerTargets("codex", "enforce", config);
        const [cursorTarget] = runnerTargets("cursor", "enforce", config);
        expect(renderTargetContent("codex", config, codexTarget!, SKILL)).toContain(
            `description: ${JSON.stringify(ENFORCE_SHORT_DESCRIPTION)}`,
        );
        expect(renderTargetContent("cursor", config, cursorTarget!, SKILL)).toContain(
            `description: ${JSON.stringify(ENFORCE_SHORT_DESCRIPTION)}`,
        );
    });

    it("leaves other skill specs byte-equivalent in content", () => {
        const config = buildSkillConfig("interlinked");
        const [target] = runnerTargets("codex", "interlinked", config);
        expect(renderTargetContent("codex", config, target!, SKILL)).toBe(SKILL);
    });

    it("renders a Copilot alias that points at the canonical managed skill", () => {
        const config = buildSkillConfig("enforce");
        const alias = runnerTargets("copilot", "enforce", config).find(
            (target) => target.kind === "copilot-prompt-alias",
        );
        const rendered = renderTargetContent("copilot", config, alias!, SKILL);
        expect(rendered).toContain(".interlinked/skills/enforce/SKILL.md");
        expect(rendered).toContain("name: enforce");
    });

    it("swaps only the frontmatter description", () => {
        const rendered = swapFrontmatterDescription(SKILL, "Short description");
        expect(rendered).toContain('description: "Short description"');
        expect(rendered).toContain("# Enforce");
    });
});
