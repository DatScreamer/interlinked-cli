// ===========================================================================
// `interlinked design [path]` — wrap Impeccable's deterministic design detector
// ===========================================================================
// Invoke-as-subprocess surface for the FULL Impeccable detector (44 rules + CSS
// cascade + optional browser engine) without taking on its deps — exactly how
// `interlinked verify` shells out to semgrep/gitleaks/hadolint. The native
// `design_slop` advisory check (src/harness/checks/design-slop.ts) ports only
// the pure-regex subset; this command reaches the rest when `impeccable` is on
// PATH, and degrades loudly when it is not. Intake: docs/external-pulse/impeccable.md.

import { execFileSync } from "node:child_process";
import type { OptionValues } from "commander";
import { getOutputMode, output, outputError } from "../lib/output.js";

/** A single finding as emitted by `impeccable detect --json`. */
export interface ImpeccableFinding {
	file: string;
	line: number | null;
	antipattern: string;
	description: string;
	snippet: string;
}

/** Outcome of one detector run. `not-installed` is a first-class, non-error
 *  state — the tool is optional, so its absence degrades, it does not fail. */
export interface DesignScanResult {
	status: "ok" | "not-installed" | "error";
	findings: ImpeccableFinding[];
	message?: string;
}

/** The subprocess seam — injected in tests, defaulted to the real binary. */
export type DetectExec = (target: string, flags: string[]) => string;

/** Real detector invocation. Throws ENOENT when `impeccable` is absent, and a
 *  non-zero-exit error (carrying `.stdout`) when findings are present. */
export const realDetectExec: DetectExec = (target, flags) =>
	execFileSync("impeccable", ["detect", "--json", target, ...flags], { encoding: "utf-8" });

/** Tolerant parse of `impeccable detect --json` output into typed findings.
 *  Never throws — malformed / non-array output yields an empty list. */
export function parseImpeccableJson(stdout: string): ImpeccableFinding[] {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		return [];
	}
	if (!Array.isArray(data)) return [];
	return data.map(normalizeFinding);
}

function normalizeFinding(d: unknown): ImpeccableFinding {
	if (d === null || typeof d !== "object") {
		return { file: "", line: null, antipattern: "unknown", description: "", snippet: "" };
	}
	return {
		file: "file" in d && typeof d.file === "string" ? d.file : "",
		line: "line" in d && typeof d.line === "number" ? d.line : null,
		antipattern: "antipattern" in d && typeof d.antipattern === "string" ? d.antipattern : "unknown",
		description: "description" in d && typeof d.description === "string" ? d.description : "",
		snippet: "snippet" in d && typeof d.snippet === "string" ? d.snippet : "",
	};
}

/** Run the detector against `target`, classifying the outcome. */
export function runImpeccableDetect(
	target: string,
	flags: string[],
	exec: DetectExec = realDetectExec,
): DesignScanResult {
	try {
		return { status: "ok", findings: parseImpeccableJson(exec(target, flags)) };
	} catch (err) {
		// Non-zero exit with findings: the JSON is on stdout, not a real failure.
		if (
			err !== null &&
			typeof err === "object" &&
			"stdout" in err &&
			typeof err.stdout === "string" &&
			err.stdout.trim().startsWith("[")
		) {
			return { status: "ok", findings: parseImpeccableJson(err.stdout) };
		}
		if (err !== null && typeof err === "object" && "code" in err && err.code === "ENOENT") {
			return { status: "not-installed", findings: [] };
		}
		return { status: "error", findings: [], message: err instanceof Error ? err.message : String(err) };
	}
}

/** One-line summary (used in `--short`). */
export function summarizeDesignFindings(findings: ImpeccableFinding[]): string {
	if (findings.length === 0) return "No design tells found.";
	const files = new Set(findings.map((f) => f.file)).size;
	return `${findings.length} design tell(s) across ${files} file(s).`;
}

/** Grouped, human-readable rendering (used in `normal`/`--full`). */
export function formatDesignFindings(findings: ImpeccableFinding[]): string {
	if (findings.length === 0) return "No design tells found. ✓";
	const byFile = new Map<string, ImpeccableFinding[]>();
	for (const f of findings) {
		const arr = byFile.get(f.file) ?? [];
		arr.push(f);
		byFile.set(f.file, arr);
	}
	const lines: string[] = [];
	for (const [file, items] of byFile) {
		lines.push(`\n${file}`);
		for (const it of items) {
			const loc = it.line === null ? "" : `:${it.line}`;
			lines.push(`  ${loc.padEnd(5)} [${it.antipattern}] ${it.description}`);
		}
	}
	lines.push(`\n${summarizeDesignFindings(findings)}`);
	return lines.join("\n");
}

/**
 * `interlinked design [path]` — run Impeccable's deterministic design detector
 * over `path` (default `.`) and report findings in the selected output mode.
 *
 * `run` is injectable for testing; production uses {@link runImpeccableDetect}.
 */
export function designCommand(
	path: string | undefined,
	opts: OptionValues,
	run: (target: string, flags: string[]) => DesignScanResult = runImpeccableDetect,
): void {
	const mode = getOutputMode(opts);
	const target = typeof path === "string" && path.trim().length > 0 ? path : ".";
	const flags: string[] = [];
	if (opts.gpt === true) flags.push("--gpt");
	if (opts.gemini === true) flags.push("--gemini");

	const result = run(target, flags);

	if (result.status === "not-installed") {
		output(
			mode,
			{ status: "not-installed" },
			{
				json: () => ({ status: "not-installed", findings: [] }),
				normal: () =>
					"impeccable is not installed — this command wraps its deterministic design detector.\n" +
					"Install it with `npm i -g impeccable`, or run `npx impeccable detect` directly.\n" +
					"The built-in `design_slop` advisory check (`interlinked verify --all-checks`) covers a subset natively.",
			},
		);
		return;
	}

	if (result.status === "error") {
		outputError(mode, `impeccable detect failed: ${result.message ?? "unknown error"}`);
		return;
	}

	output(mode, result.findings, {
		json: () => ({ status: "ok", count: result.findings.length, findings: result.findings }),
		short: () => summarizeDesignFindings(result.findings),
		normal: () => formatDesignFindings(result.findings),
	});
}
