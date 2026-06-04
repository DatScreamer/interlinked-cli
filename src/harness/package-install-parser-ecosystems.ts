// Per-ecosystem install-command parsers extracted from package-install-parser.ts.
// Import from package-install-parser.ts, not directly from here.
//
// Imports ONLY from package-install-parser-shared.ts — no imports from
// package-install-parser.ts, so the dependency graph is acyclic:
//   shared ← ecosystems ← package-install-parser (main)

import type {
	Ecosystem,
	InstallAction,
	InstallCommand,
	PackageSpec,
} from "./package-install-parser-shared.js";

import {
	dropPreVerbFlags,
	envRegistryFor,
} from "./package-install-parser-shared.js";

// ===========================================================
// npm / pnpm / yarn / bun
// ===========================================================
const NPM_ADD_VERBS = new Set(["install", "i", "add", "isntall"]);
const NPM_SYNC_VERBS = new Set(["ci"]);
const NPM_REMOVE_VERBS = new Set([
	"uninstall",
	"remove",
	"rm",
	"un",
	"unlink",
]);

export function isNpmVerb(s: string): boolean {
	return NPM_ADD_VERBS.has(s) || NPM_SYNC_VERBS.has(s) || NPM_REMOVE_VERBS.has(s);
}

export function parseNpmLike(
	bin: string,
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	// Drop pre-verb flags ("npm --prefix app install …") so the verb is at [0].
	const trailing = dropPreVerbFlags(bin, tokens.slice(1), isNpmVerb);
	const sub = trailing[0] || "";
	const args = trailing.slice(1);

	let action: InstallAction;
	// `yarn` with no args at all == `yarn install`. We require ZERO args (not
	// "trailing produced nothing") because the latter happens when the user
	// invoked a non-install yarn subcommand whose verb we don't recognize —
	// e.g. `yarn workspaces foreach run build`. Treating that as `yarn install`
	// would be a false positive.
	if (bin === "yarn" && tokens.length === 1) {
		action = "sync";
	} else if (NPM_SYNC_VERBS.has(sub)) {
		action = "sync";
	} else if (NPM_ADD_VERBS.has(sub)) {
		action = "add";
	} else if (NPM_REMOVE_VERBS.has(sub)) {
		action = "remove";
	} else {
		return null;
	}

	const positionals: string[] = [];
	let customRegistry: string | undefined;
	let frozenLockfile = false;
	const notes: string[] = [];
	const FLAG_TAKES_VALUE = new Set([
		"--prefix",
		"--cache",
		"--user-agent",
		"--workspace",
		"-w",
		"--save-prefix",
	]);

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--registry" || a === "--registry-url") {
			customRegistry = args[i + 1];
			i++;
			continue;
		}
		const m = a.match(/^--(?:registry|registry-url)=(.+)$/);
		if (m) {
			customRegistry = m[1];
			continue;
		}
		if (
			a === "--frozen-lockfile" ||
			a === "--frozen" ||
			a === "--prefer-offline" ||
			a === "--immutable" ||
			a === "--no-update"
		) {
			frozenLockfile = true;
			continue;
		}
		if (a.startsWith("-")) {
			if (FLAG_TAKES_VALUE.has(a) && /^[^-]/.test(args[i + 1] || "")) i++;
			continue;
		}
		positionals.push(a);
	}

	// Env-var registry override only fires when no inline --registry was given.
	if (!customRegistry) customRegistry = envRegistryFor("npm", envVars);

	if (action === "add" && positionals.length === 0) {
		return {
			ecosystem: "npm",
			manager: bin,
			action: "sync",
			packages: [],
			fromLockfile: frozenLockfile,
			fromManifest: true,
			customRegistry,
			notes,
		};
	}

	const fromLockfile =
		action === "sync" &&
		(bin === "npm" || frozenLockfile || (bin === "pnpm" && positionals.length === 0));
	const fromManifest = action === "sync" && positionals.length === 0;

	const packages: PackageSpec[] = positionals.map(classifyNpmSpec);
	if (action === "sync" && positionals.length > 0) {
		notes.push(`unexpected positional args to ${bin} ${sub}`);
	}

	return {
		ecosystem: "npm",
		manager: bin,
		action,
		packages,
		fromLockfile,
		fromManifest,
		customRegistry,
		notes,
	};
}

function classifyNpmSpec(spec: string): PackageSpec {
	if (/^https?:\/\/.+\.(tgz|tar\.gz|zip)(?:[?#].*)?$/i.test(spec))
		return { kind: "tarball_url", url: spec };
	if (
		/^(git\+(https?|ssh|file):|github:|gitlab:|bitbucket:|gist:)/.test(spec) ||
		/^https?:\/\/.+\.git(?:#.+)?$/.test(spec)
	)
		return { kind: "git_url", url: spec };
	if (spec.startsWith("file:")) return { kind: "file_url", path: spec.slice(5) };
	if (
		spec.startsWith("./") ||
		spec.startsWith("../") ||
		spec.startsWith("/") ||
		spec.startsWith("~/")
	)
		return { kind: "local_path", path: spec };
	if (spec.startsWith("@")) {
		const slash = spec.indexOf("/");
		if (slash > 0) {
			const rest = spec.slice(slash + 1);
			const at = rest.indexOf("@");
			if (at < 0) return { kind: "registry", name: spec };
			return {
				kind: "registry",
				name: spec.slice(0, slash + 1 + at),
				version: rest.slice(at + 1),
			};
		}
		return { kind: "registry", name: spec };
	}
	const at = spec.indexOf("@");
	if (at > 0)
		return { kind: "registry", name: spec.slice(0, at), version: spec.slice(at + 1) };
	return { kind: "registry", name: spec };
}

// ===========================================================
// pip / pip3 / pipx
// ===========================================================
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
	const positionals: string[] = [];
	let customRegistry: string | undefined;
	let manifestFile: string | undefined;
	let fromConstraints = false;

	// `-e` / `--editable` is intentionally NOT here — its value IS the spec,
	// and dropping that value would let `pip install -e git+URL` slip past the
	// guard. We handle the next token as a positional spec below.
	const FLAG_TAKES_VALUE = new Set([
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

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--index-url" || a === "-i" || a === "--extra-index-url") {
			customRegistry = args[i + 1];
			i++;
			continue;
		}
		const m = a.match(/^(?:--index-url|--extra-index-url|-i)=(.+)$/);
		if (m) {
			customRegistry = m[1];
			continue;
		}
		if (a === "-r" || a === "--requirement") {
			manifestFile = args[i + 1];
			i++;
			continue;
		}
		const mr = a.match(/^--requirement=(.+)$/);
		if (mr) {
			manifestFile = mr[1];
			continue;
		}
		if (a === "-c" || a === "--constraint") {
			fromConstraints = true;
			i++;
			continue;
		}
		// Editable: -e <spec> / --editable <spec> — the following token is the package.
		if (a === "-e" || a === "--editable") {
			const next = args[i + 1];
			if (next && !next.startsWith("-")) {
				positionals.push(next);
				i++;
			}
			continue;
		}
		const meq = a.match(/^--editable=(.+)$/);
		if (meq) {
			positionals.push(meq[1]);
			continue;
		}
		if (a.startsWith("-")) {
			if (FLAG_TAKES_VALUE.has(a) && /^[^-]/.test(args[i + 1] || "")) i++;
			continue;
		}
		positionals.push(a);
	}

	if (!customRegistry) customRegistry = envRegistryFor("pypi", envVars);

	const packages: PackageSpec[] = positionals.map(classifyPipSpec);
	let action: InstallAction = positionals.length > 0 ? "add" : "sync";
	const fromManifest = !!manifestFile || (positionals.length === 0 && !fromConstraints);
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
	const name = nameMatch ? nameMatch[1] : spec;
	const versionMatch = spec.match(/(?:==|>=|<=|~=|!=|>|<)\s*([A-Za-z0-9._+-]+)/);
	return {
		kind: "registry",
		name,
		version: versionMatch ? versionMatch[1] : undefined,
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
			if (a.startsWith("-")) continue;
			positionals.push(a);
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

// ===========================================================
// cargo
// ===========================================================
export function parseCargo(
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
			if (a === "--registry") {
				customRegistry = args[i + 1];
				i++;
				continue;
			}
			if (a === "--git") {
				positionals.push(`git+${args[i + 1]}`);
				i++;
				continue;
			}
			if (a.startsWith("-")) continue;
			positionals.push(a);
		}
		if (!customRegistry) customRegistry = envRegistryFor("cargo", envVars);
		return {
			ecosystem: "cargo",
			manager: "cargo",
			action: "add",
			packages: positionals.map(classifyCargoSpec),
			fromLockfile: false,
			fromManifest: false,
			customRegistry,
			notes: [],
		};
	}
	if (sub === "install") {
		const positionals = args.filter((a) => !a.startsWith("-"));
		return {
			ecosystem: "cargo",
			manager: "cargo",
			action: "install_global",
			packages: positionals.map(classifyCargoSpec),
			fromLockfile: false,
			fromManifest: false,
			customRegistry: envRegistryFor("cargo", envVars),
			notes: [],
		};
	}
	if (sub === "build" || sub === "test" || sub === "run" || sub === "check") {
		const fromLockfile = args.includes("--locked") || args.includes("--frozen");
		return {
			ecosystem: "cargo",
			manager: "cargo",
			action: "sync",
			packages: [],
			fromLockfile,
			fromManifest: true,
			manifestFile: "Cargo.toml",
			customRegistry: envRegistryFor("cargo", envVars),
			notes: [],
		};
	}
	return null;
}

function classifyCargoSpec(spec: string): PackageSpec {
	if (spec.startsWith("git+")) return { kind: "git_url", url: spec.slice(4) };
	if (
		spec.startsWith("./") ||
		spec.startsWith("../") ||
		spec.startsWith("/") ||
		spec === "."
	)
		return { kind: "local_path", path: spec };
	const nameMatch = spec.match(/^([A-Za-z0-9._-]+)/);
	return { kind: "registry", name: nameMatch ? nameMatch[1] : spec };
}

// ===========================================================
// gem / bundle
// ===========================================================
export function parseGem(
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	const sub = tokens[1] || "";
	const args = tokens.slice(2);
	if (sub !== "install") return null;
	const positionals: string[] = [];
	let customRegistry: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--source" || a === "-s" || a === "--add-source") {
			customRegistry = args[i + 1];
			i++;
			continue;
		}
		if (a.startsWith("-")) continue;
		positionals.push(a);
	}
	if (!customRegistry) customRegistry = envRegistryFor("rubygems", envVars);
	return {
		ecosystem: "rubygems",
		manager: "gem",
		action: "install_global",
		packages: positionals.map((p) => ({ kind: "registry" as const, name: p })),
		fromLockfile: false,
		fromManifest: false,
		customRegistry,
		notes: [],
	};
}

export function parseBundle(
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	const sub = tokens[1] || "";
	const args = tokens.slice(2);
	if (sub === "install") {
		const fromLockfile = args.includes("--frozen") || args.includes("--deployment");
		return {
			ecosystem: "rubygems",
			manager: "bundle",
			action: "sync",
			packages: [],
			fromLockfile,
			fromManifest: true,
			manifestFile: "Gemfile",
			customRegistry: envRegistryFor("rubygems", envVars),
			notes: [],
		};
	}
	if (sub === "add") {
		const positionals = args.filter((a) => !a.startsWith("-"));
		return {
			ecosystem: "rubygems",
			manager: "bundle",
			action: "add",
			packages: positionals.map((p) => ({ kind: "registry" as const, name: p })),
			fromLockfile: false,
			fromManifest: false,
			customRegistry: envRegistryFor("rubygems", envVars),
			notes: [],
		};
	}
	return null;
}

// ===========================================================
// go get / go install
// ===========================================================
export function parseGo(
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	const sub = tokens[1] || "";
	const args = tokens.slice(2);
	if (sub !== "get" && sub !== "install") return null;
	const positionals = args.filter((a) => !a.startsWith("-"));
	const action: InstallAction = sub === "install" ? "install_global" : "add";
	return {
		ecosystem: "go",
		manager: "go",
		action,
		packages: positionals.map((p) => {
			const at = p.lastIndexOf("@");
			if (at > 0)
				return {
					kind: "registry" as const,
					name: p.slice(0, at),
					version: p.slice(at + 1),
				};
			return { kind: "registry" as const, name: p };
		}),
		fromLockfile: false,
		fromManifest: false,
		customRegistry: envRegistryFor("go", envVars),
		notes: [],
	};
}
