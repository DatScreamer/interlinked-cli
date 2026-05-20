import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addAllowlistCommand,
	listAllowlistCommand,
	removeAllowlistCommand,
	snapshotAllowlistCommand,
	verifyAllowlistCommand,
} from "./allowlist.js";

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "allowlist-cmd-test-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

function readAllowlistFile(): Record<string, unknown> | null {
	const p = join(workspace, ".interlinked", "package-allowlist.json");
	if (!existsSync(p)) return null;
	return JSON.parse(readFileSync(p, "utf-8"));
}

function capture(fn: () => void): string {
	const orig = process.stdout.write;
	let captured = "";
	(process.stdout as { write: typeof process.stdout.write }).write = ((
		chunk: string | Uint8Array,
	) => {
		captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
		return true;
	}) as typeof process.stdout.write;
	try {
		fn();
	} finally {
		process.stdout.write = orig;
	}
	return captured;
}

describe("addAllowlistCommand", () => {
	it("adds an entry to the per-ecosystem map and persists it", () => {
		addAllowlistCommand("npm", "lodash", { reason: "util", by: "qcody", cwd: workspace });
		const parsed = readAllowlistFile() as {
			packages: { npm: Record<string, { approved_by: string; reason?: string }> };
		};
		expect(parsed.packages.npm.lodash.approved_by).toBe("qcody");
		expect(parsed.packages.npm.lodash.reason).toBe("util");
	});

	it("rejects an unknown ecosystem", () => {
		expect(() =>
			addAllowlistCommand("badeco" as "npm", "foo", { by: "x", cwd: workspace }),
		).toThrow(/ecosystem/i);
	});

	it("refuses to approve a typosquat name (npm) without --force", () => {
		expect(() =>
			addAllowlistCommand("npm", "chlk", { by: "x", cwd: workspace }),
		).toThrow(/typosquat|chalk|distance/i);
	});

	it("allows the typosquat name when --force is passed", () => {
		addAllowlistCommand("npm", "chlk", { by: "x", cwd: workspace, force: true });
		const parsed = readAllowlistFile() as {
			packages: { npm: Record<string, unknown> };
		};
		expect(parsed.packages.npm.chlk).toBeDefined();
	});

	it("does not run typosquat detection for non-npm ecosystems", () => {
		// 'requests' is exact-name popular, but 'requessts' is a typosquat by
		// npm-popular rules. PyPI gets a pass — different popular set, different
		// risk model; the npm typosquat list isn't relevant.
		addAllowlistCommand("pypi", "chlk", { by: "x", cwd: workspace });
		const parsed = readAllowlistFile() as {
			packages: { pypi: Record<string, unknown> };
		};
		expect(parsed.packages.pypi.chlk).toBeDefined();
	});
});

describe("removeAllowlistCommand", () => {
	it("removes an existing entry", () => {
		addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		removeAllowlistCommand("npm", "lodash", { cwd: workspace });
		const parsed = readAllowlistFile() as {
			packages: { npm: Record<string, unknown> };
		};
		expect(parsed.packages.npm.lodash).toBeUndefined();
	});

	it("is a no-op when removing a non-existent entry — does not throw, file unchanged", () => {
		// The implementation may either skip saving (file doesn't exist) or save
		// with the entry absent. Both states satisfy "non-existent entry stays
		// non-existent." Read with a sentinel to give one assertion regardless.
		const before = readAllowlistFile();
		removeAllowlistCommand("npm", "nonexistent", { cwd: workspace });
		const after = readAllowlistFile() ?? { packages: { npm: {} } };
		const npmRecord = (after as { packages: { npm: Record<string, unknown> } })
			.packages.npm;
		expect(npmRecord.nonexistent).toBeUndefined();
		expect(before).toBeNull();
	});
});

describe("listAllowlistCommand", () => {
	it("emits empty state when no entries exist", () => {
		const out = capture(() => listAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/empty|no entries/i);
	});

	it("emits entries grouped by ecosystem", () => {
		addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		addAllowlistCommand("pypi", "requests", { by: "y", cwd: workspace });
		const out = capture(() => listAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/lodash/);
		expect(out).toMatch(/requests/);
		expect(out).toMatch(/npm/);
		expect(out).toMatch(/pypi/);
	});

	it("supports --json output", () => {
		addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		const out = capture(() => listAllowlistCommand({ cwd: workspace, json: true }));
		const parsed = JSON.parse(out) as {
			packages: { npm: Record<string, unknown> };
		};
		expect(parsed.packages.npm.lodash).toBeDefined();
	});

	it("filters by ecosystem", () => {
		addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		addAllowlistCommand("pypi", "requests", { by: "y", cwd: workspace });
		const out = capture(() =>
			listAllowlistCommand({ cwd: workspace, ecosystem: "npm" }),
		);
		expect(out).toMatch(/lodash/);
		expect(out).not.toMatch(/requests/);
	});
});

describe("snapshotAllowlistCommand", () => {
	it("snapshots all known manifest + lockfile files in cwd", () => {
		writeFileSync(join(workspace, "package.json"), '{"name":"x"}');
		writeFileSync(join(workspace, "package-lock.json"), '{"lockfileVersion":3}');
		snapshotAllowlistCommand({ cwd: workspace, by: "qcody", reason: "initial" });
		const parsed = readAllowlistFile() as {
			lockfile_snapshots: Record<
				string,
				{ sha256: string; approved_by: string }
			>;
		};
		expect(parsed.lockfile_snapshots["package.json"]).toBeDefined();
		expect(parsed.lockfile_snapshots["package-lock.json"]).toBeDefined();
		expect(parsed.lockfile_snapshots["package-lock.json"].sha256).toMatch(
			/^[a-f0-9]{64}$/,
		);
		expect(parsed.lockfile_snapshots["package-lock.json"].approved_by).toBe("qcody");
	});

	it("supports --lockfile to snapshot a specific file only", () => {
		writeFileSync(join(workspace, "package.json"), '{"name":"x"}');
		writeFileSync(join(workspace, "package-lock.json"), '{"lockfileVersion":3}');
		snapshotAllowlistCommand({
			cwd: workspace,
			by: "qcody",
			lockfile: "package-lock.json",
		});
		const parsed = readAllowlistFile() as {
			lockfile_snapshots: Record<string, unknown>;
		};
		expect(parsed.lockfile_snapshots["package-lock.json"]).toBeDefined();
		expect(parsed.lockfile_snapshots["package.json"]).toBeUndefined();
	});

	it("is a no-op when no recognised files are present", () => {
		const out = capture(() => snapshotAllowlistCommand({ cwd: workspace, by: "x" }));
		expect(out).toMatch(/no.*manifest|no.*lockfile|nothing/i);
	});
});

describe("verifyAllowlistCommand", () => {
	it("reports clean when all manifest deps are allowlisted and snapshot matches", () => {
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({ dependencies: { lodash: "^4.17.21" } }, null, 2),
		);
		addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		snapshotAllowlistCommand({ cwd: workspace, by: "x" });
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|ok|all approved/i);
	});

	it("reports the unapproved deps in manifest", () => {
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({ dependencies: { evil: "1" } }, null, 2),
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil/);
		expect(out).toMatch(/unapproved|missing/i);
	});

	it("walks requirements.txt (P2.8)", () => {
		writeFileSync(join(workspace, "requirements.txt"), "evil-py==1.0\n");
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-py/);
	});

	it("walks pyproject.toml (P2.8)", () => {
		writeFileSync(
			join(workspace, "pyproject.toml"),
			`[tool.poetry.dependencies]\npython = "^3.11"\nevil-poetry = "^1"\n`,
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-poetry/);
	});

	it("walks Cargo.toml (P2.8)", () => {
		writeFileSync(join(workspace, "Cargo.toml"), `[dependencies]\nevil-crate = "1"\n`);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-crate/);
	});

	it("walks Gemfile (P2.8)", () => {
		writeFileSync(join(workspace, "Gemfile"), `gem "evil-gem", "1"\n`);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-gem/);
	});

	it("walks go.mod (P2.8)", () => {
		writeFileSync(
			join(workspace, "go.mod"),
			`module x\ngo 1.21\nrequire github.com/evil/pkg v1.0.0\n`,
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/github\.com\/evil\/pkg/);
	});
});
