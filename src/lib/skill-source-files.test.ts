import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { nonNull } from "./non-null.js";
import { findSkillSource, listInstallableSkills } from "./skill-source-files.js";

function yamlString(content: string, key: string): string | null {
    const match = content.match(new RegExp(`^\\s*${key}:\\s*"([^"]+)"\\s*$`, "m"));
    return match?.[1] ?? null;
}

describe("bundled runner metadata", () => {
    it.each(listInstallableSkills())("%s has discoverable OpenAI metadata", (name) => {
        const skillPath = nonNull(findSkillSource(name));
        const metadataPath = join(dirname(skillPath), "agents", "openai.yaml");
        const metadata = readFileSync(metadataPath, "utf-8");
        const shortDescription = yamlString(metadata, "short_description");
        const defaultPrompt = yamlString(metadata, "default_prompt");

        expect(yamlString(metadata, "display_name")).not.toBeNull();
        expect(shortDescription?.length).toBeGreaterThanOrEqual(25);
        expect(shortDescription?.length).toBeLessThanOrEqual(64);
        expect(defaultPrompt).toContain(`$${name}`);
    });

    it("keeps enforce manual-only", () => {
        const skillPath = nonNull(findSkillSource("enforce"));
        const metadata = readFileSync(
            join(dirname(skillPath), "agents", "openai.yaml"),
            "utf-8",
        );
        expect(metadata).toContain("allow_implicit_invocation: false");
    });
});
