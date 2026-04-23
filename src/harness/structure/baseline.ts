// ===========================================
// Generic Artifact Structure V1 — Baseline Management
// ===========================================
// Manages the baseline file that records acknowledged structure findings,
// allowing them to be suppressed in future runs.

import { createHash } from "node:crypto";
import type { BaselineEntry, BaselineFile, StructureFinding } from "./types.js";

// -------------------------------------------
// Check if a finding is baselined
// -------------------------------------------

export function isBaselined(finding: StructureFinding, baseline: BaselineFile): boolean {
	return baseline.entries.some((entry) => entryMatchesFinding(entry, finding));
}

function entryMatchesFinding(entry: BaselineEntry, finding: StructureFinding): boolean {
	return (
		entry.finding_name === finding.name &&
		entry.artifact_ref === `${finding.artifact_kind}:${finding.artifact_id}` &&
		entry.source_file === finding.file &&
		entry.determinism === finding.determinism
	);
}

// -------------------------------------------
// Add findings to baseline (with dedup)
// -------------------------------------------

export function addToBaseline(baseline: BaselineFile, findings: StructureFinding[]): BaselineFile {
	const newEntries = findings.map(findingToBaselineEntry);

	// Deduplicate: only add entries not already present
	const existing = new Set(baseline.entries.map(baselineEntryKey));

	const deduped = newEntries.filter((entry) => !existing.has(baselineEntryKey(entry)));

	return {
		schema_version: 1,
		entries: [...baseline.entries, ...deduped],
	};
}

// -------------------------------------------
// Convert a StructureFinding to a BaselineEntry
// -------------------------------------------

export function findingToBaselineEntry(finding: StructureFinding): BaselineEntry {
	const companionFiles = finding.required_updates.map((u) => u.file);
	return {
		finding_name: finding.name,
		artifact_ref: `${finding.artifact_kind}:${finding.artifact_id}`,
		source_file: finding.file,
		determinism: finding.determinism,
		required_companion_files: companionFiles,
		context_hash: computeContextHash(companionFiles),
	};
}

// -------------------------------------------
// Helpers
// -------------------------------------------

function computeContextHash(companionFiles: string[]): string {
	const joined = companionFiles.slice().sort().join("\n");
	return createHash("sha256").update(joined).digest("hex");
}

function baselineEntryKey(entry: BaselineEntry): string {
	return `${entry.finding_name}|${entry.artifact_ref}|${entry.source_file}|${entry.determinism}`;
}
