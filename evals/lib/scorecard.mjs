// Rendering helpers for the harness-compat eval driver (plain node, no deps).
// Pure string building only — all execution logic lives in evals/run-evals.mjs,
// all metric math in src/harness/eval-metrics.ts.

function pad(value, width) {
	const text = String(value);
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function renderTable(headers, rows) {
	const widths = headers.map((header, i) =>
		Math.max(header.length, ...rows.map((row) => String(row[i]).length), 1),
	);
	const line = (cells) => cells.map((cellText, i) => pad(cellText, widths[i])).join("  ");
	const out = [line(headers), line(widths.map((w) => "-".repeat(w)))];
	for (const row of rows) out.push(line(row));
	return out.join("\n");
}

function cellNote(cell) {
	if (cell.setup_error) return `setup: ${cell.setup_error}`;
	if (cell.timed_out) return "TIMEOUT";
	return "";
}

function cellRow(cell) {
	const m = cell.metrics;
	return [
		cell.task,
		cell.runner,
		cell.arm,
		cell.rep,
		cell.setup_error ? "-" : cell.success ? "yes" : "NO",
		m ? m.blocks_total : "-",
		m ? m.block_loops : "-",
		m ? cell.noise_ratio.toFixed(2) : "-",
		m ? m.warnings : "-",
		cell.seconds,
		cellNote(cell),
	];
}

export function renderCells(cells) {
	const headers = ["task", "runner", "arm", "rep", "success", "blocks", "loops", "noise", "warns", "secs", "note"];
	return renderTable(headers, cells.map(cellRow));
}

export function renderComparisonRows(rows) {
	return renderTable(
		["metric", "on", "off", "delta", "flag"],
		rows.map((row) => [row.metric, row.on, row.off, row.delta, row.flag ?? "-"]),
	);
}

export function renderVerdicts(verdicts) {
	return renderTable(
		["task", "runner", "verdict", "reasons"],
		verdicts.map((v) => [v.task, v.runner, v.verdict, v.reasons.join("; ") || "-"]),
	);
}

export function renderPlan(plan) {
	return renderTable(
		["#", "task", "shape", "runner", "arm", "rep", "timeout_s"],
		plan.map((item, i) => [i + 1, item.task.slug, item.task.repo_shape, item.runner, item.arm, item.rep, item.task.timeout_s]),
	);
}
