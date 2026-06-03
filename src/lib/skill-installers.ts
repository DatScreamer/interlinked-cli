// ===========================================
// Skill Installers — fan out the `enforce` skill across runners
// ===========================================
// Drops the `enforce` skill (skills/enforce/SKILL.md) into every detected
// agent's expected skill directory so users can invoke `/enforce <target>`
// from inside their coding agent of choice.
//
// Distribution model:
//   - **Canonical copy** at <cwd>/.interlinked/skills/enforce/SKILL.md is the
//     stable target every alias points at; written on every install run.
//   - **Spec-compliant runners** (Claude Code, Codex, Gemini, Copilot CLI)
//     get the full SKILL.md in their respective skills directory.
//   - **Compatibility extras** (Copilot prompt files, Cursor rules) get a
//     thin alias/rule file that delegates to the canonical copy.
//
// Source resolution: dev (repo skills/), dist (bundled), or npm install
// location. See `findEnforceSkillSource()`.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientName } from "./settings.js";

const SKILL_NAME = "enforce";

/** Canonical project copy — alias files reference this stable path. */
const CANONICAL_REL_PATH = join(".interlinked", "skills", SKILL_NAME, "SKILL.md");

interface RunnerSkillTarget {
	/** How this target should be rendered for the runner. */
	kind: "spec" | "copilot-prompt-alias" | "cursor-rule-alias";
	/** Path relative to cwd */
	relPath: string;
}

/** Where each runner expects to find a skill named `enforce`. */
const RUNNER_TARGETS: Record<ClientName, readonly RunnerSkillTarget[]> = {
	claude: [{ kind: "spec", relPath: join(".claude", "skills", SKILL_NAME, "SKILL.md") }],
	codex: [{ kind: "spec", relPath: join(".codex", "skills", SKILL_NAME, "SKILL.md") }],
	gemini: [
		{
			kind: "spec",
			relPath: join(".gemini", "extensions", SKILL_NAME, "SKILL.md"),
		},
	],
	copilot: [
		{
			kind: "spec",
			relPath: join(".github", "skills", SKILL_NAME, "SKILL.md"),
		},
		{
			kind: "copilot-prompt-alias",
			relPath: join(".github", "prompts", `${SKILL_NAME}.prompt.md`),
		},
	],
	cursor: [
		{
			kind: "cursor-rule-alias",
			relPath: join(".cursor", "rules", `${SKILL_NAME}.mdc`),
		},
	],
};

/**
 * Several skill loaders reject descriptions over 1024 characters. Keep a
 * parser-safe description available for every runner-facing SKILL.md copy.
 * The skill BODY (instructions) is unchanged across runners — only the
 * discovery-surface description swaps.
 */
const SHORT_DESCRIPTION =
	"Distill imperative markdown guidance (AGENTS.md, CLAUDE.md, .clinerules/, GEMINI.md, SKILL.md with hard imperatives) into Interlinked harness hook rules with verbatim source provenance. Invoke as /enforce <target> — local path, directory, GitHub shorthand (owner/repo/path), or URL — or no args to walk the project. Lexical strength is binding: never/MUST NOT/forbidden distill to block; should not/avoid to ask; should/prefer to advisory; hedged language is skipped. Output goes to .interlinked/distilled-rules.json plus .interlinked/distilled-rules.overrides.json. Lifecycle ops: /enforce list, show, remove, disable, enable, modify, add, reset, --review, --accept. Description-match invocation: make my AGENTS.md enforced, distill rules from this file. Manual invocation only — never auto-fires.";

/** Runners whose SKILL.md copies must keep a parser-safe description length. */
const RUNNERS_REQUIRING_SHORT_DESCRIPTION: ReadonlySet<ClientName> = new Set([
	"claude",
	"codex",
	"gemini",
	"copilot",
]);

/** Thin prompt-file alias for Copilot surfaces that still read .prompt.md files. */
const COPILOT_PROMPT_ALIAS_TEMPLATE = `---
name: enforce
description: Distill imperative .md guidance into harness-enforced rules with full source provenance. Aliases to the full skill body. Invoke as /enforce <target> where <target> is a path, directory, GitHub shorthand (owner/repo/path), or URL. With no argument, walks the project. Lifecycle ops: /enforce list, /enforce remove, /enforce disable, /enforce modify.
---

# /enforce — alias

This is a thin alias. The full skill body lives at:

\`.interlinked/skills/enforce/SKILL.md\`

Read that file and follow its instructions exactly. Parse the user's
argument(s) as distill targets. Output goes to
\`.interlinked/distilled-rules.json\`. Lifecycle ops (list, remove, disable,
enable, modify, add, reset) are documented in the same skill body.
`;

/**
 * Cursor does not consume SKILL.md directories natively, so install an
 * agent-requested `.mdc` rule whose description gives the model a retrieval
 * hook when the user asks to compile or manage enforced rules.
 */
const CURSOR_RULE_ALIAS_TEMPLATE = `---
description: Use this rule when the user asks to distill AGENTS.md, CLAUDE.md, or similar markdown guidance into enforced Interlinked harness rules; asks to use /enforce; or asks to list, remove, disable, enable, modify, add, or reset distilled rules.
---

# /enforce — Cursor rule alias

This rule is a thin alias. The full skill body lives at:

\`.interlinked/skills/enforce/SKILL.md\`

When the task matches the description above, read that file and follow its
instructions exactly. Parse the user's arguments as distill targets or
lifecycle operations. Write live output to
\`.interlinked/distilled-rules.json\` and persistent user modifications to
\`.interlinked/distilled-rules.overrides.json\`.
`;

export interface SkillInstallResult {
	client: ClientName;
	path: string;
	installed: boolean;
	error?: string;
}

/**
 * Public API — locates the bundled `skills/enforce/SKILL.md` source. Returns
 * null when the package is incomplete (e.g. dev install where skills/ is
 * outside the resolution chain). Caller surfaces null as an error.
 *
 * Search order: dev layout (src/lib/ → ../../skills/), bundled-next-to-dist,
 * and an npm-installed dist sibling.
 */
export function findEnforceSkillSource(): string | null {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		// Dev: src/lib/skill-installers.ts → ../../skills/enforce/SKILL.md
		join(here, "..", "..", "skills", SKILL_NAME, "SKILL.md"),
		// Bundled (tsup default): dist/index.js → ./skills/enforce/SKILL.md
		join(here, "skills", SKILL_NAME, "SKILL.md"),
		// Bundled with deeper nesting: dist/lib/x.js → ../skills/enforce/SKILL.md
		join(here, "..", "skills", SKILL_NAME, "SKILL.md"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Replace the YAML frontmatter `description` field with `newDescription`,
 * leaving the body and other frontmatter keys (name, etc.) untouched.
 * Handles both inline-style (`description: foo`) and block-scalar style
 * (`description: |` with indented continuation lines). Returns content
 * unchanged when no frontmatter is present (defensive — should not happen
 * with our shipped skill).
 */
function swapFrontmatterDescription(content: string, newDescription: string): string {
	const DELIM = "---\n";
	if (!content.startsWith(DELIM)) return content;
	const closeIdx = content.indexOf(`\n${DELIM}`, DELIM.length);
	if (closeIdx < 0) return content;

	const frontmatter = content.slice(DELIM.length, closeIdx + 1);
	const body = content.slice(closeIdx + 1 + DELIM.length);

	const lines = frontmatter.split("\n");
	const out: string[] = [];
	let i = 0;
	let replaced = false;
	const quoted = quoteYamlDouble(newDescription);

	while (i < lines.length) {
		const line = lines[i];
		if (line === undefined) {
			i += 1;
			continue;
		}
		if (!replaced && /^description\s*:/.test(line)) {
			out.push(`description: ${quoted}`);
			replaced = true;

			// If the original used a block scalar (`|`, `>`, with optional
			// chomp indicators `+`/`-`), consume the indented or blank
			// continuation lines that belonged to it.
			const valuePart = line.slice(line.indexOf(":") + 1).trim();
			const isBlockScalar = /^[|>][+-]?$/.test(valuePart);
			i += 1;
			if (isBlockScalar) {
				while (i < lines.length) {
					const next = lines[i];
					if (next === undefined) break;
					if (next.length === 0 || /^\s/.test(next)) {
						i += 1;
						continue;
					}
					break;
				}
			}
			continue;
		}
		out.push(line);
		i += 1;
	}

	if (!replaced) {
		out.push(`description: ${quoted}`);
	}

	// `\n` between the joined frontmatter and the closing `---\n` is
	// significant — the original ended with a newline before `---`, and
	// dropping it produces malformed YAML where the last value runs into
	// the closing delimiter (e.g. `description: "..."---`). When that
	// happens, downstream regex strippers find the next `---` in the body
	// instead of the frontmatter close, eating real content. Cheap to add,
	// expensive to debug — preserve it explicitly.
	return `${DELIM}${out.join("\n")}\n${DELIM}${body}`;
}

/** YAML double-quoted scalar — escape backslashes and double quotes only. */
function quoteYamlDouble(s: string): string {
	const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escaped}"`;
}

/**
 * Apply per-runner content transforms before writing. Spec-compliant runners
 * with strict description-length limits (see RUNNERS_REQUIRING_SHORT_DESCRIPTION)
 * get the trimmed description; everyone else gets the canonical content.
 */
function transformForRunner(client: ClientName, content: string): string {
	if (!RUNNERS_REQUIRING_SHORT_DESCRIPTION.has(client)) return content;
	return swapFrontmatterDescription(content, SHORT_DESCRIPTION);
}

function renderTargetContent(
	client: ClientName,
	target: RunnerSkillTarget,
	skillContent: string,
): string {
	switch (target.kind) {
		case "spec":
			return transformForRunner(client, skillContent);
		case "copilot-prompt-alias":
			return COPILOT_PROMPT_ALIAS_TEMPLATE;
		case "cursor-rule-alias":
			return CURSOR_RULE_ALIAS_TEMPLATE;
	}
}

function writeFileIdempotent(path: string, content: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	if (existsSync(path)) {
		try {
			if (readFileSync(path, "utf-8") === content) return;
		} catch (_err) {
			/* intentional: unreadable existing file — fall through to overwrite */
		}
	}
	writeFileSync(path, content);
}

/**
 * Public API — consumed by `src/commands/enable.ts`. Installs the `enforce`
 * skill across the requested runners. Always writes the canonical project
 * copy at `.interlinked/skills/enforce/SKILL.md`. Returns one result per
 * requested client; partial failure (one client failing) does not abort the
 * others.
 */
export function installEnforceSkill(
	cwd: string,
	clients: readonly ClientName[],
): SkillInstallResult[] {
	const sourcePath = findEnforceSkillSource();
	if (!sourcePath) {
		const errMsg =
			"Could not find enforce SKILL.md in package — install may be incomplete";
		return clients.map((client) => ({
			client,
			path: "",
			installed: false,
			error: errMsg,
		}));
	}

	const skillContent = readFileSync(sourcePath, "utf-8");

	// Always write the canonical copy first — alias files depend on it.
	const canonicalPath = join(cwd, CANONICAL_REL_PATH);
	writeFileIdempotent(canonicalPath, skillContent);

	const results: SkillInstallResult[] = [];
	for (const client of clients) {
		const targets = RUNNER_TARGETS[client];
		if (!targets || targets.length === 0) {
			results.push({
				client,
				path: "",
				installed: false,
				error: `Unknown client: ${client}`,
			});
			continue;
		}
		try {
			for (const target of targets) {
				const targetPath = join(cwd, target.relPath);
				const content = renderTargetContent(client, target, skillContent);
				writeFileIdempotent(targetPath, content);
			}
			results.push({
				client,
				path: join(cwd, targets[0].relPath),
				installed: true,
			});
		} catch (err) {
			results.push({
				client,
				path: join(cwd, targets[0].relPath),
				installed: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return results;
}

/**
 * Recursively rmdir empty parent dirs up to a depth of 3 (skill/skills/.claude).
 * Stops at the first non-empty dir or any I/O error. Skips removing `cwd`
 * itself or `.interlinked/` (the canonical copy stays so future re-enables
 * keep the same pointer).
 */
function rmdirEmptyAncestors(startDir: string, stopAt: string, maxDepth: number): void {
	let dir = startDir;
	for (let i = 0; i < maxDepth; i += 1) {
		if (dir === stopAt || dir.length <= stopAt.length) return;
		try {
			const entries = readdirSync(dir);
			if (entries.length > 0) return;
			rmdirSync(dir);
		} catch (_err) {
			/* intentional: dir may already be gone or non-empty — stop walking */
			return;
		}
		dir = dirname(dir);
	}
}

/**
 * Public API — consumed by `src/commands/disable.ts`. Removes the per-runner
 * skill files for the requested clients but leaves the canonical
 * `.interlinked/skills/enforce/` copy in place (the harness still loads
 * distilled-rules.json after disable; keeping the source skill lets users
 * re-distill without reinstalling).
 *
 * Returns true if any file was removed.
 */
export function uninstallEnforceSkill(
	cwd: string,
	clients: readonly ClientName[],
): boolean {
	let changed = false;
	for (const client of clients) {
		const targets = RUNNER_TARGETS[client];
		if (!targets) continue;
		for (const target of targets) {
			const targetPath = join(cwd, target.relPath);
			if (!existsSync(targetPath)) continue;
			try {
				unlinkSync(targetPath);
				changed = true;
				// Walk up at most 2 levels (e.g. .claude/skills/enforce/ →
				// .claude/skills/ → .claude/) removing only EMPTY dirs.
				rmdirEmptyAncestors(dirname(targetPath), cwd, 2);
			} catch (_err) {
				/* intentional: best-effort uninstall — skip files we can't remove */
			}
		}
	}
	return changed;
}
