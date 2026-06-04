// Shared types and pure helpers for the package-install-parser family.
// No imports from package-install-parser.ts or package-install-parser-ecosystems.ts.
// Both of those files import from here — dependency flows one way only.
//
// Pure functions only: no fs, no env, no module-scope side effects.

// ---------------------------------------------------------------------------
// Public types (re-exported from package-install-parser.ts for back-compat)
// ---------------------------------------------------------------------------

export type Ecosystem = "npm" | "pypi" | "cargo" | "rubygems" | "go";

export type InstallAction =
	| "add"
	| "sync"
	| "install_global"
	| "remove"
	| "noop";

export type PackageSpec =
	| { kind: "registry"; name: string; version?: string | undefined }
	| { kind: "git_url"; url: string }
	| { kind: "tarball_url"; url: string }
	| { kind: "local_path"; path: string }
	| { kind: "file_url"; path: string };

export interface InstallCommand {
	ecosystem: Ecosystem;
	manager: string;
	action: InstallAction;
	packages: PackageSpec[];
	fromLockfile: boolean;
	fromManifest: boolean;
	manifestFile?: string | undefined;
	customRegistry?: string | undefined;
	notes: string[];
	/** Relative-or-absolute cwd this command runs in, when shifted from
	 *  the script's cwd by a preceding `cd <path>` segment in the same
	 *  compound shell line. Resolved against the harness event's cwd. */
	effectiveCwd?: string;
}

// ---------------------------------------------------------------------------
// Registry env-var helpers
// ---------------------------------------------------------------------------

/** Map of recognized package-registry env vars per ecosystem. */
export const ENV_REGISTRY_KEYS: Record<Ecosystem, readonly string[]> = {
	npm: [
		"NPM_CONFIG_REGISTRY",
		"npm_config_registry",
		"YARN_REGISTRY",
		"BUN_CONFIG_REGISTRY",
	],
	pypi: [
		"PIP_INDEX_URL",
		"PIP_EXTRA_INDEX_URL",
		"UV_INDEX_URL",
		"UV_EXTRA_INDEX_URL",
		"POETRY_HTTP_BASIC_DEFAULT_URL",
	],
	cargo: [],
	rubygems: ["GEM_SOURCE"],
	go: ["GOPROXY"],
};

const CARGO_REGISTRY_RE = /^CARGO_REGISTRIES_[A-Z0-9_]+_INDEX$/;

export function envRegistryFor(
	ecosystem: Ecosystem,
	envVars: Record<string, string>,
): string | undefined {
	for (const key of ENV_REGISTRY_KEYS[ecosystem]) {
		if (envVars[key]) return envVars[key];
	}
	if (ecosystem === "cargo") {
		for (const [k, v] of Object.entries(envVars)) {
			if (CARGO_REGISTRY_RE.test(k)) return v;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Pre-verb flag dropper (used by npm-like parser)
// ---------------------------------------------------------------------------

/** Drop pre-verb flags (and their values) until we land on the first
 *  argument-shaped token. Used to handle `npm --prefix app install evil`,
 *  `pnpm --filter app add evil`, `yarn workspace app add evil`.
 *
 *  Heuristic: any `--flag` consumes itself; any `--flag=val` consumes
 *  itself; any `--flag VAL` where VAL doesn't start with `-` consumes
 *  both. `yarn workspace <name>` is a documented pre-verb shape — handled
 *  as a special case. */
export function dropPreVerbFlags(
	bin: string,
	args: string[],
	verbRecognizer: (s: string) => boolean,
): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < args.length) {
		const a = args[i];
		if (verbRecognizer(a)) {
			out.push(...args.slice(i));
			return out;
		}
		if (a.startsWith("--") && a.includes("=")) {
			i++;
			continue;
		}
		if (a.startsWith("-")) {
			// Looks-like-takes-value: next token is non-flag → consume pair
			const next = args[i + 1];
			if (next && !next.startsWith("-") && !verbRecognizer(next)) {
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		// Yarn-only: `yarn workspace <name> <subverb>` — eat the workspace name
		if (bin === "yarn" && a === "workspace" && args[i + 1] && !verbRecognizer(args[i + 1])) {
			i += 2;
			continue;
		}
		// Yarn `workspaces` (plural) — followed by `foreach` / `info` / etc., not a verb
		// We bail and let the parent fail, since these aren't installs.
		if (bin === "yarn" && a === "workspaces") return [];
		break;
	}
	return out;
}
