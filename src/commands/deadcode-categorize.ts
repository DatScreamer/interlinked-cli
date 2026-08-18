// ===========================================
// Dead-code categorizer — buckets candidates by deletion safety
// ===========================================
// Operator decision 2026-08-17: a dead-code CANDIDATE (from `interlinked
// deadcode`) is not a deletion order. Before any agent removes anything, each
// candidate sorts into a bucket via mechanical signals — git history, docs
// references, name patterns, export shape — and only the provably-safe
// buckets are handed to deletion agents. The classifier is a pure function
// over extracted signals; git probes are injected so tests never spawn git.
//
// The motivating pair (both verified against this repo before building):
//   differential-fuzz-types.ts — never imported in ANY commit, named in two
//     plan docs → future-scaffolding; deleting it would undo planned design.
//   parseCargo — alive in -ecosystems.ts, only the barrel re-export is dead
//     → reexport-residue; removing the line deletes zero code, tsc guards it.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import type { DeadCodeReport, DeadExportFinding } from "./deadcode.js";

export type DeadCodeBucket =
	| "future-scaffolding"
	| "deliberate-seam"
	| "reexport-residue"
	| "orphaned-type"
	| "superseded"
	| "ambiguous";

export type DeadCodeRecommendation = "keep" | "annotate" | "delete-line" | "delete" | "review";

export interface CandidateSignals {
	kind: "file" | "export";
	/** Any commit in history references this file as an import target. */
	everImported: boolean;
	/** docs/, CLAUDE.md, or skills/ mention the file or symbol by name. */
	docReferenced: boolean;
	/** Name shaped like a test seam (_reset*, *ForTests, __test_only__). */
	seamName: boolean;
	/** File is a package.json bin / exports-map target (published API). */
	publishedSurface: boolean;
	/** Only test files import it — alive solely as a test handle. */
	testOnlyImporters: boolean;
	/** The unused export is a re-export line; the code lives elsewhere. */
	reExportLine: boolean;
	/** Type/interface export — compile-time only, tsc guards removal. */
	typeOnly: boolean;
	/** Importers existed in history and were removed (successor exists). */
	hadImportersRemoved: boolean;
}

export interface CategorizedItem {
	file: string;
	symbol?: string;
	bucket: DeadCodeBucket;
	recommendation: DeadCodeRecommendation;
	reason: string;
}

export interface InertBranchItem {
	file: string;
	qualifiedName: string;
	records: number;
}

export interface CategorizeReport {
	items: CategorizedItem[];
	/** Mutation-adjudicated dead_code records (behaviorally inert branches). */
	inertBranches: InertBranchItem[];
}

export interface CandidateVerdict {
	bucket: DeadCodeBucket;
	recommendation: DeadCodeRecommendation;
	reason: string;
}

function seamKind(s: CandidateSignals): string {
	if (s.seamName) return "seam-shaped name";
	if (s.publishedSurface) return "published surface";
	return "test-only importers";
}

/** Precedence is the safety policy: keep-buckets first (wrongly deleting
 *  planned or deliberate code is the costly error), then the compiler-guarded
 *  deletions, then git-evidenced ones, then review. */
export function categorizeCandidate(s: CandidateSignals): CandidateVerdict {
	if (!s.everImported && s.docReferenced) {
		return {
			bucket: "future-scaffolding",
			recommendation: "keep",
			reason: "never imported in git history AND referenced in docs/plans — planned design",
		};
	}
	if (s.seamName || s.publishedSurface || s.testOnlyImporters) {
		return {
			bucket: "deliberate-seam",
			recommendation: "annotate",
			reason: `${seamKind(s)} — deliberate API; document instead of deleting`,
		};
	}
	if (s.reExportLine) {
		return {
			bucket: "reexport-residue",
			recommendation: "delete-line",
			reason: "re-export line only; the code lives elsewhere — tsc guards the removal",
		};
	}
	if (s.typeOnly) {
		return {
			bucket: "orphaned-type",
			recommendation: "delete",
			reason: "type-only export with no references — compile-time only, tsc guards removal",
		};
	}
	if (s.hadImportersRemoved) {
		return {
			bucket: "superseded",
			recommendation: "delete",
			reason: "importers existed and were removed by a later refactor — successor exists",
		};
	}
	if (!s.everImported) {
		return {
			bucket: "ambiguous",
			recommendation: "review",
			reason:
				"never imported in git history but no doc reference found — scaffolding whose docs use prose, or stillborn code; review intent before any action",
		};
	}
	return {
		bucket: "ambiguous",
		recommendation: "review",
		reason: "no safety signal matched — human/agent review before any action",
	};
}

const DOCS_ROOTS = ["docs", "skills"];
const DOCS_FILES = ["CLAUDE.md", "AGENTS.md", "README.md"];
const DOCS_CORPUS_CAP_BYTES = 16 * 1024 * 1024;

function walkMarkdown(root: string, dir: string, out: string[]): void {
	const abs = join(root, dir);
	if (!existsSync(abs)) return;
	for (const name of readdirSync(abs)) {
		if (name === "node_modules" || name.startsWith(".")) continue;
		const rel = `${dir}/${name}`;
		try {
			if (statSync(join(root, rel)).isDirectory()) walkMarkdown(root, rel, out);
			else if (name.endsWith(".md")) out.push(rel);
		} catch (err) {
			void err; // vanished mid-walk — skip
		}
	}
}

export interface DocsCorpus {
	mentions(symbol: string): boolean;
}

/** One read of every shipped markdown surface (docs/, skills/, root files);
 *  `mentions` is a word-boundary match so `Planned` does not hit
 *  `PlannedThing`. Capped so a pathological docs tree cannot OOM the scan. */
export function buildDocsCorpus(cwd: string): DocsCorpus {
	const files: string[] = [];
	for (const root of DOCS_ROOTS) walkMarkdown(cwd, root, files);
	const chunks: string[] = [];
	let total = 0;
	for (const rel of [...DOCS_FILES, ...files]) {
		try {
			const text = readFileSync(join(cwd, rel), "utf-8");
			total += text.length;
			if (total > DOCS_CORPUS_CAP_BYTES) break;
			chunks.push(text);
		} catch (err) {
			void err; // absent root file — fine
		}
	}
	const corpus = chunks.join("\n");
	return {
		mentions(symbol: string): boolean {
			if (!symbol) return false;
			const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`\\b${escaped}\\b`).test(corpus);
		},
	};
}

const SEAM_NAME_RE = /^_|ForTests$|__test_only__/;

export interface GitProbeResult {
	everImported: boolean;
	hadImportersRemoved: boolean;
}

/** Real git probe for FILE candidates: any commit whose diff contains the
 *  file's import specifier (`<base>.js`) means it was imported at some point;
 *  since the candidate is currently importerless, "ever imported" implies
 *  the importers were later removed. Bounded to one spawn per file.
 *  (Deliberate public API: the default `gitProbe` for CategorizeInputs.) */
// interlinked: defer same_typed_primitive_params -- (cwd, relFile) has one internal call site directly below and is injected in tests; a struct param would obscure the probe seam
export function gitFileProbe(cwd: string, relFile: string): GitProbeResult {
	const base = relFile.slice(relFile.lastIndexOf("/") + 1).replace(/\.[jt]sx?$/, "");
	try {
		// -1 lets git stop at the first matching commit — fast when the file
		// WAS imported; a never-imported file still costs a full history walk
		// (calibration 2026-08-17: 20s timed out mid-walk and the error path's
		// conservative "ever imported" mis-bucketed differential-fuzz-types).
		const out = execFileSync("git", ["log", "-1", "--oneline", "-S", `${base}.js"`, "--", "src"], {
			cwd,
			encoding: "utf-8",
			timeout: 60_000,
		});
		const everImported = out.trim().length > 0;
		return { everImported, hadImportersRemoved: everImported };
	} catch (err) {
		void err; // no git / timeout — unknown reads as "ever imported" (conservative)
		return { everImported: true, hadImportersRemoved: false };
	}
}

/** Files reachable-by-definition from package.json (bin + exports map). */
function publishedTargets(cwd: string): Set<string> {
	const targets = new Set<string>();
	try {
		const raw: unknown = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
		if (!isJsonObject(raw)) return targets;
		const addDist = (v: unknown): void => {
			if (typeof v === "string") {
				targets.add(v.replace(/^\.\//, "").replace(/^dist\//, "src/").replace(/\.js$/, ".ts"));
			} else if (isJsonObject(v)) {
				for (const inner of Object.values(v)) addDist(inner);
			}
		};
		addDist(raw.bin);
		addDist(raw.exports);
	} catch (err) {
		void err; // unreadable manifest — nothing published
	}
	return targets;
}

function symbolsFromDetail(detail: string): string[] {
	const quoted = detail.match(/unused export '([^']+)'/);
	if (quoted?.[1]) return [quoted[1]];
	return [...detail.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "").filter((s) => s.length > 0);
}

function exportShape(content: string, symbol: string): { reExportLine: boolean; typeOnly: boolean } {
	const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const reExport = new RegExp(`export\\s+(?:type\\s+)?\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s+from`);
	const typeDecl = new RegExp(`export\\s+(?:type|interface)\\s+${escaped}\\b`);
	return { reExportLine: reExport.test(content), typeOnly: typeDecl.test(content) };
}

export interface CategorizeInputs {
	unreachableFiles: DeadCodeReport["unreachableFiles"];
	deadExports: DeadExportFinding[];
	/** Injected in tests; defaults to the real bounded `git log -S` probe. */
	gitProbe?: (relFile: string) => GitProbeResult;
	/** Injected by the production caller from the project graph. */
	testOnlyImportersFor?: (relFile: string) => boolean;
}

/** Everything the per-candidate classifiers read, resolved once per pass. */
interface ClassifyCtx {
	cwd: string;
	corpus: DocsCorpus;
	published: Set<string>;
	probe: (relFile: string) => GitProbeResult;
	testOnly: (relFile: string) => boolean;
}

function classifyFile(ctx: ClassifyCtx, rel: string): CategorizedItem {
	const base = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.[jt]sx?$/, "");
	const git = ctx.probe(rel);
	const verdict = categorizeCandidate({
		kind: "file",
		everImported: git.everImported,
		docReferenced: ctx.corpus.mentions(base),
		seamName: SEAM_NAME_RE.test(base),
		publishedSurface: ctx.published.has(rel),
		testOnlyImporters: false,
		reExportLine: false,
		typeOnly: false,
		hadImportersRemoved: git.hadImportersRemoved,
	});
	return { file: rel, ...verdict };
}

function classifyExport(
	ctx: ClassifyCtx,
	finding: DeadExportFinding,
	symbol: string,
): CategorizedItem {
	let content = "";
	try {
		content = readFileSync(join(ctx.cwd, finding.file), "utf-8");
	} catch (err) {
		void err; // vanished — shape signals stay false
	}
	const shape = exportShape(content, symbol);
	const verdict = categorizeCandidate({
		kind: "export",
		// Per-symbol git archaeology is unaffordable at this volume; "unknown"
		// must not read as never-imported, so exports never bucket as scaffolding.
		everImported: true,
		docReferenced: ctx.corpus.mentions(symbol),
		seamName: SEAM_NAME_RE.test(symbol),
		publishedSurface: ctx.published.has(finding.file),
		testOnlyImporters: ctx.testOnly(finding.file),
		reExportLine: shape.reExportLine,
		typeOnly: shape.typeOnly,
		hadImportersRemoved: false,
	});
	return { file: finding.file, symbol, ...verdict };
}

function foldInertRecord(counts: Map<string, InertBranchItem>, rec: unknown): void {
	if (!isJsonObject(rec) || !isJsonObject(rec.disposition)) return;
	if (rec.disposition.kind !== "dead_code") return;
	const file = typeof rec.file === "string" ? rec.file : "?";
	const name = typeof rec.qualifiedName === "string" ? rec.qualifiedName : "?";
	const key = `${file}::${name}`;
	const prior = counts.get(key);
	if (prior) prior.records += 1;
	else counts.set(key, { file, qualifiedName: name, records: 1 });
}

/** Read behaviorally-inert branches from the mutation adjudication ledger —
 *  the semantic layer reachability analysis cannot see. Absent ledger ⇒ []. */
function readInertBranches(cwd: string): InertBranchItem[] {
	const path = join(cwd, ".interlinked", "mutation-dispositions.json");
	if (!existsSync(path)) return [];
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isJsonObject(raw) || !Array.isArray(raw.records)) return [];
		const counts = new Map<string, InertBranchItem>();
		for (const rec of raw.records) foldInertRecord(counts, rec);
		return [...counts.values()].sort((a, b) => b.records - a.records);
	} catch (err) {
		void err; // malformed ledger — report nothing rather than guess
		return [];
	}
}

/** The full pass: classify every candidate + attach the inert-branch layer. */
export function categorizeDeadCode(cwd: string, inputs: CategorizeInputs): CategorizeReport {
	const ctx: ClassifyCtx = {
		cwd,
		corpus: buildDocsCorpus(cwd),
		published: publishedTargets(cwd),
		probe: inputs.gitProbe ?? ((rel: string) => gitFileProbe(cwd, rel)),
		testOnly: inputs.testOnlyImportersFor ?? (() => false),
	};

	const items: CategorizedItem[] = [];
	for (const rel of inputs.unreachableFiles) {
		items.push(classifyFile(ctx, rel));
	}
	for (const finding of inputs.deadExports) {
		for (const symbol of symbolsFromDetail(finding.detail)) {
			items.push(classifyExport(ctx, finding, symbol));
		}
	}
	return { items, inertBranches: readInertBranches(cwd) };
}

const BUCKET_ORDER: readonly DeadCodeBucket[] = [
	"future-scaffolding",
	"deliberate-seam",
	"reexport-residue",
	"orphaned-type",
	"superseded",
	"ambiguous",
];

/** Human-readable section list for the CLI action. (Deliberate public API:
 *  consumed via dynamic import in deadcode.ts — invisible to static
 *  dead-export analysis, which is this module's own documented FP class.) */
export function formatCategorizeReport(report: CategorizeReport): string[] {
	const lines: string[] = [];
	for (const bucket of BUCKET_ORDER) {
		const rows = report.items.filter((i) => i.bucket === bucket);
		if (rows.length === 0) continue;
		const rec = rows[0]?.recommendation ?? "review";
		lines.push(`\n${bucket} (${rows.length}) — recommendation: ${rec}`);
		for (const r of rows.slice(0, 25)) {
			lines.push(`  ${r.file}${r.symbol ? `: ${r.symbol}` : ""}`);
		}
		if (rows.length > 25) lines.push(`  … +${rows.length - 25} more (use --json)`);
	}
	if (report.inertBranches.length > 0) {
		lines.push(
			`\ninert branches (${report.inertBranches.length} functions, mutation-adjudicated) — recommendation: delete the dead branch`,
		);
		for (const b of report.inertBranches) {
			lines.push(`  ${b.file}: ${b.qualifiedName} (${b.records} record(s))`);
		}
	}
	return lines;
}
