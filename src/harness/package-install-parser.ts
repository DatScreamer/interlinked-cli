// Parse package-install shell commands into a structured form so the
// supply-chain guard can apply the allowlist.
//
// Pure function — no fs, no env, no module-scope deps. The same parser is
// used by the daemon (PreToolUse evaluator) and the inline cold-fallback
// (`Function.toString()` splice in package-install-inline-guard).
//
// Coverage: npm/pnpm/yarn/bun + pip/pip3/pipx/poetry/uv + cargo + gem/bundle
// + go. Recognizes registry installs (named packages), git+url installs,
// tarball-url installs, local-path installs, and file: installs separately
// — they have different risk profiles.

export type Ecosystem = "npm" | "pypi" | "cargo" | "rubygems" | "go";

export type InstallAction =
	| "add"
	| "sync"
	| "install_global"
	| "remove"
	| "noop";

export type PackageSpec =
	| { kind: "registry"; name: string; version?: string }
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
	manifestFile?: string;
	customRegistry?: string;
	notes: string[];
	/** Relative-or-absolute cwd this command runs in, when shifted from
	 *  the script's cwd by a preceding `cd <path>` segment in the same
	 *  compound shell line. Resolved against the harness event's cwd. */
	effectiveCwd?: string;
}

const NPM_LIKE = new Set(["npm", "pnpm", "yarn", "bun"]);

export function parseInstallCommands(rawCommand: string): InstallCommand[] {
	if (!rawCommand || typeof rawCommand !== "string") return [];
	const segments = splitShellSegments(rawCommand);
	const results: InstallCommand[] = [];
	// Track cwd shifts from preceding `cd <path>` segments in the same
	// compound shell line. Path-joining is purely lexical here — we don't
	// resolve symlinks or `..` because we don't know the script's actual
	// cwd at parse time; the guard layer applies the join against the
	// event's cwd.
	let cwdShift: string | undefined;
	for (const seg of segments) {
		const cdTarget = parseCdSegment(seg);
		if (cdTarget !== null) {
			cwdShift = composeCwd(cwdShift, cdTarget);
			continue;
		}
		const parsed = parseOneSegment(seg);
		if (parsed) {
			if (cwdShift) parsed.effectiveCwd = cwdShift;
			results.push(parsed);
		}
	}
	return results;
}

/** Detect a bare `cd <path>` segment. Returns the path argument, or null
 *  if the segment isn't a cd. We deliberately don't honor `cd -` or `cd`
 *  with no argument (those go HOME / OLDPWD — the script's cwd is the
 *  baseline we can't statically know). */
function parseCdSegment(seg: string): string | null {
	const t = stripRedirections(tokenize(seg));
	const stripped = stripWrappers(t).tokens;
	if (stripped.length < 2) return null;
	if (stripped[0] !== "cd") return null;
	let i = 1;
	while (i < stripped.length && stripped[i].startsWith("-")) i++;
	const target = stripped[i];
	if (!target) return null;
	return target;
}

/** Lexical cwd composition. Absolute `next` resets; relative joins. */
function composeCwd(prev: string | undefined, next: string): string {
	if (next.startsWith("/") || next.startsWith("~")) return next;
	if (!prev) return next;
	return `${prev}/${next}`;
}

export function splitShellSegments(s: string): string[] {
	const out: string[] = [];
	let buf = "";
	let q: string | null = null;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (q) {
			buf += ch;
			if (ch === q && s[i - 1] !== "\\") q = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			q = ch;
			buf += ch;
			continue;
		}
		if (ch === ";") {
			out.push(buf);
			buf = "";
			continue;
		}
		if (ch === "&" && s[i + 1] === "&") {
			out.push(buf);
			buf = "";
			i++;
			continue;
		}
		if (ch === "|" && s[i + 1] === "|") {
			out.push(buf);
			buf = "";
			i++;
			continue;
		}
		if (ch === "|") {
			out.push(buf);
			buf = "";
			continue;
		}
		if (ch === "&") {
			out.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (buf) out.push(buf);
	return out.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Strip shell-redirection tokens. Bash treats `2>&1`, `>file`, `<<EOF`, etc.
 *  as redirection metadata, not command arguments — but our tokenizer only
 *  splits on whitespace, so they appear in the token list and get mistaken
 *  for positional package specs (bug: `npm install pkg 2>&1 | tail` parsed
 *  `2>&1` as a package, blocking the install).
 *
 *  Forms handled:
 *  - Pure operators (`>`, `>>`, `<`, `<<`, `<<<`, `<>`, `&>`, `&>>`, `2>`,
 *    etc.) — drop the operator AND the following filename token.
 *  - Operator + FD dup (`2>&1`, `1>&2`) — drop only the token (no separate
 *    filename follows).
 *  - Operator + embedded file (`>file`, `2>file`, `&>file`) — drop only the
 *    token (filename is baked in).
 *  - Process substitution (`<(cmd)`, `>(cmd)`) is NOT stripped here — that
 *    runs a subshell which can matter for guard analysis; left as a future
 *    refinement.
 */
const PURE_REDIR_RE = /^(?:&|\d+)?(?:>>?|<<?<?|<>)$/;
const COMPOUND_REDIR_RE = /^(?:&|\d+)?(?:>>?|<<?<?|<>)\S+$/;

export function stripRedirections(tokens: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (PURE_REDIR_RE.test(t)) {
			i++;
			continue;
		}
		if (COMPOUND_REDIR_RE.test(t)) continue;
		out.push(t);
	}
	return out;
}

function tokenize(seg: string): string[] {
	const out: string[] = [];
	let buf = "";
	let q: string | null = null;
	for (let i = 0; i < seg.length; i++) {
		const ch = seg[i];
		if (q) {
			if (ch === q && seg[i - 1] !== "\\") {
				q = null;
				continue;
			}
			buf += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			q = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (buf) {
				out.push(buf);
				buf = "";
			}
			continue;
		}
		buf += ch;
	}
	if (buf) out.push(buf);
	return out;
}

interface StripResult {
	tokens: string[];
	/** Env vars passed inline before the binary (NPM_CONFIG_REGISTRY=URL, etc.). */
	envVars: Record<string, string>;
}

function stripWrappers(tokens: string[]): StripResult {
	const out = tokens.slice();
	const envVars: Record<string, string> = {};
	const consumeEnvVar = (assignment: string): void => {
		const eq = assignment.indexOf("=");
		if (eq <= 0) return;
		envVars[assignment.slice(0, eq)] = assignment.slice(eq + 1);
	};
	while (out.length) {
		const t = out[0];
		if (
			t === "sudo" ||
			t === "exec" ||
			t === "nohup" ||
			t === "command" ||
			t === "time"
		) {
			out.shift();
			continue;
		}
		if (t === "env") {
			out.shift();
			while (out[0] && /^[A-Za-z_]\w*=/.test(out[0])) {
				const next = out.shift();
				if (next) consumeEnvVar(next);
			}
			continue;
		}
		if (/^[A-Za-z_]\w*=/.test(t)) {
			out.shift();
			consumeEnvVar(t);
			continue;
		}
		break;
	}
	return { tokens: out, envVars };
}

/** Map of recognized package-registry env vars per ecosystem. */
const ENV_REGISTRY_KEYS: Record<Ecosystem, readonly string[]> = {
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

function envRegistryFor(
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

/** Drop pre-verb flags (and their values) until we land on the first
 *  argument-shaped token. Used to handle `npm --prefix app install evil`,
 *  `pnpm --filter app add evil`, `yarn workspace app add evil`.
 *
 *  Heuristic: any `--flag` consumes itself; any `--flag=val` consumes
 *  itself; any `--flag VAL` where VAL doesn't start with `-` consumes
 *  both. `yarn workspace <name>` is a documented pre-verb shape — handled
 *  as a special case. */
function dropPreVerbFlags(
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

function parseOneSegment(seg: string): InstallCommand | null {
	const tokens0 = stripRedirections(tokenize(seg));
	if (tokens0.length === 0) return null;
	const { tokens, envVars } = stripWrappers(tokens0);
	if (tokens.length === 0) return null;
	const bin = basenameNoExt(tokens[0]);

	if (NPM_LIKE.has(bin)) return parseNpmLike(bin, tokens, envVars);
	if (bin === "pip" || bin === "pip3" || bin === "pipx")
		return parsePip(bin, tokens, envVars);
	if (bin === "poetry") return parsePoetry(tokens, envVars);
	if (bin === "uv") return parseUv(tokens, envVars);
	if (bin === "cargo") return parseCargo(tokens, envVars);
	if (bin === "gem") return parseGem(tokens, envVars);
	if (bin === "bundle" || bin === "bundler") return parseBundle(tokens, envVars);
	if (bin === "go") return parseGo(tokens, envVars);
	return null;
}

function basenameNoExt(s: string): string {
	const slash = s.lastIndexOf("/");
	const b = slash >= 0 ? s.slice(slash + 1) : s;
	const dot = b.lastIndexOf(".");
	return dot > 0 ? b.slice(0, dot) : b;
}

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

function isNpmVerb(s: string): boolean {
	return NPM_ADD_VERBS.has(s) || NPM_SYNC_VERBS.has(s) || NPM_REMOVE_VERBS.has(s);
}

function parseNpmLike(
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
function parsePip(
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

function classifyPipSpec(spec: string): PackageSpec {
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
function parsePoetry(
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
function parseUv(
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
function parseCargo(
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
function parseGem(
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

function parseBundle(
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
function parseGo(
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
