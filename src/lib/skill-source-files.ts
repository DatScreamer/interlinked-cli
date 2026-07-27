// ===========================================
// Bundled skill source discovery
// ===========================================

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ENFORCE_SKILL_NAME = "enforce";

export interface SkillSourceFile {
    relPath: string;
    content: Buffer;
}

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

export function findSkillSource(name: string): string | null {
    const root = findSkillsRoot();
    if (!root) return null;
    const source = join(root, name, "SKILL.md");
    return existsSync(source) ? source : null;
}

export function findEnforceSkillSource(): string | null {
    return findSkillSource(ENFORCE_SKILL_NAME);
}

export function listInstallableSkills(): string[] {
    const root = findSkillsRoot();
    if (!root) return [];
    return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md")))
        .map((entry) => entry.name)
        .sort();
}

function walkSkillFiles(root: string, dir: string, out: SkillSourceFile[]): void {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) {
            throw new Error(`Bundled skill resources must not be symlinks: ${relative(root, path)}`);
        }
        if (entry.isDirectory()) {
            walkSkillFiles(root, path, out);
        } else if (entry.isFile()) {
            out.push({ relPath: relative(root, path), content: readFileSync(path) });
        }
    }
}

export function readSkillSourceFiles(name: string): SkillSourceFile[] | null {
    const source = findSkillSource(name);
    if (!source) return null;
    const root = dirname(source);
    const files: SkillSourceFile[] = [];
    walkSkillFiles(root, root, files);
    return files;
}

export const ENFORCE_SKILL = ENFORCE_SKILL_NAME;
