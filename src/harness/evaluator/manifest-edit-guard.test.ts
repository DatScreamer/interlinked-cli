import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToAllowlist, loadAllowlist } from "../package-allowlist.js";
import { evaluateManifestEdit } from "./manifest-edit-guard.js";

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "manifest-edit-test-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

interface EditScenario {
	filename: string;
	current: string | null;
	next: string;
}

function newContent(scenario: EditScenario) {
	const path = join(workspace, scenario.filename);
	mkdirSync(dirname(path), { recursive: true });
	if (scenario.current !== null) writeFileSync(path, scenario.current);
	return {
		filePath: path,
		newContent: scenario.next,
		allowlist: loadAllowlist(workspace),
		cwd: workspace,
	};
}

describe("evaluateManifestEdit — package.json", () => {
	it("blocks adding a new unapproved dep to dependencies", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify(
					{ name: "x", dependencies: { existing: "1.0.0" } },
					null,
					2,
				),
				next: JSON.stringify(
					{ name: "x", dependencies: { existing: "1.0.0", evil: "9.9.9" } },
					null,
					2,
				),
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});

	it("allows adding an allowlisted dep", () => {
		addToAllowlist(workspace, "npm", "lodash", { approved_by: "x" });
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ name: "x", dependencies: {} }, null, 2),
				next: JSON.stringify(
					{ name: "x", dependencies: { lodash: "^4.17.21" } },
					null,
					2,
				),
			}),
		);
		expect(r).toBeNull();
	});

	it("allows version bumps on an existing dep without re-approval", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: { existing: "1.0.0" } }, null, 2),
				next: JSON.stringify({ dependencies: { existing: "1.0.1" } }, null, 2),
			}),
		);
		// Same package name, different version → not a "new dep" gate; allow.
		expect(r).toBeNull();
	});

	it("allows removing a dep", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: { a: "1", b: "1" } }, null, 2),
				next: JSON.stringify({ dependencies: { a: "1" } }, null, 2),
			}),
		);
		expect(r).toBeNull();
	});

	it("blocks new entries in devDependencies", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ devDependencies: {} }, null, 2),
				next: JSON.stringify({ devDependencies: { evil: "1" } }, null, 2),
			}),
		);
		expect(r?.decision).toBe("block");
	});

	it("blocks new entries in optionalDependencies", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ optionalDependencies: {} }, null, 2),
				next: JSON.stringify({ optionalDependencies: { evil: "1" } }, null, 2),
			}),
		);
		expect(r?.decision).toBe("block");
	});

	it("blocks new entries in peerDependencies", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ peerDependencies: {} }, null, 2),
				next: JSON.stringify({ peerDependencies: { evil: "1" } }, null, 2),
			}),
		);
		expect(r?.decision).toBe("block");
	});

	it("blocks git URL value even on existing-name field (resolves to a different package)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: { foo: "^1.0.0" } }, null, 2),
				next: JSON.stringify(
					{ dependencies: { foo: "git+https://attacker.com/evil.git" } },
					null,
					2,
				),
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/git/i);
	});

	it("blocks tarball URL value", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: {} }, null, 2),
				next: JSON.stringify(
					{ dependencies: { foo: "https://attacker.com/payload.tgz" } },
					null,
					2,
				),
			}),
		);
		expect(r?.decision).toBe("block");
	});
});

describe("evaluateManifestEdit — requirements.txt", () => {
	it("blocks a new unapproved Python dep line", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "requirements.txt",
				current: "requests==2.31.0\n",
				next: "requests==2.31.0\nevil-pkg==1.0\n",
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil-pkg/);
	});

	it("allows a new approved line", () => {
		addToAllowlist(workspace, "pypi", "requests", { approved_by: "x" });
		const r = evaluateManifestEdit(
			newContent({
				filename: "requirements.txt",
				current: "",
				next: "requests==2.31.0\n",
			}),
		);
		expect(r).toBeNull();
	});

	it("ignores comments and blank lines", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "requirements.txt",
				current: "# old\n",
				next: "# new comment\n\n# another\n",
			}),
		);
		expect(r).toBeNull();
	});

	it("blocks new git+ URL line even with same name", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "requirements.txt",
				current: "",
				next: "git+https://attacker.com/evil.git\n",
			}),
		);
		expect(r?.decision).toBe("block");
	});
});

describe("evaluateManifestEdit — pyproject.toml", () => {
	it("blocks adding a poetry dep that's not on the allowlist", () => {
		const before = `[tool.poetry.dependencies]\npython = "^3.11"\n`;
		const after = `[tool.poetry.dependencies]\npython = "^3.11"\nevil = "^1.0"\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pyproject.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});

	it("allows adding an approved poetry dep", () => {
		addToAllowlist(workspace, "pypi", "fastapi", { approved_by: "x" });
		const before = `[tool.poetry.dependencies]\npython = "^3.11"\n`;
		const after = `[tool.poetry.dependencies]\npython = "^3.11"\nfastapi = "^0.110"\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pyproject.toml", current: before, next: after }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — Cargo.toml", () => {
	it("blocks adding an unapproved cargo dep", () => {
		const before = `[dependencies]\nserde = "1"\n`;
		const after = `[dependencies]\nserde = "1"\nevil = "1"\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});

	it("blocks repinning an approved dep to a git source (P2.5)", () => {
		addToAllowlist(workspace, "cargo", "serde", { approved_by: "x" });
		const before = `[dependencies]\nserde = "1"\n`;
		const after = `[dependencies]\nserde = { git = "https://attacker.com/serde" }\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/git|serde/i);
	});

	it("blocks repinning to a path source pointing outside the workspace (P2.5)", () => {
		addToAllowlist(workspace, "cargo", "serde", { approved_by: "x" });
		const before = `[dependencies]\nserde = "1"\n`;
		const after = `[dependencies]\nserde = { path = "/etc/evil" }\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
	});

	it("allows a plain version bump on an approved cargo dep", () => {
		addToAllowlist(workspace, "cargo", "serde", { approved_by: "x" });
		const before = `[dependencies]\nserde = "1.0"\n`;
		const after = `[dependencies]\nserde = "1.1"\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — pyproject.toml repin (P2.5)", () => {
	it("blocks repinning an approved poetry dep to a git source", () => {
		addToAllowlist(workspace, "pypi", "requests", { approved_by: "x" });
		const before = `[tool.poetry.dependencies]\nrequests = "^2.32"\n`;
		const after = `[tool.poetry.dependencies]\nrequests = { git = "https://attacker.com/requests" }\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pyproject.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
	});
});

describe("evaluateManifestEdit — Gemfile repin (P2.5)", () => {
	it("blocks repinning an approved gem to a git source", () => {
		addToAllowlist(workspace, "rubygems", "rails", { approved_by: "x" });
		const before = `gem "rails", "~> 7"\n`;
		const after = `gem "rails", git: "https://attacker.com/rails"\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "Gemfile", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
	});
});

describe("evaluateManifestEdit — irrelevant files", () => {
	it("returns null for non-manifest files", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "src/foo.ts",
				current: "export const x = 1;",
				next: "export const x = 2;",
			}),
		);
		expect(r).toBeNull();
	});

	it("returns null for malformed JSON (don't fail-closed on parse errors — agents need feedback)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: '{"valid":true}',
				next: "{not json",
			}),
		);
		// Parse failure means we can't compute diff. Don't block on syntax;
		// other guards will surface JSON validity feedback separately.
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — new file (no current)", () => {
	it("blocks a brand-new package.json that introduces unapproved deps", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: null,
				next: JSON.stringify({ dependencies: { evil: "1" } }, null, 2),
			}),
		);
		expect(r?.decision).toBe("block");
	});

	it("allows a brand-new package.json with no deps", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: null,
				next: JSON.stringify({ name: "x" }, null, 2),
			}),
		);
		expect(r).toBeNull();
	});
});
