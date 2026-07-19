// ===========================================
// Skill Installers — fan the bundled skills out across runners
// ===========================================
// Materializes every skill under `skills/` (the `enforce` command + the
// interlinked-* teaching set) into each detected agent's expected skill
// directory so users can invoke `/enforce` and load the interlinked-* skills
// on demand from their coding agent of choice.
//
// Distribution model (per skill):
//   - **Canonical copy** at <cwd>/.interlinked/skills/<name>/SKILL.md is the
//     stable target every alias points at; written on every install run.
//   - **Spec-compliant runners** (Claude Code, Codex, Gemini, Copilot CLI) get
//     the full SKILL.md in their respective skills directory.
//   - **Compatibility extras** (Copilot prompt files, Cursor rules) get a thin
//     alias/rule file that delegates to the canonical copy.
//
// This module owns filesystem I/O + discovery + orchestration; the per-runner
// content rendering (description swap, alias bodies, target layout) lives in
// `skill-install-templates.ts`. Source resolution covers dev (repo `skills/`),
// dist (bundled), and npm install locations — see `findSkillsRoot()`.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nonNull } from "./non-null.js";
import type { ClientName } from "./settings.js";
import {
	buildSkillConfig,
	renderTargetContent,
	runnerTargets,
} from "./skill-install-templates.js";

const ENFORCE_SKILL_NAME = "enforce";

/** Canonical per-project skill dir — alias files reference these stable paths. */
const CANONICAL_SKILLS_DIR = join(".interlinked", "skills");

export interface SkillInstallResult {
	skill: string;
	client: ClientName;
	path: string;
	installed: boolean;
	error?: string;
}

// ===========================================
// Source resolution
// ===========================================

/**
 * Locate the `skills/` source root. Search order: dev layout
 * (src/lib/ → ../../skills/), bundled-next-to-dist, and an npm-installed dist
 * sibling. Validated by the always-present `enforce` skill so we never match an
 * unrelated `skills` directory.
 */
function findSkillsRoot(): string | null {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, "..", "..", "skills"),
		join(here, "skills"),
		join(here, "..", "skills"),
	];
	for (const dir of candidates) {
		if (existsSync(join(dir, ENFORCE_SKILL_NAME, "SKILL.md"))) return dir;
	}
	return null;
}

/**
 * Public API — locates a bundled `skills/<name>/SKILL.md` source. Returns null
 * when the package is incomplete (e.g. a dev install where skills/ is outside
 * the resolution chain).
 */
export function findSkillSource(name: string): string | null {
	const root = findSkillsRoot();
	if (!root) return null;
	const source = join(root, name, "SKILL.md");
	return existsSync(source) ? source : null;
}

/** Back-compat: locate the bundled `enforce` SKILL.md source. */
export function findEnforceSkillSource(): string | null {
	return findSkillSource(ENFORCE_SKILL_NAME);
}

/** Every installable skill: each directory under skills/ that has a SKILL.md. */
export function listInstallableSkills(): string[] {
	const root = findSkillsRoot();
	if (!root) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md")))
		.map((entry) => entry.name)
		.sort();
}

// ===========================================
// Filesystem helpers
// ===========================================

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
 * Recursively rmdir empty parent dirs up to `maxDepth`. Stops at the first
 * non-empty dir or any I/O error. Never removes `stopAt` (cwd) itself.
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

// ===========================================
// Install / uninstall
// ===========================================

/**
 * Install one skill across the requested runners. Always writes the canonical
 * `.interlinked/skills/<name>/` copy plus per-runner targets. Returns one result
 * per requested client; a failure for one client does not abort the others.
 */
function installOneSkill(
	cwd: string,
	clients: readonly ClientName[],
	name: string,
): SkillInstallResult[] {
	const sourcePath = findSkillSource(name);
	if (!sourcePath) {
		return clients.map((client) => ({
			skill: name,
			client,
			path: "",
			installed: false,
			error: `Skill source not found: ${name} (package may be incomplete)`,
		}));
	}

	const skillContent = readFileSync(sourcePath, "utf-8");
	const config = buildSkillConfig(name, skillContent);

	// Always write the canonical copy first — alias files depend on it.
	writeFileIdempotent(join(cwd, CANONICAL_SKILLS_DIR, name, "SKILL.md"), skillContent);

	const results: SkillInstallResult[] = [];
	for (const client of clients) {
		const targets = runnerTargets(client, name, config);
		if (targets.length === 0) {
			results.push({
				skill: name,
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
				writeFileIdempotent(targetPath, renderTargetContent(client, config, target, skillContent));
			}
			results.push({
				skill: name,
				client,
				path: join(cwd, nonNull(targets[0]).relPath),
				installed: true,
			});
		} catch (err) {
			results.push({
				skill: name,
				client,
				path: join(cwd, nonNull(targets[0]).relPath),
				installed: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return results;
}

/**
 * Remove one skill's per-runner files for the requested clients, leaving the
 * canonical `.interlinked/skills/<name>/` copy in place. Returns true if any
 * file was removed.
 */
function uninstallOneSkill(cwd: string, clients: readonly ClientName[], name: string): boolean {
	let changed = false;
	// A truthy copilotPromptAlias forces the Copilot prompt path into the target
	// list, so we clean it up even for teaching skills that never installed one.
	const config = { copilotPromptAlias: "x" };
	for (const client of clients) {
		for (const target of runnerTargets(client, name, config)) {
			const targetPath = join(cwd, target.relPath);
			if (!existsSync(targetPath)) continue;
			try {
				unlinkSync(targetPath);
				changed = true;
				rmdirEmptyAncestors(dirname(targetPath), cwd, 2);
			} catch (_err) {
				/* intentional: best-effort uninstall — skip files we can't remove */
			}
		}
	}
	return changed;
}

/**
 * Public API — consumed by `src/commands/enable.ts`. Installs every bundled
 * skill (the `enforce` command + the interlinked-* teaching set) across the
 * requested runners. Returns one result per (skill, client).
 */
export function installSkills(cwd: string, clients: readonly ClientName[]): SkillInstallResult[] {
	const results: SkillInstallResult[] = [];
	for (const name of listInstallableSkills()) {
		results.push(...installOneSkill(cwd, clients, name));
	}
	return results;
}

/**
 * Public API — consumed by `src/commands/disable.ts`. Removes every bundled
 * skill's per-runner files for the requested clients (canonical copies stay).
 * Returns true if any file was removed.
 */
export function uninstallSkills(cwd: string, clients: readonly ClientName[]): boolean {
	let changed = false;
	for (const name of listInstallableSkills()) {
		if (uninstallOneSkill(cwd, clients, name)) changed = true;
	}
	return changed;
}

/** Back-compat: install only the `enforce` skill across the requested runners. */
export function installEnforceSkill(
	cwd: string,
	clients: readonly ClientName[],
): SkillInstallResult[] {
	return installOneSkill(cwd, clients, ENFORCE_SKILL_NAME);
}

/** Back-compat: remove only the `enforce` skill's per-runner files. */
export function uninstallEnforceSkill(cwd: string, clients: readonly ClientName[]): boolean {
	return uninstallOneSkill(cwd, clients, ENFORCE_SKILL_NAME);
}
