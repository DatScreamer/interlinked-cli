// ===========================================
// interlinked allowlist — manage the supply-chain allowlist
// ===========================================
// Subcommands:
//   add <ecosystem> <package>      — approve a single package
//   remove <ecosystem> <package>   — un-approve
//   list                           — show all approved entries
//   snapshot                       — hash manifest + lockfile state, store
//   verify                         — diff manifest deps vs allowlist
//
// The allowlist lives at `.interlinked/package-allowlist.json` (committed).
// Edit only via this CLI or via PR; agents are blocked from running these
// add/remove operations because they target an `interlinked` subcommand
// path that flips the file's authority bit.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findTyposquatMatch } from "../harness/checks/supply-chain.js";
import {
	extractCargoDeps,
	extractGemfileDeps,
	extractGoModDeps,
	extractPyprojectDeps,
	parsePipRequirementLine,
} from "../harness/evaluator/manifest-edit-guard.js";
import {
	addToAllowlist,
	type Allowlist,
	hashLockfile,
	isPackageAllowed,
	loadAllowlist,
	saveAllowlist,
} from "../harness/package-allowlist.js";
import type { Ecosystem } from "../harness/package-install-parser.js";

const ECOSYSTEMS: readonly Ecosystem[] = ["npm", "pypi", "cargo", "rubygems", "go"];

function isEcosystem(s: string): s is Ecosystem {
	return (ECOSYSTEMS as readonly string[]).includes(s);
}

interface AddOpts {
	cwd: string;
	by: string;
	reason?: string;
	versionRange?: string;
}

export function addAllowlistCommand(
	ecosystem: Ecosystem | string,
	pkg: string,
	opts: AddOpts & { force?: boolean },
): void {
	if (!isEcosystem(ecosystem)) {
		throw new Error(
			`Unknown ecosystem "${ecosystem}". Valid: ${ECOSYSTEMS.join(", ")}`,
		);
	}
	// Typosquat gate. The most catastrophic failure mode is APPROVING a
	// typosquat by mistake (after which install proceeds silently). Refuse
	// the add unless the caller passes --force.
	if (ecosystem === "npm") {
		const match = findTyposquatMatch(pkg);
		if (match && !opts.force) {
			throw new Error(
				`refusing to approve "${pkg}" — Levenshtein distance ${match.distance} from popular package "${match.popular}". If this is intentional, re-run with --force.`,
			);
		}
	}
	addToAllowlist(opts.cwd, ecosystem, pkg, {
		approved_by: opts.by,
		reason: opts.reason,
		version_range: opts.versionRange,
	});
	process.stdout.write(`approved: ${ecosystem}:${pkg} (by ${opts.by})\n`);
}

interface RemoveOpts {
	cwd: string;
}

export function removeAllowlistCommand(
	ecosystem: Ecosystem | string,
	pkg: string,
	opts: RemoveOpts,
): void {
	if (!isEcosystem(ecosystem)) {
		throw new Error(
			`Unknown ecosystem "${ecosystem}". Valid: ${ECOSYSTEMS.join(", ")}`,
		);
	}
	const al = loadAllowlist(opts.cwd);
	if (!al.packages[ecosystem][pkg]) {
		process.stdout.write(`no entry: ${ecosystem}:${pkg}\n`);
		return;
	}
	delete al.packages[ecosystem][pkg];
	saveAllowlist(opts.cwd, al);
	process.stdout.write(`removed: ${ecosystem}:${pkg}\n`);
}

interface ListOpts {
	cwd: string;
	ecosystem?: string;
	json?: boolean;
}

export function listAllowlistCommand(opts: ListOpts): void {
	const al = loadAllowlist(opts.cwd);
	const filtered: Allowlist = opts.ecosystem
		? {
				...al,
				packages: Object.fromEntries(
					ECOSYSTEMS.map((e) => [
						e,
						e === opts.ecosystem ? al.packages[e] : {},
					]),
				) as Allowlist["packages"],
			}
		: al;
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
		return;
	}
	const totals = ECOSYSTEMS.reduce(
		(n, e) => n + Object.keys(filtered.packages[e]).length,
		0,
	);
	if (totals === 0 && Object.keys(filtered.lockfile_snapshots).length === 0) {
		process.stdout.write("allowlist is empty — no entries approved\n");
		return;
	}
	for (const e of ECOSYSTEMS) {
		const entries = Object.entries(filtered.packages[e]);
		if (entries.length === 0) continue;
		process.stdout.write(`${e}:\n`);
		for (const [name, meta] of entries) {
			process.stdout.write(
				`  ${name}  (by ${meta.approved_by}${meta.reason ? `, ${meta.reason}` : ""})\n`,
			);
		}
	}
	const snaps = Object.entries(filtered.lockfile_snapshots);
	if (snaps.length > 0) {
		process.stdout.write("snapshots:\n");
		for (const [file, meta] of snaps) {
			process.stdout.write(`  ${file}  ${meta.sha256.slice(0, 12)}…  (by ${meta.approved_by})\n`);
		}
	}
}

interface SnapshotOpts {
	cwd: string;
	by: string;
	reason?: string;
	lockfile?: string;
}

const SNAPSHOT_CANDIDATES = [
	"package.json",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lockb",
	"requirements.txt",
	"requirements.lock",
	"Pipfile",
	"Pipfile.lock",
	"pyproject.toml",
	"poetry.lock",
	"uv.lock",
	"pdm.lock",
	"Cargo.toml",
	"Cargo.lock",
	"Gemfile",
	"Gemfile.lock",
	"go.mod",
	"go.sum",
] as const;

export function snapshotAllowlistCommand(opts: SnapshotOpts): void {
	const al = loadAllowlist(opts.cwd);
	const candidates = opts.lockfile ? [opts.lockfile] : SNAPSHOT_CANDIDATES;
	const taken: string[] = [];
	for (const name of candidates) {
		const p = join(opts.cwd, name);
		if (!existsSync(p)) continue;
		try {
			if (!statSync(p).isFile()) continue;
		} catch {
			continue;
		}
		const sha = hashLockfile(p);
		if (!sha) continue;
		al.lockfile_snapshots[name] = {
			sha256: sha,
			approved_at: new Date().toISOString(),
			approved_by: opts.by,
			reason: opts.reason,
		};
		taken.push(name);
	}
	if (taken.length === 0) {
		process.stdout.write(
			"no manifest/lockfile found to snapshot in this directory\n",
		);
		return;
	}
	saveAllowlist(opts.cwd, al);
	process.stdout.write(`snapshotted ${taken.length} file(s):\n`);
	for (const name of taken) process.stdout.write(`  ${name}\n`);
}

interface VerifyOpts {
	cwd: string;
}

export function verifyAllowlistCommand(opts: VerifyOpts): void {
	const al = loadAllowlist(opts.cwd);
	const issues: string[] = [];
	checkPackageJson(opts.cwd, al, issues);
	checkRequirementsTxt(opts.cwd, al, issues);
	checkPyprojectToml(opts.cwd, al, issues);
	checkCargoToml(opts.cwd, al, issues);
	checkGemfile(opts.cwd, al, issues);
	checkGoMod(opts.cwd, al, issues);
	if (issues.length === 0) {
		process.stdout.write("all approved — manifest deps clean\n");
		return;
	}
	process.stdout.write(`${issues.length} unapproved dep(s):\n`);
	for (const issue of issues) process.stdout.write(`${issue}\n`);
}

function readIfPresent(path: string): string | null {
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function reportUnapproved(
	al: Allowlist,
	ecosystem: Ecosystem,
	name: string,
	issues: string[],
): void {
	const decision = isPackageAllowed(al, ecosystem, { kind: "registry", name });
	if (!decision.allowed) {
		issues.push(`  ${ecosystem}:${name} — ${decision.reason ?? "unapproved"}`);
	}
}

function checkPackageJson(cwd: string, al: Allowlist, issues: string[]): void {
	const content = readIfPresent(join(cwd, "package.json"));
	if (content === null) return;
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(content) as Record<string, unknown>;
	} catch {
		issues.push(`  could not parse package.json (JSON error)`);
		return;
	}
	for (const field of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
	]) {
		const m = parsed[field];
		if (!m || typeof m !== "object") continue;
		for (const name of Object.keys(m as Record<string, unknown>)) {
			reportUnapproved(al, "npm", name, issues);
		}
	}
}

function checkRequirementsTxt(cwd: string, al: Allowlist, issues: string[]): void {
	const content = readIfPresent(join(cwd, "requirements.txt"));
	if (content === null) return;
	for (const line of content.split(/\r?\n/)) {
		const parsed = parsePipRequirementLine(line);
		if (parsed) reportUnapproved(al, "pypi", parsed.name, issues);
	}
}

interface ExtractorSpec {
	file: string;
	ecosystem: Ecosystem;
	extract: (content: string) => Map<string, string>;
}

const EXTRACTORS: readonly ExtractorSpec[] = [
	{ file: "pyproject.toml", ecosystem: "pypi", extract: extractPyprojectDeps },
	{ file: "Cargo.toml", ecosystem: "cargo", extract: extractCargoDeps },
	{ file: "Gemfile", ecosystem: "rubygems", extract: extractGemfileDeps },
	{ file: "go.mod", ecosystem: "go", extract: extractGoModDeps },
];

function checkPyprojectToml(cwd: string, al: Allowlist, issues: string[]): void {
	checkExtracted(cwd, al, issues, EXTRACTORS[0]);
}
function checkCargoToml(cwd: string, al: Allowlist, issues: string[]): void {
	checkExtracted(cwd, al, issues, EXTRACTORS[1]);
}
function checkGemfile(cwd: string, al: Allowlist, issues: string[]): void {
	checkExtracted(cwd, al, issues, EXTRACTORS[2]);
}
function checkGoMod(cwd: string, al: Allowlist, issues: string[]): void {
	checkExtracted(cwd, al, issues, EXTRACTORS[3]);
}

function checkExtracted(
	cwd: string,
	al: Allowlist,
	issues: string[],
	spec: ExtractorSpec,
): void {
	const content = readIfPresent(join(cwd, spec.file));
	if (content === null) return;
	for (const name of spec.extract(content).keys()) {
		reportUnapproved(al, spec.ecosystem, name, issues);
	}
}
