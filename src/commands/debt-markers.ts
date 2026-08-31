// ===========================================
// interlinked debt markers — manual design-debt receipts
// ===========================================

import {
    scanManualDebtMarkers,
    type DebtMarkerScanResult,
    type ManualDebtMarker,
} from "../lib/manual-debt-markers.js";
import {
    recordManualDebtMarkerSnapshot,
    type ManualDebtMarkerRecordResult,
} from "../lib/manual-debt-marker-record.js";
import { getOutputMode, output } from "../lib/output.js";

export interface DebtMarkersCommandOptions {
    cwd?: string | undefined;
    root?: string[] | undefined;
    exclude?: string[] | undefined;
    record?: boolean;
    reason?: string | undefined;
    json?: boolean;
    short?: boolean;
    full?: boolean;
}

function markerLine(marker: ManualDebtMarker): string {
    const explicitId = marker.id ? ` id=${marker.id}` : "";
    return `  ${marker.fingerprint}${explicitId}  ${marker.file}:${marker.line}  ${marker.decision}`;
}

function recordingLines(recording?: ManualDebtMarkerRecordResult): string[] {
    if (!recording) return [];
    return [
        `Recorded snapshot ${recording.receipt.snapshot_fingerprint.slice(0, 12)} — ${recording.opened} opened, ${recording.changed} changed, ${recording.closed} closed → ${recording.receipt_path}`,
    ];
}

function repositoryLine(report: DebtMarkerScanResult): string {
    const head = report.repository.head_sha ?? "unavailable";
    const tree = report.repository.tree_sha ?? "unavailable";
    return `Repository: head ${head}; tree ${tree}`;
}

function skippedCount(report: DebtMarkerScanResult): number {
    return Object.values(report.coverage.skipped).reduce((sum, count) => sum + count, 0);
}

function renderNormal(
    report: DebtMarkerScanResult,
    recording?: ManualDebtMarkerRecordResult,
): string {
    const lines = [
        `Manual debt markers: ${report.markers.length} valid, ${report.advisories.length} advisory`,
    ];
    if (report.markers.length === 0 && report.advisories.length === 0) {
        lines.push("  No markers found in the covered source scope.");
    }
    for (const marker of report.markers) lines.push(markerLine(marker));
    for (const advisory of report.advisories) {
        lines.push(
            `  [advisory:${advisory.code}] ${advisory.file}:${advisory.line} — ${advisory.message}`,
        );
    }
    lines.push(
        "",
        `Coverage: ${report.coverage.files_scanned}/${report.coverage.files_considered} supported file(s), ${report.coverage.lines_scanned} line(s); ${skippedCount(report)} skipped`,
        repositoryLine(report),
        "Obligation ledger: not consulted; not modified.",
        ...recordingLines(recording),
    );
    return lines.join("\n");
}

function markerDetailLines(marker: ManualDebtMarker): string[] {
    const lines = [
        "",
        `${marker.fingerprint} (${marker.file}:${marker.line})`,
        `  decision: ${marker.decision}`,
        `  ceiling:  ${marker.ceiling}`,
        `  trigger:  ${marker.trigger}`,
        `  content:  ${marker.content_fingerprint}`,
    ];
    if (marker.id) lines.push(`  id:       ${marker.id}`);
    if (marker.owner) lines.push(`  owner:    ${marker.owner}`);
    if (marker.issue) lines.push(`  issue:    ${marker.issue}`);
    if (marker.review) lines.push(`  review:   ${marker.review}`);
    if (marker.review_after) lines.push(`  review-after: ${marker.review_after}`);
    if (marker.finding) lines.push(`  finding:  ${marker.finding}`);
    return lines;
}

function renderFull(
    report: DebtMarkerScanResult,
    recording?: ManualDebtMarkerRecordResult,
): string {
    const lines = [renderNormal(report, recording)];
    for (const marker of report.markers) {
        lines.push(...markerDetailLines(marker));
    }
    lines.push("", `Skipped by reason: ${JSON.stringify(report.coverage.skipped)}`);
    return lines.join("\n");
}

function validateRecordingOptions(opts: DebtMarkersCommandOptions): void {
    if (opts.reason !== undefined && opts.record !== true) {
        throw new Error("--reason requires --record");
    }
}

function maybeRecord(
    report: DebtMarkerScanResult,
    opts: DebtMarkersCommandOptions,
): ManualDebtMarkerRecordResult | undefined {
    if (opts.record !== true) return undefined;
    return recordManualDebtMarkerSnapshot(report, report.repository.root, { reason: opts.reason });
}

function renderShort(
    report: DebtMarkerScanResult,
    recording?: ManualDebtMarkerRecordResult,
): string {
    const base = `${report.markers.length} manual debt marker(s), ${report.advisories.length} advisory; ${report.coverage.files_scanned} file(s) scanned`;
    if (!recording) return base;
    return `${base}; ${recording.opened} opened, ${recording.changed} changed, ${recording.closed} closed recorded`;
}

export async function debtMarkersCommand(opts: DebtMarkersCommandOptions): Promise<void> {
    validateRecordingOptions(opts);
    const report = scanManualDebtMarkers({
        cwd: opts.cwd ?? process.cwd(),
        ...(opts.root ? { roots: opts.root } : {}),
        ...(opts.exclude ? { exclude: opts.exclude } : {}),
    });
    const recording = maybeRecord(report, opts);
    output(getOutputMode(opts), report, {
        json: () => report,
        short: () => renderShort(report, recording),
        normal: () => renderNormal(report, recording),
        full: () => renderFull(report, recording),
    });
}
