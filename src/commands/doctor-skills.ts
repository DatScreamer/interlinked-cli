// ===========================================
// Doctor checks for deployed Interlinked skills
// ===========================================

import { type ClientName, detectClients } from "../lib/settings.js";
import { inspectInstalledSkills, installSkills } from "../lib/skill-installers.js";
import type { CheckResult } from "./doctor-checks.js";

function detectedClients(cwd: string): ClientName[] {
    return detectClients(cwd)
        .filter((client) => client.exists)
        .map((client) => client.name);
}

function staleSkillResult(
    clients: readonly ClientName[],
    issues: readonly string[],
): CheckResult {
    return {
        name: "Agent skills",
        status: "warn",
        message: `${issues.length} deployed skill file(s) missing or stale for ${clients.join(", ")} -- run 'interlinked doctor --fix'`,
        fixable: true,
        fixAction: "refresh-skills",
    };
}

/** Inspect native runner skill directories and optionally refresh safe,
 * Interlinked-owned copies. Modified user files remain warnings, never clobbers. */
export function skillInstallationChecks(cwd: string, fix: boolean): CheckResult[] {
    const clients = detectedClients(cwd);
    if (clients.length === 0) return [];

    const before = inspectInstalledSkills(cwd, clients);
    if (before.expectedFiles === 0) {
        return [
            {
                name: "Agent skills",
                status: "warn",
                message: "Bundled skill sources were not found in this CLI installation",
            },
        ];
    }
    if (before.issues.length === 0) {
        return [
            {
                name: "Agent skills",
                status: "pass",
                message: `${before.currentFiles} deployed skill file(s) current for ${clients.join(", ")}`,
            },
        ];
    }
    if (!fix) return [staleSkillResult(clients, before.issues)];

    const installResults = installSkills(cwd, clients);
    const after = inspectInstalledSkills(cwd, clients);
    if (after.issues.length === 0) {
        return [
            {
                name: "Agent skills",
                status: "pass",
                message: `Refreshed ${after.currentFiles} deployed skill file(s) for ${clients.join(", ")}`,
            },
        ];
    }
    const errors = installResults
        .filter((result) => result.error !== undefined)
        .map((result) => result.error)
        .filter((error): error is string => error !== undefined);
    const detail = errors[0] ?? after.issues[0] ?? "unknown install error";
    return [
        {
            ...staleSkillResult(clients, after.issues),
            message: `Could not safely refresh all deployed skills: ${detail}`,
        },
    ];
}
