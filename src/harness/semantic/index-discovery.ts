import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { discoverFiles } from "../../commands/verify/file-discovery.js";
import { matchesGlob } from "../../lib/path-glob.js";
import { functionTokenAnalyzerStatus } from "../function-tokens/index.js";
import { isCappableFile, isTestOrSpecPath } from "../large-file-policy.js";
import type { SemanticTeamConfig } from "./types.js";

export interface SemanticSourceFile {
    absolutePath: string;
    relativePath: string;
    content: string;
    exact: boolean;
}

function slashPath(path: string): string {
    return path.replace(/\\/g, "/");
}

function isInside(root: string, candidate: string): boolean {
    return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function includedByGlobs(path: string, config: SemanticTeamConfig): boolean {
    const included = config.include.length === 0 || config.include.some((glob) => matchesGlob(path, glob));
    return included && !config.exclude.some((glob) => matchesGlob(path, glob));
}

function generatedTest(content: string, path: string): boolean {
    const header = content.split(/\r?\n/, 20).join("\n");
    return /@generated\b|@codegen-data\b/.test(header)
        || /(?:^|\/)(?:generated|vendor)(?:\/|$)/i.test(path)
        || /\.(?:gen|generated)\.[^/]+$/i.test(path);
}

function eligibleSource(root: string, file: string, content: string, includeTests: boolean): boolean {
    if (isCappableFile({ filePath: file, content, root })) return true;
    if (!includeTests || !isTestOrSpecPath(file)) return false;
    return !generatedTest(content, slashPath(relative(root, file)));
}

export function discoverSemanticSources(
    root: string,
    config: SemanticTeamConfig,
    includeTests = config.include_tests,
): SemanticSourceFile[] {
    const realRoot = realpathSync(resolve(root));
    const sources: SemanticSourceFile[] = [];
    for (const discovered of discoverFiles(realRoot)) {
        let realFile: string;
        try {
            realFile = realpathSync(discovered);
        } catch {
            continue;
        }
        if (!isInside(realRoot, realFile)) continue;
        const relativePath = slashPath(relative(realRoot, realFile));
        if (!includedByGlobs(relativePath, config)) continue;
        const status = functionTokenAnalyzerStatus(relativePath);
        if (status.language === "unknown" || status.language.length === 0) continue;
        const content = readFileSync(realFile, "utf8");
        if (!eligibleSource(realRoot, realFile, content, includeTests)) continue;
        sources.push({ absolutePath: realFile, relativePath, content, exact: status.confidence === "exact" });
    }
    return sources.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function semanticSourceHash(sources: SemanticSourceFile[]): string {
    const hash = createHash("sha256");
    for (const source of sources) {
        hash.update(source.relativePath, "utf8");
        hash.update("\0");
        hash.update(source.content, "utf8");
        hash.update("\0");
    }
    return hash.digest("hex");
}
