// ===========================================
// Shared deployed-skill refresh for lifecycle commands
// ===========================================

import type { ClientName } from "../lib/settings.js";
import { installSkills, type SkillInstallResult } from "../lib/skill-installers.js";

export interface SkillRefreshSummary {
    clients: ClientName[];
    installed: number;
    changed: number;
    warnings: string[];
}

export interface SkillRefreshResult {
    results: SkillInstallResult[];
    outputLines: string[];
    summary: SkillRefreshSummary;
}

/** Refresh every bundled skill for the detected clients and produce output that
 * lifecycle commands can surface without duplicating installer policy. */
export function refreshClientSkills(
    cwd: string,
    clients: readonly ClientName[],
): SkillRefreshResult {
    const results = clients.length > 0 ? installSkills(cwd, clients) : [];
    const installed = results.filter((result) => result.installed);
    const changed = installed.filter((result) => result.changed === true);
    const warnings = results
        .filter((result) => result.error !== undefined)
        .map((result) => `${result.skill}/${result.client}: ${result.error}`);
    const clientList = [...clients];
    const outputLines =
        clients.length === 0
            ? []
            : [
                  `  Skills:      refreshed ${installed.length}/${results.length} installs for ${clientList.join(", ")}${changed.length > 0 ? ` (${changed.length} changed)` : ""}`,
                  ...warnings.map((warning) => `  Skill warning: ${warning}`),
              ];
    return {
        results,
        outputLines,
        summary: {
            clients: clientList,
            installed: installed.length,
            changed: changed.length,
            warnings,
        },
    };
}
