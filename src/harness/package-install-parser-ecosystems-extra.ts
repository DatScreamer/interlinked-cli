// interlinked-tdd: exempt
// Composer / NuGet / Maven install-command parsers extracted from
// package-install-parser-ecosystems.ts for the per-file line cap.
//
// Imports ONLY from package-install-parser-shared.ts — no imports from
// package-install-parser-ecosystems.ts, so the dependency graph stays acyclic:
//   shared ← ecosystems-extra ← ecosystems ← package-install-parser (main)
//
// Re-exported from package-install-parser-ecosystems.ts so existing importers
// are unchanged.

import type {
	InstallCommand,
	PackageSpec,
} from "./package-install-parser-shared.js";

import { envRegistryFor } from "./package-install-parser-shared.js";

// ---------------------------------------------------------------------------
// Composer (PHP / Packagist)
// ---------------------------------------------------------------------------

/** `composer require vendor/pkg[:constraint]` adds; `install`/`update` sync
 *  from composer.json/composer.lock; `remove` is a no-supply-chain uninstall. */
export function parseComposer(
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	const sub = tokens[1] || "";
	const args = tokens.slice(2);
	// Composer takes the repo as both `--repository <repo>` and `--repository=<repo>`;
	// matching only the bare token let `--repository=<custom>` slip through as a
	// default-registry install and bypass the custom-registry block (finding 2026-06).
	const customRegistry = args.some((a) => a === "--repository" || a.startsWith("--repository="))
		? "custom"
		: envRegistryFor("composer", envVars);
	if (sub === "remove") {
		return {
			ecosystem: "composer",
			manager: "composer",
			action: "remove",
			packages: [],
			fromLockfile: false,
			fromManifest: false,
			notes: [],
		};
	}
	if (sub === "install" || sub === "update") {
		return {
			ecosystem: "composer",
			manager: "composer",
			action: "sync",
			packages: [],
			fromLockfile: sub === "install",
			fromManifest: true,
			customRegistry,
			notes: [],
		};
	}
	if (sub !== "require") return null;
	const positionals = args.filter((a) => !a.startsWith("-"));
	return {
		ecosystem: "composer",
		manager: "composer",
		action: "add",
		packages: positionals.map((spec) => {
			// `vendor/pkg:constraint` — the `/` is part of the name, the LAST
			// `:` (after the `/`) separates the version constraint.
			const colon = spec.lastIndexOf(":");
			if (colon > spec.indexOf("/")) {
				return {
					kind: "registry" as const,
					name: spec.slice(0, colon),
					version: spec.slice(colon + 1),
				};
			}
			return { kind: "registry" as const, name: spec };
		}),
		fromLockfile: false,
		fromManifest: false,
		customRegistry,
		notes: [],
	};
}

// ---------------------------------------------------------------------------
// NuGet (.NET — `dotnet add package` / `nuget install`)
// ---------------------------------------------------------------------------

/** Read a `--flag value` / `--flag=value` argument (case-insensitive flag). */
function readFlagValue(args: string[], ...flags: string[]): string | undefined {
	const lower = flags.map((f) => f.toLowerCase());
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const eq = a.indexOf("=");
		if (eq > 0 && lower.includes(a.slice(0, eq).toLowerCase())) return a.slice(eq + 1);
		if (lower.includes(a.toLowerCase()) && args[i + 1] && !args[i + 1].startsWith("-")) {
			return args[i + 1];
		}
	}
	return undefined;
}

/** `dotnet add [<proj>] package <Name> [--version <V>]` and
 *  `nuget install <Name> [-Version <V>]` add; `restore` syncs from manifest. */
export function parseNuget(
	bin: string,
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	const args = tokens.slice(1);
	// `nuget install` uses the single-dash `-Source <url>` flag (PowerShell style);
	// dotnet uses `--source`/`-s`. readFlagValue is case-insensitive, so listing
	// `-source` catches `-Source`/`-SOURCE`. Missing it let `nuget install <pkg>
	// -Source <custom>` read as a default-registry install, bypassing the block.
	const customRegistry =
		readFlagValue(args, "--source", "-source", "-s") ?? envRegistryFor("nuget", envVars);
	const sync = (fromLockfile: boolean): InstallCommand => ({
		ecosystem: "nuget",
		manager: bin,
		action: "sync",
		packages: [],
		fromLockfile,
		fromManifest: true,
		customRegistry,
		notes: [],
	});
	const add = (name: string, version: string | undefined): InstallCommand => ({
		ecosystem: "nuget",
		manager: bin,
		action: "add",
		packages: [{ kind: "registry", name, ...(version ? { version } : {}) }],
		fromLockfile: false,
		fromManifest: false,
		customRegistry,
		notes: [],
	});

	if (bin === "dotnet") {
		if (args[0] === "restore") return sync(true);
		if (args[0] !== "add") return null;
		const pkgIdx = args.indexOf("package");
		if (pkgIdx < 0) return null;
		const rest = args.slice(pkgIdx + 1);
		const name = rest.find((a) => !a.startsWith("-"));
		if (!name) return null;
		return add(name, readFlagValue(rest, "--version", "-v"));
	}
	// nuget
	if (args[0] === "restore") return sync(true);
	if (args[0] !== "install") return null;
	const name = args.slice(1).find((a) => !a.startsWith("-"));
	if (!name) return null;
	return add(name, readFlagValue(args, "-version", "--version"));
}

// ---------------------------------------------------------------------------
// Maven (`mvn dependency:get -Dartifact=group:artifact:version`)
// ---------------------------------------------------------------------------

/** Maven adds dependencies declaratively (pom.xml). The one package-fetching
 *  CLI form is `mvn dependency:get -Dartifact=g:a:v`; anything else (build
 *  lifecycle goals) is not a registry install and returns null. */
export function parseMaven(
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	const args = tokens.slice(1);
	if (!args.includes("dependency:get")) return null;
	const dart = args.find((a) => a.startsWith("-Dartifact="));
	const packages: PackageSpec[] = [];
	if (dart) {
		const parts = dart.slice("-Dartifact=".length).split(":");
		if (parts.length >= 3) {
			packages.push({ kind: "registry", name: `${parts[0]}:${parts[1]}`, version: parts[2] });
		} else if (parts.length === 2) {
			packages.push({ kind: "registry", name: `${parts[0]}:${parts[1]}` });
		}
	}
	// `mvn dependency:get` can fetch from an ARBITRARY repository via a
	// repo-pointing system property — `-DremoteRepositories=<url>` (the current
	// flag) or the legacy `-DrepositoryUrl=` / `-DrepoUrl=`. Left undetected, the
	// fetch reads as a default-registry install and slips past the custom-registry
	// block that every other manager enforces: an allowlisted, exactly-pinned
	// coordinate would still be pulled from the attacker's repo, bypassing the
	// upstream signing model (finding 2026-06). Any such flag ⇒ treat as a custom
	// registry, exactly as `--repository` does for Composer and `-Source` for NuGet.
	const repoOverride = args.some(
		(a) =>
			a.startsWith("-DremoteRepositories=") ||
			a.startsWith("-DrepositoryUrl=") ||
			a.startsWith("-DrepoUrl="),
	);
	return {
		ecosystem: "maven",
		manager: "mvn",
		action: "add",
		packages,
		fromLockfile: false,
		fromManifest: false,
		customRegistry: repoOverride ? "custom" : envRegistryFor("maven", envVars),
		notes: [],
	};
}
