// ===========================================
// interlinked mutation disposition — record a NON-accepting judgment
// ===========================================
//
// `mutation accept` deliberately refuses everything but a certificate-bearing
// `proved_equivalent` (see mutation.ts and accept.ts: a reason is not a
// mechanism). That refusal is right, but on its own it left a survivor with
// exactly two end-states — killed, or unjustified forever — and no way to say
// anything true about the ones in between.
//
// The consequence was concrete. Agents auditing this repo's survivors kept
// producing findings the manifest had no room for: one reported 53 mutants it
// argued were equivalent and one line of genuinely dead code, all of it prose
// in a chat message that no gate, report, or later run could read. Meanwhile
// "drive unjustified survivors to zero" could never be satisfied, because the
// count of unjustified survivors was definitionally the count of survivors.
//
// `recordDisposition` (accept.ts) is the honest home for those judgments: it
// leaves `status` exactly as MEASURED and never writes `accepted_reason`, so a
// `dead_code` note cannot later be read back as a reviewed acceptance. This
// command is its CLI surface, and it is deliberately narrow — the two kinds an
// automated auditor can honestly reach:
//
//   dead_code   the mutant is unkillable because the code should not exist.
//               The resolution is to DELETE or IMPLEMENT it, not to bless it.
//   unresolved  a counterexample search that did not find one. Evidence of
//               effort, explicitly NOT proof of equivalence.
//
// The kinds requiring human sign-off (`outside_contract`, `accepted_risk`) take
// a `HumanApproval` with an artifact reference and are not exposed here: a
// command an agent can call is not a human approving anything.

import { resolve } from "node:path";
import { getConfigDir } from "../lib/config.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import type { CounterexampleSearchEvidence, SurvivorDisposition } from "../harness/mutation/disposition.js";

export interface MutationDispositionOptions {
	file?: string;
	id?: string;
	kind?: string;
	resolution?: string;
	issue?: string;
	strategy?: string;
	runs?: string;
	seed?: string;
	budgetMs?: string;
	cwd?: string;
	json?: boolean;
	/** List every recorded disposition instead of recording one. */
	list?: boolean;
	/** Show the record for --file/--id instead of recording one. */
	show?: boolean;
}

/** Search strategies `CounterexampleSearchEvidence` accepts. Kept as a runtime
 *  list because the value arrives as a CLI string and must be validated, not
 *  cast — an unrecognized strategy would otherwise be written to the manifest
 *  verbatim and fail to parse on read. */
const SEARCH_STRATEGIES: CounterexampleSearchEvidence["strategy"][] = [
	"property",
	"fuzz",
	"differential",
	"bounded_exhaustive",
	"test_suite",
];

function parseStrategy(v: string): CounterexampleSearchEvidence["strategy"] | null {
	return SEARCH_STRATEGIES.find((s) => s === v) ?? null;
}

/**
 * Build the typed disposition from CLI strings, or return the usage error.
 *
 * Every failure path names what was wrong AND what a valid value looks like:
 * the caller is usually an agent, and "invalid kind" without the list of kinds
 * costs it a round-trip it will spend guessing.
 */
type BuildResult = { disposition: SurvivorDisposition } | { error: string };

function buildDeadCode(opts: MutationDispositionOptions): BuildResult {
	const resolution = opts.resolution;
	if (resolution !== "delete" && resolution !== "implement") {
		return {
			error: "dead_code requires --resolution delete|implement (is the code to be removed, or was it never finished?).",
		};
	}
	const issueRef = opts.issue?.trim();
	return {
		disposition: issueRef ? { kind: "dead_code", resolution, issueRef } : { kind: "dead_code", resolution },
	};
}

function buildUnresolved(opts: MutationDispositionOptions, now: () => string): BuildResult {
	// Bare `unresolved` is legal — it is the honest default for "I looked and
	// found nothing", and demanding evidence for it would push callers toward a
	// stronger claim than they can support.
	if (opts.strategy === undefined) return { disposition: { kind: "unresolved" } };
	const strategy = parseStrategy(opts.strategy);
	if (!strategy) return { error: `--strategy must be one of: ${SEARCH_STRATEGIES.join(", ")}.` };
	const runs = Number.parseInt(opts.runs ?? "", 10);
	if (!Number.isFinite(runs) || runs <= 0) {
		return { error: "--strategy requires --runs <n> (how many cases the search actually ran)." };
	}
	const budgetMs = Number.parseInt(opts.budgetMs ?? "", 10);
	return {
		disposition: {
			kind: "unresolved",
			evidence: {
				strategy,
				runs,
				seed: opts.seed ?? "",
				budgetMs: Number.isFinite(budgetMs) ? budgetMs : 0,
				searchedAt: now(),
			},
		},
	};
}

export function buildDisposition(opts: MutationDispositionOptions, now: () => string): BuildResult {
	if (opts.kind === "dead_code") return buildDeadCode(opts);
	if (opts.kind === "unresolved") return buildUnresolved(opts, now);
	return {
		error:
			"--kind must be dead_code or unresolved. An equivalence claim goes through `mutation accept`, which requires a verifier-issued certificate — prose is refused there by design.",
	};
}

export async function mutationDispositionCommand(opts: MutationDispositionOptions): Promise<void> {
	const cwd = resolve(opts.cwd || process.cwd());
	const configDir = getConfigDir(cwd);
	if (opts.list === true) return listDispositions(configDir, opts);
	if (opts.show === true) return showDisposition(configDir, opts);
	return recordDispositionToLedger(configDir, opts);
}

/**
 * Record a NON-accepting judgment into the durable sidecar ledger.
 *
 * Repointed from the manifest to `.interlinked/mutation-dispositions.json` (plan
 * 18 §1.3): a re-measure rebuilds every MutantRecord and drops its disposition,
 * so a manifest-written judgment had a half-life of minutes. The ledger is not
 * owned by the measurement pipeline, so it survives a sweep by construction. The
 * manifest existence check stays — a disposition for a mutant nobody measured is
 * a typo — and symbolId/symbolHash come from the manifest, never a flag.
 */
async function recordDispositionToLedger(configDir: string, opts: MutationDispositionOptions): Promise<void> {
	const mode = getOutputMode(opts);
	const file = opts.file?.trim() ?? "";
	const mutantId = opts.id?.trim() ?? "";
	if (file === "" || mutantId === "") {
		outputError(
			mode,
			"Usage: interlinked mutation disposition --file <repo-relative-path> --id <mutantId> --kind dead_code|unresolved [...]  (or --list / --show).",
		);
		process.exitCode = 1;
		return;
	}

	const built = buildDisposition(opts, () => new Date().toISOString());
	if ("error" in built) {
		outputError(mode, built.error);
		process.exitCode = 1;
		return;
	}

	const { loadManifest } = await import("../harness/mutation/manifest.js");
	const { findMutantRecord } = await import("../harness/mutation/accept.js");
	const { describeDisposition } = await import("../harness/mutation/disposition.js");
	const { loadLedger, makeRecord, refuseRecord, saveLedger, upsertRecord } = await import(
		"../harness/mutation/disposition-store.js"
	);

	const base = loadManifest(configDir);
	if (!base) {
		outputError(mode, "No mutation manifest — measure the file first (`interlinked mutation measure <file> --record`).");
		process.exitCode = 1;
		return;
	}
	if (!findMutantRecord(base, file, mutantId)) {
		outputError(mode, `Mutant "${mutantId}" not found under "${file}". List the file's survivors before dispositioning.`);
		process.exitCode = 1;
		return;
	}

	const record = makeRecord({
		manifest: base,
		file,
		mutantId,
		disposition: built.disposition,
		recordedBy: "cli:mutation disposition",
		now: () => new Date().toISOString(),
	});
	if (!record) {
		outputError(mode, `Mutant "${mutantId}" not found under "${file}".`);
		process.exitCode = 1;
		return;
	}
	const refusal = refuseRecord(record);
	if (refusal) {
		outputError(mode, `Refused: ${refusal}`);
		process.exitCode = 1;
		return;
	}

	// Stamp the ledger with the manifest fingerprint it was adjudicated against.
	const stamped = {
		...loadLedger(configDir),
		environmentHash: base.environmentHash,
		dependencyGraphVersion: base.dependencyGraphVersion,
	};
	const next = upsertRecord({ ledger: stamped, record });
	if (!next) {
		outputError(mode, `Refused: "${built.disposition.kind}" cannot be recorded against "${mutantId}".`);
		process.exitCode = 1;
		return;
	}
	saveLedger(configDir, next);

	const payload = { file: record.file, mutantId, disposition: built.disposition, recorded: true, store: "ledger" };
	output(mode, payload, {
		json: () => payload,
		normal: () => [
			`Recorded: ${mutantId} (${record.file})`,
			`  ${describeDisposition(built.disposition)}`,
			"  Written to .interlinked/mutation-dispositions.json — durable; a re-measure will not wipe it.",
			// Say the quiet part: this did NOT make the mutant go away. A reader
			// who thinks it did will stop looking for the test that kills it.
			"  Status is unchanged — this annotates the survivor, it does not resolve it.",
		].join("\n"),
	});
}

/** List every recorded disposition (honest empty state when the ledger is absent). */
async function listDispositions(configDir: string, opts: MutationDispositionOptions): Promise<void> {
	const mode = getOutputMode(opts);
	const { loadLedger } = await import("../harness/mutation/disposition-store.js");
	const ledger = loadLedger(configDir);
	const payload = { count: ledger.records.length, records: ledger.records };
	output(mode, payload, {
		json: () => payload,
		normal: () => {
			if (ledger.records.length === 0) {
				return "No recorded dispositions — .interlinked/mutation-dispositions.json is empty.";
			}
			return [
				`${ledger.records.length} recorded disposition(s):`,
				...ledger.records.map((r) => `  ${r.mutantId}  ${r.disposition.kind}  ${r.qualifiedName}  ${r.file}`),
			].join("\n");
		},
	});
}

/** Show one recorded disposition by --id (optionally scoped by --file substring). */
async function showDisposition(configDir: string, opts: MutationDispositionOptions): Promise<void> {
	const mode = getOutputMode(opts);
	const mutantId = opts.id?.trim() ?? "";
	if (mutantId === "") {
		outputError(mode, "Usage: interlinked mutation disposition --show --id <mutantId> [--file <path>].");
		process.exitCode = 1;
		return;
	}
	const { loadLedger } = await import("../harness/mutation/disposition-store.js");
	const needle = opts.file?.trim();
	const record = loadLedger(configDir).records.find(
		(r) => r.mutantId === mutantId && (!needle || r.file.includes(needle)),
	);
	if (!record) {
		outputError(mode, `No disposition recorded for "${mutantId}"${needle ? ` under "${needle}"` : ""}.`);
		process.exitCode = 1;
		return;
	}
	output(mode, record, { json: () => record, normal: () => JSON.stringify(record, null, 2) });
}
