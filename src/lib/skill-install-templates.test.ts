// Tests for the pure per-runner rendering half of the skill installer.
import { describe, expect, it } from "vitest";
import {
	buildSkillConfig,
	ENFORCE_SHORT_DESCRIPTION,
	extractFrontmatterDescription,
	genericCursorAlias,
	quoteYamlDouble,
	renderTargetContent,
	runnerTargets,
	swapFrontmatterDescription,
} from "./skill-install-templates.js";

const SAMPLE = `---
name: interlinked-setup
description: "Install and operate the harness."
---

# body line
`;

describe("quoteYamlDouble", () => {
	it("wraps in double quotes and escapes backslashes and quotes", () => {
		expect(quoteYamlDouble('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
	});
});

describe("extractFrontmatterDescription", () => {
	it("reads a double-quoted description", () => {
		expect(extractFrontmatterDescription(SAMPLE)).toBe("Install and operate the harness.");
	});

	it("reads a bare inline description", () => {
		const bare = "---\nname: x\ndescription: plain words here\n---\nbody\n";
		expect(extractFrontmatterDescription(bare)).toBe("plain words here");
	});

	it("returns empty string when no frontmatter", () => {
		expect(extractFrontmatterDescription("# just a heading\n")).toBe("");
	});
});

describe("genericCursorAlias", () => {
	it("embeds the name, description hook, and canonical path", () => {
		const out = genericCursorAlias("interlinked-verify", "Run interlinked verify.");
		expect(out).toContain("description: \"Run interlinked verify.\"");
		expect(out).toContain(".interlinked/skills/interlinked-verify/SKILL.md");
		expect(out).toContain("# interlinked-verify — Cursor rule alias");
		expect(out).not.toContain("name: interlinked-verify");
	});

	it("falls back to a default hook when description is empty", () => {
		expect(genericCursorAlias("foo", "")).toContain("interlinked foo skill");
	});
});

describe("buildSkillConfig", () => {
	it("gives enforce a short description + both aliases", () => {
		const cfg = buildSkillConfig("enforce", "---\nname: enforce\n---\n");
		expect(cfg.shortDescription).toBe(ENFORCE_SHORT_DESCRIPTION);
		expect(cfg.copilotPromptAlias).toContain(".interlinked/skills/enforce/SKILL.md");
		expect(cfg.cursorRuleAlias).toContain("/enforce");
	});

	it("gives a teaching skill only a generated cursor alias", () => {
		const cfg = buildSkillConfig("interlinked-setup", SAMPLE);
		expect(cfg.shortDescription).toBeUndefined();
		expect(cfg.copilotPromptAlias).toBeUndefined();
		expect(cfg.cursorRuleAlias).toContain(".interlinked/skills/interlinked-setup/SKILL.md");
	});
});

describe("runnerTargets", () => {
	it("maps each spec runner to its skills dir", () => {
		expect(runnerTargets("claude", "s", {})[0]?.relPath).toContain(".claude/skills/s/SKILL.md");
		expect(runnerTargets("codex", "s", {})[0]?.relPath).toContain(".codex/skills/s/SKILL.md");
		expect(runnerTargets("gemini", "s", {})[0]?.relPath).toContain(".gemini/extensions/s/SKILL.md");
		expect(runnerTargets("cursor", "s", {})[0]?.relPath).toContain(".cursor/rules/s.mdc");
	});

	it("adds a copilot prompt alias only when the config carries one", () => {
		expect(runnerTargets("copilot", "s", {})).toHaveLength(1);
		const withAlias = runnerTargets("copilot", "s", { copilotPromptAlias: "x" });
		expect(withAlias).toHaveLength(2);
		expect(withAlias[1]?.kind).toBe("copilot-prompt-alias");
	});
});

describe("renderTargetContent", () => {
	it("swaps the description for length-limited runners when a short one exists", () => {
		const out = renderTargetContent(
			"claude",
			{ shortDescription: "short desc" },
			{ kind: "spec", relPath: "x" },
			SAMPLE,
		);
		expect(out).toContain('description: "short desc"');
		expect(out).toContain("# body line");
	});

	it("ships spec content verbatim when there is no short description", () => {
		const out = renderTargetContent("claude", {}, { kind: "spec", relPath: "x" }, SAMPLE);
		expect(out).toBe(SAMPLE);
	});

	it("returns the alias bodies for alias kinds", () => {
		expect(
			renderTargetContent("copilot", { copilotPromptAlias: "PROMPT" }, { kind: "copilot-prompt-alias", relPath: "x" }, SAMPLE),
		).toBe("PROMPT");
		expect(
			renderTargetContent("cursor", { cursorRuleAlias: "RULE" }, { kind: "cursor-rule-alias", relPath: "x" }, SAMPLE),
		).toBe("RULE");
	});
});

describe("swapFrontmatterDescription", () => {
	it("replaces the description but keeps the name and body", () => {
		const out = swapFrontmatterDescription(SAMPLE, "new description");
		expect(out).toContain('description: "new description"');
		expect(out).toContain("name: interlinked-setup");
		expect(out).toContain("# body line");
		expect(out).not.toContain("Install and operate the harness.");
	});

	it("returns content unchanged when there is no frontmatter", () => {
		expect(swapFrontmatterDescription("no frontmatter\n", "x")).toBe("no frontmatter\n");
	});
});
