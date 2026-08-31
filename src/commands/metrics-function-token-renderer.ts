import { c } from "../lib/formatter.js";
import type {
    FunctionTokenFileMetric,
    FunctionTokenMetricRow,
    FunctionTokenMetricsReport,
    FunctionTokenNumericSummary,
} from "./metrics-function-tokens.js";

function formatInteger(value: number): string {
    return value.toLocaleString("en-US");
}

function formatMetric(value: number | null): string {
    return value === null ? "—" : formatInteger(value);
}

function statsLine(label: string, stats: FunctionTokenNumericSummary): string {
    return `    ${label.padEnd(12)} mean ${formatMetric(stats.mean)} · `
        + `p50 ${formatMetric(stats.p50)} · p90 ${formatMetric(stats.p90)} · `
        + `p95 ${formatMetric(stats.p95)} · p99 ${formatMetric(stats.p99)} · `
        + `max ${formatMetric(stats.max)}`;
}

function scopeLines(report: FunctionTokenMetricsReport): string[] {
    const scope = report.scope.includeTests ? "product + advisory tests" : "product cap scope";
    return [
        `    scope       ${scope}`,
        `    measured    ${formatInteger(report.scope.measuredFiles)} files · `
            + `${formatInteger(report.scope.functionCount)} functions · `
            + `${formatInteger(report.scope.unmeasuredFiles)} not measured`,
        statsLine("fn stats", report.totals.functionTokens),
        statsLine("file sums", report.totals.summedFileFunctionTokens),
        c.dim(
            `    summedFunctionTokens=${formatInteger(report.totals.summedFunctionTokens)} `
                + "(nested implementations count in both their own and enclosing spans)",
        ),
    ];
}

function distributionLines(label: string, distribution: Record<string, number>, width: number): string[] {
    const lines = [c.dim(`    ${label}:`)];
    for (const [bucket, count] of Object.entries(distribution)) {
        lines.push(`    ${bucket.padEnd(width)} ${formatInteger(count)}`);
    }
    return lines;
}

function scopeSuffix(sourceScope: "product" | "test"): string {
    return sourceScope === "test" ? " [advisory test]" : "";
}

const NOT_MEASURED_PREVIEW_LIMIT = 5;

function notMeasuredPreviewLines(report: FunctionTokenMetricsReport): string[] {
    if (report.notMeasured.length === 0) return [];
    const visible = report.notMeasured.slice(0, NOT_MEASURED_PREVIEW_LIMIT);
    const remaining = report.notMeasured.length - visible.length;
    return [
        c.dim("    not measured:"),
        ...visible.map((issue) => `    ${issue.file}${scopeSuffix(issue.sourceScope)} — ${issue.reason}`),
        ...(remaining > 0
            ? [c.dim(`    … ${formatInteger(remaining)} more; use --full or --json for all`)]
            : []),
    ];
}

export function renderFunctionTokenSummaryLines(report: FunctionTokenMetricsReport): string[] {
    return [
        "",
        c.bold(`  Function-token distribution (${report.tokenizer})`),
        ...scopeLines(report),
        ...notMeasuredPreviewLines(report),
        ...distributionLines("per-function bands", report.distributions.functions, 12),
        ...distributionLines("summed tokens per measured file", report.distributions.files, 14),
    ];
}

function functionOutlierLine(row: FunctionTokenMetricRow): string {
    return `    ${String(row.canonicalTokens).padStart(6)} tokens  `
        + `${row.file}:${row.line}::${row.qualifiedName}${scopeSuffix(row.sourceScope)}`;
}

function fileOutlierLine(row: FunctionTokenFileMetric): string {
    return `    ${String(row.summedFunctionTokens).padStart(7)} summed · `
        + `${String(row.functionCount).padStart(4)} fns · `
        + `max ${String(row.maxFunctionTokens ?? 0).padStart(4)}  `
        + `${row.file}${scopeSuffix(row.sourceScope)}`;
}

export function renderFunctionTokenOutlierLines(report: FunctionTokenMetricsReport): string[] {
    return [
        "",
        c.bold(`  Top ${report.topFunctions.length} function-token hotspots`),
        ...report.topFunctions.map(functionOutlierLine),
        "",
        c.bold(`  Top ${report.topFiles.length} files by summed function tokens`),
        ...report.topFiles.map(fileOutlierLine),
    ];
}

function fileInventoryLine(row: FunctionTokenFileMetric): string {
    return `    ${String(row.summedFunctionTokens).padStart(7)} summed · `
        + `${String(row.functionCount).padStart(4)} fns · `
        + `mean ${String(row.meanFunctionTokens ?? 0).padStart(7)} · `
        + `max ${String(row.maxFunctionTokens ?? 0).padStart(4)}  `
        + `${row.file}${scopeSuffix(row.sourceScope)}`;
}

function functionInventoryLine(row: FunctionTokenMetricRow): string {
    return `    ${String(row.canonicalTokens).padStart(6)} tokens  `
        + `${row.file}:${row.line}-${row.endLine}::${row.qualifiedName}`
        + scopeSuffix(row.sourceScope);
}

function notMeasuredLines(report: FunctionTokenMetricsReport): string[] {
    if (report.notMeasured.length === 0) return [];
    return [
        "",
        c.bold(`  Files not measured (${report.notMeasured.length})`),
        ...report.notMeasured.map(
            (issue) => `    ${issue.file}${scopeSuffix(issue.sourceScope)} — ${issue.reason}`,
        ),
    ];
}

export function renderFunctionTokenInventoryLines(report: FunctionTokenMetricsReport): string[] {
    return [
        "",
        c.bold("  All per-file function-token totals"),
        ...report.files.map(fileInventoryLine),
        "",
        c.bold("  All functions by file and line"),
        ...report.functions.map(functionInventoryLine),
        ...notMeasuredLines(report),
    ];
}
