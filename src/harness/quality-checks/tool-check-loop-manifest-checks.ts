// interlinked-tdd: exempt
// ===========================================
// Tool-Check Loop — manifest/dependency-file check handlers
// ===========================================
// Leaf handlers extracted from tool-check-loop.ts to keep the main file under
// the per-file line cap. These cover lockfile drift, package.json consistency,
// and software-version regression/freshness — all "manifest or dependency-file"
// checks. Logic is byte-identical to the originals; only the location moved.

import { isAbsolute, resolve } from "node:path";
import type { QualityCheckConfig } from "../types.js";
import { checkLockfileClassificationDrift, checkLockfileDrift, LOCKFILE_MAP } from "./lockfile-drift.js";
import { checkPackageJsonConsistency } from "./package-json.js";
import type { QualityCheckResult } from "./result-types.js";
import {
	collectSoftwareVersionReferences,
	detectSoftwareVersionFreshnessConcerns,
	detectSoftwareVersionRegressions,
	formatSoftwareVersionFreshnessDetail,
	formatSoftwareVersionRegressionDetail,
} from "./software-version-regression.js";
import type { ToolCheckLoopContext } from "./tool-check-loop.js";

/** Map an mtime-drift result to a finding, or null when not drifted. */
function mtimeDriftResult(
	drift: ReturnType<typeof checkLockfileDrift>,
	ctx: ToolCheckLoopContext,
	name: string,
	check: QualityCheckConfig,
): QualityCheckResult | null {
	if (!drift.drifted) return null;
	const msg =
		drift.reason === "missing"
			? `No lockfile found for ${drift.manifest}. Run the package manager's install command to generate one.`
			: `${drift.lockfile} is stale — ${drift.manifest} was modified but the lockfile was not regenerated.`;
	return {
		name,
		severity: check.severity,
		message: msg,
		file: ctx.filePath,
		detail:
			drift.reason === "stale"
				? `Run \`npm install\`, \`yarn install\`, \`cargo generate-lockfile\`, or the appropriate lock command to update ${drift.lockfile}.`
				: `Expected one of: ${(LOCKFILE_MAP[drift.manifest] || []).join(", ")}`,
	};
}

/** Map each semantic dependency-classification mismatch to a finding (finding 7). */
function classificationDriftResults(
	absPath: string,
	ctx: ToolCheckLoopContext,
	name: string,
	check: QualityCheckConfig,
): QualityCheckResult[] {
	const cls = checkLockfileClassificationDrift(absPath);
	return cls.mismatches.map((m) => ({
		name,
		severity: check.severity,
		message: `${m.name} is declared in ${m.manifestSection} in ${cls.manifest} but recorded under ${m.lockSection} in package-lock.json — regenerate the lockfile.`,
		file: ctx.filePath,
		detail: `Run \`npm install --package-lock-only\` so the lock matches the manifest. As-is, \`npm ci\` resolves ${m.name}'s classification from the stale lock, not package.json — e.g. \`--omit=dev\` / \`--omit=optional\` would include or drop it incorrectly.`,
	}));
}

/** lockfile_drift — stale/missing lockfile (mtime) + dependency-classification
 *  drift (semantic). The semantic compare is structural, so it fires even inside
 *  the mtime check's grace window. */
export function runLockfileDriftCheck(
	ctx: ToolCheckLoopContext,
	name: string,
	check: QualityCheckConfig,
): QualityCheckResult[] | null {
	const absPath = isAbsolute(ctx.filePath) ? ctx.filePath : resolve(ctx.cwd, ctx.filePath);
	const results: QualityCheckResult[] = [];
	const mtime = mtimeDriftResult(checkLockfileDrift(absPath), ctx, name, check);
	if (mtime) results.push(mtime);
	results.push(...classificationDriftResults(absPath, ctx, name, check));
	return results;
}

/** package_json_consistency — detect duplicate deps and invalid semver. */
export function runPackageJsonConsistencyCheck(
	ctx: ToolCheckLoopContext,
	name: string,
	check: QualityCheckConfig,
): QualityCheckResult[] | null {
	// Inline check — detect duplicate deps and invalid semver
	const content = ctx.getSharedContent();
	if (content === null) return [];
	const issues = checkPackageJsonConsistency(content);
	if (issues.length === 0) return [];
	const dupes = issues.filter((i) => i.kind === "duplicate");
	const badVer = issues.filter((i) => i.kind === "invalid_semver");
	const parts: string[] = [];
	if (dupes.length > 0) parts.push(`${dupes.length} duplicate(s)`);
	if (badVer.length > 0) parts.push(`${badVer.length} invalid version(s)`);
	const detail = issues
		.slice(0, 10)
		.map((i) => `  ${i.detail}`)
		.join("\n");
	const overflow = issues.length > 10 ? `\n  ... and ${issues.length - 10} more` : "";
	return [
		{
			name,
			severity: check.severity,
			message: `package.json consistency: ${parts.join(", ")} in ${ctx.filePath}`,
			file: ctx.filePath,
			detail: detail + overflow,
		},
	];
}

/** software_version_regression + freshness_sensitive_reference — both names
 *  share one before/after reference diff; the `name` selects which finding(s)
 *  to emit. */
export function runSoftwareVersionChecks(
	ctx: ToolCheckLoopContext,
	name: string,
	check: QualityCheckConfig,
): QualityCheckResult[] | null {
	const postContent = ctx.getSharedContent();
	if (postContent === null) return null;
	// Prefer the PreToolUse baseline (full before-file). When it is
	// absent (e.g. harness restarted between pre/post, or no pre
	// snapshot), reconstruct the full before-file by reverting the
	// edit — replace new_string back with old_string in the post
	// content. Collecting refs from the bare old_string snippet
	// alone is wrong: every pre-existing reference outside the
	// edited region would be absent from beforeRefs and so look
	// "newly introduced", firing freshness warnings on untouched
	// content whose line numbers merely shifted.
	let beforeRefs = ctx.baseline?.softwareVersions;
	if (!beforeRefs) {
		const oldStr = ctx.event.tool_input?.old_string;
		const newStr = ctx.event.tool_input?.new_string;
		if (typeof oldStr === "string" && typeof newStr === "string") {
			const reverted = postContent.includes(newStr)
				? postContent.replace(newStr, oldStr)
				: postContent;
			beforeRefs = collectSoftwareVersionReferences(reverted, ctx.filePath);
		} else if (typeof oldStr === "string") {
			beforeRefs = collectSoftwareVersionReferences(oldStr, ctx.filePath);
		} else {
			beforeRefs = [];
		}
	}
	// getAfterRefs memoizes — the second check on the same Edit
	// reuses the first check's full-file regex sweep.
	const afterRefs = ctx.getAfterRefs(postContent);
	const regressions = detectSoftwareVersionRegressions(beforeRefs, afterRefs);
	const regressionAfterKeys = new Set(
		regressions.map((r) => `${r.after.anchor}\0${r.after.version}`),
	);
	const freshnessConcerns = detectSoftwareVersionFreshnessConcerns(beforeRefs, afterRefs).filter(
		(c) => !regressionAfterKeys.has(`${c.ref.anchor}\0${c.ref.version}`),
	);
	const out: QualityCheckResult[] = [];
	if (name === "software_version_regression" && regressions.length > 0) {
		out.push({
			name,
			severity: check.severity,
			message:
				`PostToolUse attention required in ${ctx.filePath}: ` +
				`${regressions.length} possible software version regression(s). ` +
				"This often means the agent may be relying on stale remembered software names or versions instead of the current or intended source of truth.",
			file: ctx.filePath,
			detail: formatSoftwareVersionRegressionDetail(regressions),
		});
	}
	if (name === "freshness_sensitive_reference" && freshnessConcerns.length > 0) {
		out.push({
			name,
			severity: check.severity,
			message:
				`${freshnessConcerns.length} freshness-sensitive software reference(s) introduced in ${ctx.filePath}. ` +
				"Verify against official source material before relying on remembered model/API/version names.",
			file: ctx.filePath,
			detail: formatSoftwareVersionFreshnessDetail(freshnessConcerns),
		});
	}
	return out;
}
