import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToAllowlist, loadAllowlist } from "../package-allowlist.js";
import { evaluateManifestEdit, extractGoModDeps } from "./manifest-edit-guard.js";

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

describe("extractGoModDeps", () => {
	it("parses the block `require ( ... )` form", () => {
		const goMod = `module example.com/app

go 1.22

require (
	github.com/gin-gonic/gin v1.9.1
	golang.org/x/sync v0.6.0
)`;
		const deps = extractGoModDeps(goMod);
		expect(deps.get("github.com/gin-gonic/gin")).toBe("v1.9.1");
		expect(deps.get("golang.org/x/sync")).toBe("v0.6.0");
	});

	it("parses the single-line `require X Y` form", () => {
		const deps = extractGoModDeps("require github.com/pkg/errors v0.9.1");
		expect(deps.get("github.com/pkg/errors")).toBe("v0.9.1");
	});

	it("returns an empty map for a go.mod with no require directives", () => {
		expect(extractGoModDeps("module example.com/app\n\ngo 1.22\n").size).toBe(0);
	});
});

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

describe("evaluateManifestEdit — composer.json", () => {
	it("blocks adding an unapproved require dep", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "composer.json",
				current: JSON.stringify({ require: { php: ">=8.1" } }, null, 2),
				next: JSON.stringify(
					{ require: { php: ">=8.1", "evil/pkg": "^1.0" } },
					null,
					2,
				),
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil\/pkg/);
		expect(r?.reason).toMatch(/composer/);
	});

	it("blocks an unapproved require-dev dep", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "composer.json",
				current: JSON.stringify({ "require-dev": {} }, null, 2),
				next: JSON.stringify(
					{ "require-dev": { "phpunit/phpunit": "^10" } },
					null,
					2,
				),
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/phpunit/);
	});

	it("blocks flipping an approved dep to an inline git source", () => {
		addToAllowlist(workspace, "composer", "monolog/monolog", { approved_by: "x" });
		const before = JSON.stringify({ require: { "monolog/monolog": "^3.0" } }, null, 2);
		const after = JSON.stringify(
			{ require: { "monolog/monolog": "dev-main git=https://attacker.test/monolog" } },
			null,
			2,
		);
		const r = evaluateManifestEdit(
			newContent({ filename: "composer.json", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
	});

	it("allows adding an allowlisted composer dep", () => {
		addToAllowlist(workspace, "composer", "monolog/monolog", { approved_by: "x" });
		const r = evaluateManifestEdit(
			newContent({
				filename: "composer.json",
				current: JSON.stringify({ require: {} }, null, 2),
				next: JSON.stringify(
					{ require: { "monolog/monolog": "^3.0" } },
					null,
					2,
				),
			}),
		);
		expect(r).toBeNull();
	});

	it("allows a plain version bump on an existing dep", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "composer.json",
				current: JSON.stringify({ require: { "monolog/monolog": "^3.0" } }, null, 2),
				next: JSON.stringify({ require: { "monolog/monolog": "^3.1" } }, null, 2),
			}),
		);
		expect(r).toBeNull();
	});

	it("returns null on a no-dep edit (only metadata changed)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "composer.json",
				current: JSON.stringify({ name: "vendor/a", require: {} }, null, 2),
				next: JSON.stringify({ name: "vendor/b", require: {} }, null, 2),
			}),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — pom.xml (maven)", () => {
	const POM_BASE = `<project>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.0.0-jre</version>
    </dependency>
  </dependencies>
</project>`;

	it("blocks adding an unapproved <dependency>", () => {
		const after = `<project>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.0.0-jre</version>
    </dependency>
    <dependency>
      <groupId>com.evil</groupId>
      <artifactId>payload</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
</project>`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pom.xml", current: POM_BASE, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/com\.evil:payload/);
		expect(r?.reason).toMatch(/maven/);
	});

	it("allows adding an allowlisted maven coordinate", () => {
		// Seed BEFORE newContent so loadAllowlist picks up the grant. The only
		// delta vs POM_BASE is the new junit dep (guava is unchanged, so not
		// re-checked); the new junit coordinate must be allowlisted.
		addToAllowlist(workspace, "maven", "org.junit.jupiter:junit-jupiter", {
			approved_by: "x",
		});
		const after = `<project>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.0.0-jre</version>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.0</version>
    </dependency>
  </dependencies>
</project>`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pom.xml", current: POM_BASE, next: after }),
		);
		expect(r).toBeNull();
	});

	it("returns null when no dependency changed (whitespace-only edit)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "pom.xml",
				current: POM_BASE,
				next: `${POM_BASE}\n`,
			}),
		);
		expect(r).toBeNull();
	});

	it("returns null for a pom edit touching only <build> plugins (not deps)", () => {
		const after = `<project>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.0.0-jre</version>
    </dependency>
  </dependencies>
  <build><plugins><plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-surefire-plugin</artifactId>
  </plugin></plugins></build>
</project>`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pom.xml", current: POM_BASE, next: after }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — build.gradle / build.gradle.kts", () => {
	it("blocks an unapproved Groovy implementation line specifically", () => {
		addToAllowlist(workspace, "gradle", "com.google.guava:guava", { approved_by: "x" });
		const before = `dependencies {\n  implementation "com.google.guava:guava:33.0.0-jre"\n}`;
		const after = `dependencies {\n  implementation "com.google.guava:guava:33.0.0-jre"\n  implementation "com.evil:payload:1.0.0"\n}`;
		const r = evaluateManifestEdit(
			newContent({ filename: "build.gradle", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/com\.evil:payload/);
		expect(r?.reason).toMatch(/gradle/);
	});

	it('blocks an unapproved Kotlin-DSL implementation("...") line', () => {
		const before = `dependencies {\n}`;
		const after = `dependencies {\n  implementation("io.evil:ktor-evil:2.3.7")\n}`;
		const r = evaluateManifestEdit(
			newContent({ filename: "build.gradle.kts", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/io\.evil:ktor-evil/);
	});

	it("allows an allowlisted gradle coordinate", () => {
		addToAllowlist(workspace, "gradle", "com.squareup.okhttp3:okhttp", {
			approved_by: "x",
		});
		const before = `dependencies {\n}`;
		const after = `dependencies {\n  implementation "com.squareup.okhttp3:okhttp:4.12.0"\n}`;
		const r = evaluateManifestEdit(
			newContent({ filename: "build.gradle", current: before, next: after }),
		);
		expect(r).toBeNull();
	});

	it("returns null on a version bump of an existing coordinate", () => {
		const before = `dependencies {\n  implementation "com.google.guava:guava:33.0.0-jre"\n}`;
		const after = `dependencies {\n  implementation "com.google.guava:guava:33.1.0-jre"\n}`;
		const r = evaluateManifestEdit(
			newContent({ filename: "build.gradle", current: before, next: after }),
		);
		expect(r).toBeNull();
	});

	it("returns null on a non-dependency edit (a task block, no coordinate)", () => {
		const before = `dependencies {\n}\ntasks.register("hello") {}`;
		const after = `dependencies {\n}\ntasks.register("goodbye") {}`;
		const r = evaluateManifestEdit(
			newContent({ filename: "build.gradle", current: before, next: after }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — packages.config (nuget)", () => {
	it("blocks adding an unapproved <package> entry", () => {
		addToAllowlist(workspace, "nuget", "Newtonsoft.Json", { approved_by: "x" });
		const before = `<packages>\n  <package id="Newtonsoft.Json" version="13.0.3" />\n</packages>`;
		const after = `<packages>\n  <package id="Newtonsoft.Json" version="13.0.3" />\n  <package id="Evil.Payload" version="1.0.0" />\n</packages>`;
		const r = evaluateManifestEdit(
			newContent({ filename: "packages.config", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/Evil\.Payload/);
		expect(r?.reason).toMatch(/nuget/);
	});

	it("allows an allowlisted nuget package", () => {
		addToAllowlist(workspace, "nuget", "Serilog", { approved_by: "x" });
		const before = `<packages>\n</packages>`;
		const after = `<packages>\n  <package id="Serilog" version="3.1.1" />\n</packages>`;
		const r = evaluateManifestEdit(
			newContent({ filename: "packages.config", current: before, next: after }),
		);
		expect(r).toBeNull();
	});

	it("returns null on a version bump of an existing package", () => {
		const before = `<packages>\n  <package id="Newtonsoft.Json" version="13.0.2" />\n</packages>`;
		const after = `<packages>\n  <package id="Newtonsoft.Json" version="13.0.3" />\n</packages>`;
		const r = evaluateManifestEdit(
			newContent({ filename: "packages.config", current: before, next: after }),
		);
		expect(r).toBeNull();
	});

	it("returns null on a no-package edit (comment only)", () => {
		const before = `<packages>\n</packages>`;
		const after = `<packages>\n  <!-- restored -->\n</packages>`;
		const r = evaluateManifestEdit(
			newContent({ filename: "packages.config", current: before, next: after }),
		);
		expect(r).toBeNull();
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

describe("evaluateManifestEdit — license policy (recorded field, never network)", () => {
	function approveWithLicense(name: string, license?: string): void {
		addToAllowlist(workspace, "npm", name, {
			approved_by: "qcody",
			...(license !== undefined ? { license } : {}),
		});
	}

	function editAddingDep(dep: string, warnings: string[]) {
		const base = newContent({
			filename: "package.json",
			current: JSON.stringify({ name: "x", dependencies: {} }, null, 2),
			next: JSON.stringify({ name: "x", dependencies: { [dep]: "1.0.0" } }, null, 2),
		});
		return { ...base, allowlist: loadAllowlist(workspace), warnings };
	}

	it("warns when an allowed dep's recorded license is outside the SPDX allowlist", () => {
		approveWithLicense("copyleft-pkg", "AGPL-3.0");
		const warnings: string[] = [];
		const r = evaluateManifestEdit(editAddingDep("copyleft-pkg", warnings));
		expect(r).toBeNull(); // allowed — license drift is a warning, not a block
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/AGPL-3\.0/);
		expect(warnings[0]).toMatch(/license_allowlist/);
	});

	it("warning fires for a --force-admitted license even though the dep is approved", () => {
		approveWithLicense("gpl-pkg", "GPL-3.0");
		const warnings: string[] = [];
		evaluateManifestEdit(editAddingDep("gpl-pkg", warnings));
		expect(warnings.some((w) => w.includes("GPL-3.0"))).toBe(true);
	});

	it("stays silent for an allowed license", () => {
		approveWithLicense("mit-pkg", "MIT");
		const warnings: string[] = [];
		const r = evaluateManifestEdit(editAddingDep("mit-pkg", warnings));
		expect(r).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	it("stays silent when no license was recorded at admission (no noise for old grants)", () => {
		approveWithLicense("legacy-pkg");
		const warnings: string[] = [];
		const r = evaluateManifestEdit(editAddingDep("legacy-pkg", warnings));
		expect(r).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	it("does not crash when no warnings array is provided", () => {
		approveWithLicense("copyleft-pkg2", "AGPL-3.0");
		const base = newContent({
			filename: "package.json",
			current: JSON.stringify({ name: "x", dependencies: {} }, null, 2),
			next: JSON.stringify({ name: "x", dependencies: { "copyleft-pkg2": "1.0.0" } }, null, 2),
		});
		const r = evaluateManifestEdit({ ...base, allowlist: loadAllowlist(workspace) });
		expect(r).toBeNull();
	});

	it("respects a committed license_allowlist override (no warning when policy permits)", () => {
		approveWithLicense("agpl-ok", "AGPL-3.0");
		const al = loadAllowlist(workspace);
		al.license_allowlist = ["AGPL-3.0"];
		const base = newContent({
			filename: "package.json",
			current: JSON.stringify({ name: "x", dependencies: {} }, null, 2),
			next: JSON.stringify({ name: "x", dependencies: { "agpl-ok": "1.0.0" } }, null, 2),
		});
		const warnings: string[] = [];
		evaluateManifestEdit({ ...base, allowlist: al, warnings });
		expect(warnings).toHaveLength(0);
	});
});

describe("evaluateManifestEdit — requirements.in", () => {
	it("blocks a new unapproved Python dep line in requirements.in", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "requirements.in",
				current: "requests==2.31.0\n",
				next: "requests==2.31.0\nevil-pkg==1.0\n",
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil-pkg/);
	});
});

describe("evaluateManifestEdit — requirements.txt pip-flag and unparseable lines", () => {
	it("ignores a pip flag line (not '-e ') and still blocks the real new dep", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "requirements.txt",
				current: "",
				next: "--no-binary :all:\nevil==1.0\n",
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});

	it("skips a line that doesn't match the name pattern", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "requirements.txt",
				current: "",
				next: "===not-a-name===\n",
			}),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — go.mod", () => {
	it("blocks a new unapproved go.mod require (block form) and skips the already-present one", () => {
		const before = `module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/existing/pkg v1.0.0\n)`;
		const after = `module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/existing/pkg v1.0.0\n\tgithub.com/evil/pkg v1.0.0\n)`;
		const r = evaluateManifestEdit(
			newContent({ filename: "go.mod", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/github\.com\/evil\/pkg/);
		expect(r?.reason).not.toMatch(/existing/);
		expect(r?.reason).toMatch(/go/);
	});

	it("allows an allowlisted go.mod require", () => {
		addToAllowlist(workspace, "go", "github.com/ok/pkg", { approved_by: "x" });
		const before = `module example.com/app\n`;
		const after = `module example.com/app\n\nrequire github.com/ok/pkg v1.0.0\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "go.mod", current: before, next: after }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — package.json with non-object parsed shape", () => {
	it("treats a non-object valid-JSON 'before' as having no existing deps (recordOf guard)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify("just a string"),
				next: JSON.stringify({ dependencies: { evil: "1.0.0" } }, null, 2),
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});

	it("blocks a new dep pinned to a file: spec", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: {} }, null, 2),
				next: JSON.stringify({ dependencies: { evil: "file:../evil" } }, null, 2),
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/file:/);
	});
});

describe("evaluateManifestEdit — package.json manifest unreadable on disk (safeRead catch)", () => {
	it("treats an unreadable existing manifest as empty (EISDIR) rather than crashing", () => {
		const path = join(workspace, "package.json");
		mkdirSync(path, { recursive: true }); // a directory at the manifest's path — readFileSync throws EISDIR
		const r = evaluateManifestEdit({
			filePath: path,
			newContent: JSON.stringify({ dependencies: { evil: "1.0.0" } }, null, 2),
			allowlist: loadAllowlist(workspace),
			cwd: workspace,
		});
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});
});

describe("evaluateManifestEdit — pyproject.toml project.dependencies array form", () => {
	it("blocks a new unapproved entry in the PEP 508 dependencies array", () => {
		const before = `dependencies = [\n  "requests==2.31.0",\n]\n`;
		const after = `dependencies = [\n  "requests==2.31.0",\n  "evil==1.0",\n]\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pyproject.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});

	it("allows an allowlisted entry in the dependencies array", () => {
		addToAllowlist(workspace, "pypi", "requests", { approved_by: "x" });
		const before = `dependencies = [\n]\n`;
		const after = `dependencies = [\n  "requests==2.31.0",\n]\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pyproject.toml", current: before, next: after }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — pyproject.toml malformed lines / unnamed array items", () => {
	it("skips a poetry-block line that doesn't match key = value", () => {
		const before = `[tool.poetry.dependencies]\npython = "^3.11"\n`;
		const after = `[tool.poetry.dependencies]\npython = "^3.11"\nnot-a-kv-line\nevil = "^1.0"\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pyproject.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});

	it("ignores a dependencies-array item that doesn't start with a valid name", () => {
		const before = `dependencies = [\n  "requests==2.31.0",\n]\n`;
		const after = `dependencies = [\n  "requests==2.31.0",\n  "===not-a-name",\n]\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pyproject.toml", current: before, next: after }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — Cargo.toml preamble and non-matching lines", () => {
	it("skips content before the [dependencies] header and unmatched lines inside it", () => {
		const before = `# top comment\n[dependencies]\nnot-a-valid-line-without-equals\nserde = "1"\n`;
		const after = `# top comment\n[dependencies]\nnot-a-valid-line-without-equals\nserde = "1"\nevil = "1"\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});

	it("blocks a Cargo.toml url= inline-table repin to a non-registry source", () => {
		addToAllowlist(workspace, "cargo", "serde", { approved_by: "x" });
		const before = `[dependencies]\nserde = "1"\n`;
		const after = `[dependencies]\nserde = { url = "https://attacker.com/serde.tar.gz" }\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
	});
});

describe("evaluateManifestEdit — Gemfile without a version constraint", () => {
	it("blocks a new gem line with no version argument", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "Gemfile",
				current: `gem "foo"\n`,
				next: `gem "foo"\ngem "evil"\n`,
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});
});

describe("evaluateManifestEdit — .csproj / version-catalog / gradle map-notation (hardening)", () => {
	it("blocks an unapproved <PackageReference> added to a .csproj (modern .NET form)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "App.csproj",
				current: "<Project><ItemGroup></ItemGroup></Project>",
				next: '<Project><ItemGroup><PackageReference Include="Evil.Pkg" Version="1.0.0" /></ItemGroup></Project>',
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/Evil\.Pkg/);
		expect(r?.reason).toMatch(/nuget/);
	});

	it("allows an allowlisted <PackageReference> in a nested .csproj", () => {
		addToAllowlist(workspace, "nuget", "Serilog", { approved_by: "x" });
		const r = evaluateManifestEdit(
			newContent({
				filename: "src/App/App.csproj",
				current: "<Project></Project>",
				next: '<Project><ItemGroup><PackageReference Include="Serilog" Version="3.0.0"/></ItemGroup></Project>',
			}),
		);
		expect(r).toBeNull();
	});

	it("blocks an unapproved coordinate added to libs.versions.toml (version-catalog)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "gradle/libs.versions.toml",
				current: "[libraries]\n",
				next: '[libraries]\nevil = { module = "com.evil:payload", version = "1.0" }\n',
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/com\.evil:payload/);
		expect(r?.reason).toMatch(/gradle/);
	});

	it("allows an allowlisted version-catalog coordinate (group/name form)", () => {
		addToAllowlist(workspace, "gradle", "com.google.guava:guava", { approved_by: "x" });
		const r = evaluateManifestEdit(
			newContent({
				filename: "libs.versions.toml",
				current: "[libraries]\n",
				next: '[libraries]\nguava = { group = "com.google.guava", name = "guava", version = "33.0" }\n',
			}),
		);
		expect(r).toBeNull();
	});

	it("blocks an unapproved gradle map-notation dependency (group:/name:)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "build.gradle",
				current: "dependencies {\n}\n",
				next: "dependencies {\n  implementation group: 'com.evil', name: 'pkg', version: '1.0'\n}\n",
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/com\.evil:pkg/);
	});

	it("does not block a non-dependency .csproj edit (property change)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "App.csproj",
				current: "<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>",
				next: "<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
			}),
		);
		expect(r).toBeNull();
	});
});
