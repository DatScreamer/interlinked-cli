import { describe, expect, it } from "vitest";
import { classifyPipSpec, parsePip, parsePoetry, parseUv } from "./package-install-parser-pypi.js";

describe("parsePip — flag scanning", () => {
	it("returns null for a non-install, non-pipx subcommand", () => {
		expect(parsePip("pip", ["pip", "list"], {})).toBeNull();
	});

	it("parses `--index-url=VALUE` glued form (=)", () => {
		const cmd = parsePip("pip", ["pip", "install", "--index-url=https://example.com/simple", "foo"], {});
		expect(cmd?.customRegistry).toBe("https://example.com/simple");
	});

	it("parses `--requirement=VALUE` glued form (=)", () => {
		const cmd = parsePip("pip", ["pip", "install", "--requirement=reqs.txt"], {});
		expect(cmd?.manifestFile).toBe("reqs.txt");
		expect(cmd?.fromManifest).toBe(true);
	});

	it("parses `-c` / `--constraint` as fromConstraints, consuming the next token", () => {
		const cmd = parsePip("pip", ["pip", "install", "-c", "constraints.txt", "foo"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo", version: undefined }]);
		// no positionals besides foo => fromManifest only true when noPositionals; here positionals present
		expect(cmd?.fromManifest).toBe(false);
	});

	it("parses `--editable=VALUE` glued form (=) as a positional spec", () => {
		const cmd = parsePip("pip", ["pip", "install", "--editable=./local-pkg"], {});
		expect(cmd?.packages).toEqual([{ kind: "local_path", path: "./local-pkg" }]);
	});

	it("parses attached short-option `-r<file>` (glued value)", () => {
		const cmd = parsePip("pip", ["pip", "install", "-rreqs.txt"], {});
		expect(cmd?.manifestFile).toBe("reqs.txt");
	});

	it("parses attached short-option `-i<url>` (glued value)", () => {
		const cmd = parsePip("pip", ["pip", "install", "-ihttps://mirror.example/simple", "foo"], {});
		expect(cmd?.customRegistry).toBe("https://mirror.example/simple");
	});

	it("parses attached short-option `-c<constraint>` (glued value)", () => {
		const cmd = parsePip("pip", ["pip", "install", "-cconstraints.txt", "foo"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo", version: undefined }]);
	});

	it("parses attached short-option `-e<spec>` (glued value) as install spec", () => {
		const cmd = parsePip("pip", ["pip", "install", "-egit+https://example.com/repo.git"], {});
		expect(cmd?.packages).toEqual([{ kind: "git_url", url: "git+https://example.com/repo.git" }]);
	});

	it("skips a value-taking flag whose value is present and not itself a flag", () => {
		const cmd = parsePip("pip", ["pip", "install", "--target", "/opt/pkgs", "foo"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo", version: undefined }]);
	});

	it("does not consume the next token when a value-taking flag's next token is itself a flag", () => {
		const cmd = parsePip("pip", ["pip", "install", "--target", "--verbose", "foo"], {});
		// --verbose is not consumed as target's value, so it falls through to the
		// unknown-flag branch (startsWith("-"), not in PIP_FLAG_TAKES_VALUE) and is skipped;
		// foo remains the only positional.
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo", version: undefined }]);
	});

	it("skips an unknown flag not in PIP_FLAG_TAKES_VALUE without consuming next token", () => {
		const cmd = parsePip("pip", ["pip", "install", "--quiet", "foo"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo", version: undefined }]);
	});

	it("`-e` with a following non-flag token consumes it as the editable spec", () => {
		const cmd = parsePip("pip", ["pip", "install", "-e", "./editable-pkg"], {});
		expect(cmd?.packages).toEqual([{ kind: "local_path", path: "./editable-pkg" }]);
	});

	it("`-e` with no following token (end of args) does not consume anything", () => {
		const cmd = parsePip("pip", ["pip", "install", "foo", "-e"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo", version: undefined }]);
	});

	it("`-e` followed by another flag does not consume the flag as its spec", () => {
		const cmd = parsePip("pip", ["pip", "install", "-e", "--quiet", "foo"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo", version: undefined }]);
	});

	it("parses `--index-url VALUE` as a separate token", () => {
		const cmd = parsePip("pip", ["pip", "install", "--index-url", "https://example.com/simple", "foo"], {});
		expect(cmd?.customRegistry).toBe("https://example.com/simple");
	});

	it("parses `-i VALUE` as a separate token", () => {
		const cmd = parsePip("pip", ["pip", "install", "-i", "https://example.com/simple", "foo"], {});
		expect(cmd?.customRegistry).toBe("https://example.com/simple");
	});

	it("parses `--extra-index-url VALUE` as a separate token", () => {
		const cmd = parsePip("pip", ["pip", "install", "--extra-index-url", "https://example.com/extra", "foo"], {});
		expect(cmd?.customRegistry).toBe("https://example.com/extra");
	});

	it("parses `-r VALUE` as a separate token", () => {
		const cmd = parsePip("pip", ["pip", "install", "-r", "reqs.txt"], {});
		expect(cmd?.manifestFile).toBe("reqs.txt");
	});

	it("parses `--requirement VALUE` as a separate token", () => {
		const cmd = parsePip("pip", ["pip", "install", "--requirement", "reqs.txt"], {});
		expect(cmd?.manifestFile).toBe("reqs.txt");
	});

	it("returns null when tokens has no subcommand at all (tokens[1] undefined)", () => {
		expect(parsePip("pip", ["pip"], {})).toBeNull();
	});

	it("`-c` with no positionals and no manifest still yields fromManifest false (fromConstraints suppresses it)", () => {
		const cmd = parsePip("pip", ["pip", "install", "-c", "constraints.txt"], {});
		expect(cmd?.packages).toEqual([]);
		expect(cmd?.fromManifest).toBe(false);
	});

	it("does not consume a trailing value-taking flag with no following token at all", () => {
		const cmd = parsePip("pip", ["pip", "install", "foo", "--target"], {});
		// `--target` is the last token: pipFlagConsumesValue's `next` is undefined,
		// so `next || ""` falls back to "" and the regex test fails — no crash, no
		// extra positional consumed.
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo", version: undefined }]);
	});

	it("recognizes pipx install/inject/run as valid subcommands", () => {
		expect(parsePip("pipx", ["pipx", "install", "black"], {})?.action).toBe("install_global");
		expect(parsePip("pipx", ["pipx", "run", "black"], {})?.action).toBe("install_global");
	});

	it("pipx inject drops the first positional (target venv name)", () => {
		const cmd = parsePip("pipx", ["pipx", "inject", "myenv", "requests==2.31.0"], {});
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "requests", version: "==2.31.0" },
		]);
	});
});

describe("classifyPipSpec", () => {
	it("classifies a tarball URL", () => {
		expect(classifyPipSpec("https://example.com/pkg-1.0.tar.gz")).toEqual({
			kind: "tarball_url",
			url: "https://example.com/pkg-1.0.tar.gz",
		});
	});

	it("classifies a git+ URL", () => {
		expect(classifyPipSpec("git+https://github.com/org/repo.git")).toEqual({
			kind: "git_url",
			url: "git+https://github.com/org/repo.git",
		});
	});

	it("classifies a file:// URL", () => {
		expect(classifyPipSpec("file:///home/user/pkg")).toEqual({
			kind: "file_url",
			path: "/home/user/pkg",
		});
	});

	it("classifies a `./relative` local path", () => {
		expect(classifyPipSpec("./local-pkg")).toEqual({ kind: "local_path", path: "./local-pkg" });
	});

	it("classifies a `../relative` local path", () => {
		expect(classifyPipSpec("../local-pkg")).toEqual({ kind: "local_path", path: "../local-pkg" });
	});

	it("classifies an `/absolute` local path", () => {
		expect(classifyPipSpec("/opt/pkg")).toEqual({ kind: "local_path", path: "/opt/pkg" });
	});

	it("classifies a bare `.` local path", () => {
		expect(classifyPipSpec(".")).toEqual({ kind: "local_path", path: "." });
	});

	it("classifies a registry package with no version", () => {
		expect(classifyPipSpec("requests")).toEqual({ kind: "registry", name: "requests", version: undefined });
	});

	it("classifies a registry package with an exact `==` pin", () => {
		expect(classifyPipSpec("requests==2.31.0")).toEqual({
			kind: "registry",
			name: "requests",
			version: "==2.31.0",
		});
	});

	it("falls back to the raw spec as the name when nothing matches the name regex (empty spec)", () => {
		expect(classifyPipSpec("")).toEqual({ kind: "registry", name: "", version: undefined });
	});
});

describe("parsePoetry", () => {
	it("returns null for an unrecognized subcommand", () => {
		expect(parsePoetry(["poetry", "show"], {})).toBeNull();
	});

	it("returns null when tokens has no subcommand at all (tokens[1] undefined)", () => {
		expect(parsePoetry(["poetry"], {})).toBeNull();
	});

	it("`poetry add` captures --source as customRegistry and skips flags", () => {
		const cmd = parsePoetry(["poetry", "add", "--source", "myrepo", "requests", "--verbose"], {});
		expect(cmd).toEqual({
			ecosystem: "pypi",
			manager: "poetry",
			action: "add",
			packages: [{ kind: "registry", name: "requests", version: undefined }],
			fromLockfile: false,
			fromManifest: false,
			customRegistry: "myrepo",
			notes: [],
		});
	});

	it("`poetry add` falls back to envRegistryFor when no --source given", () => {
		const cmd = parsePoetry(["poetry", "add", "requests"], { PIP_INDEX_URL: "https://env-registry" });
		expect(cmd?.customRegistry).toBe("https://env-registry");
	});

	it("`poetry install` sets fromLockfile true on --locked", () => {
		const cmd = parsePoetry(["poetry", "install", "--locked"], {});
		expect(cmd).toEqual({
			ecosystem: "pypi",
			manager: "poetry",
			action: "sync",
			packages: [],
			fromLockfile: true,
			fromManifest: true,
			manifestFile: "pyproject.toml",
			customRegistry: undefined,
			notes: [],
		});
	});

	it("`poetry install` sets fromLockfile true on --no-update", () => {
		const cmd = parsePoetry(["poetry", "install", "--no-update"], {});
		expect(cmd?.fromLockfile).toBe(true);
	});

	it("`poetry install` leaves fromLockfile false with no matching flag", () => {
		const cmd = parsePoetry(["poetry", "install"], {});
		expect(cmd?.fromLockfile).toBe(false);
	});

	it("`poetry install` leaves fromLockfile false when an unrelated flag is present (both OR arms false)", () => {
		const cmd = parsePoetry(["poetry", "install", "--verbose"], {});
		expect(cmd?.fromLockfile).toBe(false);
	});

	it("`poetry remove` returns a remove action with empty packages", () => {
		const cmd = parsePoetry(["poetry", "remove", "requests"], {});
		expect(cmd).toEqual({
			ecosystem: "pypi",
			manager: "poetry",
			action: "remove",
			packages: [],
			fromLockfile: false,
			fromManifest: false,
			notes: [],
		});
	});
});

describe("parseUv", () => {
	it("`uv add` classifies positionals and drops flags", () => {
		const cmd = parseUv(["uv", "add", "requests==2.31.0", "--dev"], {});
		expect(cmd).toEqual({
			ecosystem: "pypi",
			manager: "uv",
			action: "add",
			packages: [{ kind: "registry", name: "requests", version: "==2.31.0" }],
			fromLockfile: false,
			fromManifest: false,
			customRegistry: undefined,
			notes: [],
		});
	});

	it("`uv sync` sets fromLockfile true on --frozen", () => {
		expect(parseUv(["uv", "sync", "--frozen"], {})?.fromLockfile).toBe(true);
	});

	it("`uv sync` sets fromLockfile true on --locked", () => {
		expect(parseUv(["uv", "sync", "--locked"], {})?.fromLockfile).toBe(true);
	});

	it("`uv sync` leaves fromLockfile false with no matching flag", () => {
		expect(parseUv(["uv", "sync"], {})?.fromLockfile).toBe(false);
	});

	it("`uv pip install` delegates to parsePip and fills in customRegistry when unset", () => {
		const cmd = parseUv(["uv", "pip", "install", "requests"], { PIP_INDEX_URL: "https://env-registry" });
		expect(cmd?.manager).toBe("pip");
		expect(cmd?.customRegistry).toBe("https://env-registry");
	});

	it("`uv pip` with a non-install inner subcommand returns null", () => {
		expect(parseUv(["uv", "pip", "list"], {})).toBeNull();
	});

	it("`uv pip` with no inner subcommand at all returns null (args[0] undefined)", () => {
		expect(parseUv(["uv", "pip"], {})).toBeNull();
	});

	it("`uv pip install` re-resolves customRegistry via env when pip itself found none (still undefined)", () => {
		const cmd = parseUv(["uv", "pip", "install", "requests"], {});
		expect(cmd?.customRegistry).toBeUndefined();
	});

	it("`uv pip install` does NOT override an already-set customRegistry from pip's own flag", () => {
		const cmd = parseUv(
			["uv", "pip", "install", "--index-url", "https://pip-set-registry", "requests"],
			{ PIP_INDEX_URL: "https://env-registry" },
		);
		expect(cmd?.customRegistry).toBe("https://pip-set-registry");
	});

	it("returns null when tokens has no subcommand at all (tokens[1] undefined)", () => {
		expect(parseUv(["uv"], {})).toBeNull();
	});

	it("`uv tool install` classifies positionals as install_global", () => {
		const cmd = parseUv(["uv", "tool", "install", "black"], {});
		expect(cmd).toEqual({
			ecosystem: "pypi",
			manager: "uv",
			action: "install_global",
			packages: [{ kind: "registry", name: "black", version: undefined }],
			fromLockfile: false,
			fromManifest: false,
			customRegistry: undefined,
			notes: [],
		});
	});

	it("`uv tool` with a non-install inner subcommand falls through to null", () => {
		expect(parseUv(["uv", "tool", "list"], {})).toBeNull();
	});

	it("`uv tool` with no inner subcommand at all falls through to null (args[0] undefined)", () => {
		expect(parseUv(["uv", "tool"], {})).toBeNull();
	});

	it("returns null for an unrecognized subcommand", () => {
		expect(parseUv(["uv", "venv"], {})).toBeNull();
	});
});
