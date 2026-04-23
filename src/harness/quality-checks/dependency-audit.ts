// ===========================================
// Dependency Audit Command Resolution
// ===========================================
// Maps manifest/lock-file names to the CLI command that audits their
// ecosystem for known vulnerabilities.

/**
 * Public API — consumed by quality-checks.runQualityChecks.
 *
 * Map a package/lock-file name to the CLI command that audits its ecosystem
 * for known vulnerabilities (npm audit, pip-audit, cargo audit, govulncheck).
 * Returns null for unknown filenames so callers can skip the audit step.
 */
export function resolveDependencyAuditCommand(fileName: string): string[] | null {
	if (
		fileName === "package.json" ||
		fileName === "package-lock.json" ||
		fileName === "yarn.lock" ||
		fileName === "pnpm-lock.yaml"
	) {
		return ["npm", "audit", "--json", "--audit-level=moderate"];
	}
	if (
		fileName === "requirements.txt" ||
		fileName === "pyproject.toml" ||
		fileName === "Pipfile.lock"
	) {
		return ["pip-audit", "--format", "json", "--desc"];
	}
	if (fileName === "Cargo.toml" || fileName === "Cargo.lock") {
		return ["cargo", "audit", "--json"];
	}
	if (fileName === "go.sum" || fileName === "go.mod") {
		return ["govulncheck", "-json", "./..."];
	}
	return null;
}
