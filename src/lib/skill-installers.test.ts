// Tests for the enforce-skill fan-out installer (companion to
// `skill-installers.ts`). Verifies:
//   1. `findEnforceSkillSource()` resolves to the bundled SKILL.md.
//   2. `installEnforceSkill()` writes the canonical .interlinked/skills/enforce/
//      copy plus per-runner skill files.
//   3. Spec-compliant runners (claude/codex/gemini/copilot) get the full SKILL.md.
//   4. Compatibility surfaces (Copilot prompt files, Cursor rules) get thin aliases.
//   5. Re-running install is idempotent (no duplicate writes, no errors).
//   6. `uninstallEnforceSkill()` removes installed files but leaves
//      unrelated files in the same dirs alone.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "./non-null.js";
import {
	findEnforceSkillSource,
	findSkillSource,
	installEnforceSkill,
	installSkills,
	listInstallableSkills,
	uninstallEnforceSkill,
	uninstallSkills,
} from "./skill-installers.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "skill-installers-test-"));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("findEnforceSkillSource", () => {
	function extractFrontmatter(content: string): string {
		const match = content.match(/^---\n([\s\S]*?)\n---\n/);
		return match ? nonNull(match[1]) : "";
	}

	function extractDescription(frontmatter: string): string {
		const blockMatch = frontmatter.match(
			/^description\s*:\s*\|\s*\n([\s\S]*?)(?=\n\S|$)/m,
		);
		if (blockMatch) {
			return nonNull(blockMatch[1])
				.split("\n")
				.map((l) => l.replace(/^\s+/, ""))
				.join(" ")
				.trim();
		}
		const quotedMatch = frontmatter.match(
			/^description\s*:\s*"((?:[^"\\]|\\.)*)"/m,
		);
		if (quotedMatch) {
			return nonNull(quotedMatch[1]).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		}
		return "";
	}

	it("returns a non-null path", () => {
		expect(findEnforceSkillSource()).not.toBeNull();
	});

	it("returns a path to an existing SKILL.md whose frontmatter names enforce", () => {
		const path = findEnforceSkillSource() as string;
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf-8")).toContain("name: enforce");
	});

	it("ships a parser-safe source description under 1024 chars", () => {
		const path = findEnforceSkillSource() as string;
		const content = readFileSync(path, "utf-8");
		const description = extractDescription(extractFrontmatter(content));
		expect(description.length).toBeGreaterThan(0);
		expect(description.length).toBeLessThanOrEqual(1024);
	});

	it("rewrites the per-claude SKILL.md description under 1024 chars on install", () => {
		// The repository no longer tracks `.claude/skills/enforce/SKILL.md`
		// (gitignored — `interlinked enable` materializes it from skills/ on
		// install). Verify the contract by installing into a tmpdir and
		// reading the produced file.
		installEnforceSkill(tmpRoot, ["claude"]);
		const claudePath = join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md");
		const content = readFileSync(claudePath, "utf-8");
		const description = extractDescription(extractFrontmatter(content));
		expect(description.length).toBeGreaterThan(0);
		expect(description.length).toBeLessThanOrEqual(1024);
	});
});

describe("installEnforceSkill", () => {
	it("writes the canonical .interlinked/skills/enforce/SKILL.md", () => {
		const results = installEnforceSkill(tmpRoot, ["claude"]);
		const canonical = join(tmpRoot, ".interlinked", "skills", "enforce", "SKILL.md");
		expect(existsSync(canonical)).toBe(true);
		const content = readFileSync(canonical, "utf-8");
		expect(content).toContain("name: enforce");
		expect(results.length).toBeGreaterThan(0);
	});

	it("installs full SKILL.md for spec-compliant runners (claude)", () => {
		installEnforceSkill(tmpRoot, ["claude"]);
		const claudePath = join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md");
		expect(existsSync(claudePath)).toBe(true);
		const content = readFileSync(claudePath, "utf-8");
		expect(content).toContain("name: enforce");
		expect(content.length).toBeGreaterThan(2000); // full body, not alias
	});

	it("installs full SKILL.md for codex and gemini", () => {
		installEnforceSkill(tmpRoot, ["codex", "gemini"]);
		expect(existsSync(join(tmpRoot, ".codex", "skills", "enforce", "SKILL.md"))).toBe(
			true,
		);
		expect(
			existsSync(join(tmpRoot, ".gemini", "extensions", "enforce", "SKILL.md")),
		).toBe(true);
	});

	it("installs full SKILL.md for Copilot at .github/skills/enforce/SKILL.md", () => {
		installEnforceSkill(tmpRoot, ["copilot"]);
		const skillPath = join(tmpRoot, ".github", "skills", "enforce", "SKILL.md");
		expect(existsSync(skillPath)).toBe(true);
		const content = readFileSync(skillPath, "utf-8");
		expect(content).toContain("name: enforce");
		expect(content.length).toBeGreaterThan(2000);
	});

	it("installs a Copilot prompt alias alongside the native skill copy", () => {
		installEnforceSkill(tmpRoot, ["copilot"]);
		const aliasPath = join(tmpRoot, ".github", "prompts", "enforce.prompt.md");
		expect(existsSync(aliasPath)).toBe(true);
		const content = readFileSync(aliasPath, "utf-8");
		expect(content).toContain(".interlinked/skills/enforce/SKILL.md");
		expect(content.length).toBeLessThan(2000); // alias, not full body
	});

	it("installs a Cursor rule alias at .cursor/rules/enforce.mdc", () => {
		installEnforceSkill(tmpRoot, ["cursor"]);
		const aliasPath = join(tmpRoot, ".cursor", "rules", "enforce.mdc");
		expect(existsSync(aliasPath)).toBe(true);
		const content = readFileSync(aliasPath, "utf-8");
		expect(content).toContain("description:");
		expect(content).toContain(".interlinked/skills/enforce/SKILL.md");
		expect(content).not.toContain("name: enforce");
	});

	it("is idempotent across runs", () => {
		installEnforceSkill(tmpRoot, ["claude", "copilot"]);
		const firstClaude = readFileSync(
			join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md"),
			"utf-8",
		);
		installEnforceSkill(tmpRoot, ["claude", "copilot"]);
		const secondClaude = readFileSync(
			join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md"),
			"utf-8",
		);
		expect(firstClaude).toBe(secondClaude);
	});

	it("returns one result per requested client", () => {
		const results = installEnforceSkill(tmpRoot, ["claude", "codex", "copilot"]);
		expect(results).toHaveLength(3);
		expect(results.map((r) => r.client).sort()).toEqual(
			["claude", "codex", "copilot"].sort(),
		);
		expect(results.every((r) => r.installed)).toBe(true);
	});
});

describe("description transform for runners with strict limits", () => {
	function extractFrontmatter(content: string): string {
		const match = content.match(/^---\n([\s\S]*?)\n---\n/);
		return match ? nonNull(match[1]) : "";
	}

	function extractDescription(frontmatter: string): string {
		// Block scalar: `description: |\n  line1\n  line2`
		const blockMatch = frontmatter.match(
			/^description\s*:\s*\|\s*\n([\s\S]*?)(?=\n\S|$)/m,
		);
		if (blockMatch) {
			return nonNull(blockMatch[1])
				.split("\n")
				.map((l) => l.replace(/^\s+/, ""))
				.join(" ")
				.trim();
		}
		// Double-quoted scalar: `description: "..."`
		const quotedMatch = frontmatter.match(
			/^description\s*:\s*"((?:[^"\\]|\\.)*)"/m,
		);
		if (quotedMatch) {
			return nonNull(quotedMatch[1]).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		}
		return "";
	}

	it.each([
		["claude", ".claude/skills/enforce/SKILL.md"],
		["codex", ".codex/skills/enforce/SKILL.md"],
		["gemini", ".gemini/extensions/enforce/SKILL.md"],
		["copilot", ".github/skills/enforce/SKILL.md"],
	] as const)("%s install keeps description under 1024 chars", (client, relPath) => {
		installEnforceSkill(tmpRoot, [client]);
		const content = readFileSync(join(tmpRoot, relPath), "utf-8");
		const description = extractDescription(extractFrontmatter(content));
		expect(description.length).toBeGreaterThan(0);
		expect(description.length).toBeLessThanOrEqual(1024);
	});

	it("codex install description still mentions /enforce invocation", () => {
		installEnforceSkill(tmpRoot, ["codex"]);
		const codexPath = join(tmpRoot, ".codex", "skills", "enforce", "SKILL.md");
		const content = readFileSync(codexPath, "utf-8");
		const description = extractDescription(extractFrontmatter(content));
		expect(description).toContain("/enforce");
		expect(description).toContain("AGENTS.md");
	});

	it("codex install body length matches the source SKILL.md body", () => {
		installEnforceSkill(tmpRoot, ["codex"]);
		const codexPath = join(tmpRoot, ".codex", "skills", "enforce", "SKILL.md");
		const claudePath = join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md");
		// Need claude install to compare
		installEnforceSkill(tmpRoot, ["claude"]);
		const codexContent = readFileSync(codexPath, "utf-8");
		const claudeContent = readFileSync(claudePath, "utf-8");
		const codexBody = codexContent.replace(/^---\n[\s\S]*?\n---\n/, "");
		const claudeBody = claudeContent.replace(/^---\n[\s\S]*?\n---\n/, "");
		expect(codexBody).toBe(claudeBody);
	});

	it("claude install body still matches the source SKILL.md body", () => {
		installEnforceSkill(tmpRoot, ["claude"]);
		const claudePath = join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md");
		const sourcePath = findEnforceSkillSource() as string;
		const claudeContent = readFileSync(claudePath, "utf-8");
		const sourceContent = readFileSync(sourcePath, "utf-8");
		const claudeBody = claudeContent.replace(/^---\n[\s\S]*?\n---\n/, "");
		const sourceBody = sourceContent.replace(/^---\n[\s\S]*?\n---\n/, "");
		expect(claudeBody).toBe(sourceBody);
	});
});

describe("uninstallEnforceSkill", () => {
	it("removes installed skill files", () => {
		installEnforceSkill(tmpRoot, ["claude", "copilot"]);
		expect(existsSync(join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md"))).toBe(
			true,
		);
		expect(
			existsSync(join(tmpRoot, ".github", "skills", "enforce", "SKILL.md")),
		).toBe(true);
		expect(
			existsSync(join(tmpRoot, ".github", "prompts", "enforce.prompt.md")),
		).toBe(true);

		uninstallEnforceSkill(tmpRoot, ["claude", "copilot"]);
		expect(existsSync(join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md"))).toBe(
			false,
		);
		expect(
			existsSync(join(tmpRoot, ".github", "skills", "enforce", "SKILL.md")),
		).toBe(false);
		expect(
			existsSync(join(tmpRoot, ".github", "prompts", "enforce.prompt.md")),
		).toBe(false);
	});

	it("leaves unrelated files in the same directories alone", () => {
		installEnforceSkill(tmpRoot, ["claude"]);
		// Drop a sibling skill the user might have installed.
		const siblingPath = join(tmpRoot, ".claude", "skills", "tdd", "SKILL.md");
		mkdirSync(join(tmpRoot, ".claude", "skills", "tdd"), { recursive: true });
		writeFileSync(siblingPath, "---\nname: tdd\n---\n");

		uninstallEnforceSkill(tmpRoot, ["claude"]);
		expect(existsSync(siblingPath)).toBe(true);
	});

	it("returns false when nothing was installed", () => {
		const result = uninstallEnforceSkill(tmpRoot, ["claude"]);
		expect(result).toBe(false);
	});
});

describe("installSkills (full bundled set)", () => {
	it("installs enforce and the interlinked-* teaching skills for a runner", () => {
		const results = installSkills(tmpRoot, ["claude"]);
		expect(existsSync(join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md"))).toBe(true);
		expect(existsSync(join(tmpRoot, ".claude", "skills", "interlinked", "SKILL.md"))).toBe(true);
		expect(
			existsSync(join(tmpRoot, ".claude", "skills", "interlinked-setup", "SKILL.md")),
		).toBe(true);
		expect(results.some((r) => r.skill === "enforce" && r.installed)).toBe(true);
		expect(results.some((r) => r.skill.startsWith("interlinked") && r.installed)).toBe(true);
	});

	it("gives teaching skills a Cursor alias but no Copilot prompt alias", () => {
		installSkills(tmpRoot, ["cursor", "copilot"]);
		expect(existsSync(join(tmpRoot, ".cursor", "rules", "interlinked-setup.mdc"))).toBe(true);
		expect(
			existsSync(join(tmpRoot, ".github", "prompts", "interlinked-setup.prompt.md")),
		).toBe(false);
		// enforce keeps its Copilot prompt alias.
		expect(existsSync(join(tmpRoot, ".github", "prompts", "enforce.prompt.md"))).toBe(true);
	});

	it("ships teaching-skill descriptions verbatim to spec runners", () => {
		installSkills(tmpRoot, ["claude"]);
		const content = readFileSync(
			join(tmpRoot, ".claude", "skills", "interlinked-setup", "SKILL.md"),
			"utf-8",
		);
		expect(content).toContain("name: interlinked-setup");
	});
});

describe("uninstallSkills (full bundled set)", () => {
	it("removes every installed skill for the requested clients", () => {
		installSkills(tmpRoot, ["claude", "cursor"]);
		expect(uninstallSkills(tmpRoot, ["claude", "cursor"])).toBe(true);
		expect(existsSync(join(tmpRoot, ".claude", "skills", "interlinked", "SKILL.md"))).toBe(false);
		expect(existsSync(join(tmpRoot, ".cursor", "rules", "interlinked-setup.mdc"))).toBe(false);
	});

	it("returns false when nothing was installed", () => {
		expect(uninstallSkills(tmpRoot, ["claude"])).toBe(false);
	});
});

// ===========================================
// Shipped-source frontmatter invariant
// ===========================================
// A runner-facing SKILL.md whose frontmatter is invalid YAML is dropped
// SILENTLY — no error, the skill simply never loads. The `enforce` skill was
// never exposed to this because the installer rewrites its description through
// `quoteYamlDouble`; the interlinked-* teaching skills ship their descriptions
// VERBATIM, so validity is the author's responsibility and nothing checked it.
// Five of the nine shipped with a bare description containing ": " (illegal in
// a YAML plain scalar) and would have failed to load. Hence this gate.

/** The frontmatter block of a SKILL.md, or "" when absent/malformed. */
function frontmatterBlock(content: string): string {
	const match = content.match(/^---\n([\s\S]*?)\n---\n/);
	return match ? nonNull(match[1]) : "";
}

/** The raw `description:` value, verbatim and trimmed. Null when absent. */
function descriptionValue(frontmatter: string): string | null {
	const match = frontmatter.match(/^description:\s*(.*)$/m);
	return match ? nonNull(match[1]).trim() : null;
}

/**
 * True when `value` is a well-formed YAML double-quoted scalar: it opens with
 * `"`, every interior `"` is backslash-escaped, and the scalar terminates on
 * the final character. Quoting is what makes the authored text irrelevant to
 * the parser — a quoted scalar may contain ": ", " #", and other indicators
 * that would break a bare one.
 */
function isQuotedYamlScalar(value: string): boolean {
	if (value.length < 2 || !value.startsWith('"')) return false;
	let i = 1;
	while (i < value.length) {
		if (value[i] === "\\") {
			i += 2;
			continue;
		}
		if (value[i] === '"') return i === value.length - 1;
		i += 1;
	}
	return false;
}

describe("shipped SKILL.md frontmatter is loader-safe", () => {
	const skills = listInstallableSkills();

	// Guards the it.each below: an empty list would produce ZERO test cases and
	// report green — the "silently passed 0/0" failure mode.
	it("discovers the full bundled set", () => {
		expect(skills).toContain("enforce");
		expect(skills.filter((name) => name.startsWith("interlinked")).length).toBeGreaterThan(0);
	});

	it.each(skills)("%s: description is a quoted, length-safe scalar", (name) => {
		const source = findSkillSource(name);
		expect(source, `${name}: source not resolvable`).not.toBeNull();

		const frontmatter = frontmatterBlock(readFileSync(nonNull(source), "utf-8"));
		expect(frontmatter, `${name}: missing or malformed frontmatter block`).not.toBe("");

		const value = descriptionValue(frontmatter);
		expect(value, `${name}: frontmatter has no description key`).not.toBeNull();
		expect(
			isQuotedYamlScalar(nonNull(value)),
			`${name}: description must be double-quoted (inner quotes escaped) — a bare value containing ": " is invalid YAML and the skill will not load`,
		).toBe(true);

		// Several skill loaders reject descriptions over 1024 characters.
		expect(
			nonNull(value).length,
			`${name}: description exceeds the 1024-char loader limit`,
		).toBeLessThanOrEqual(1024);
	});
});
