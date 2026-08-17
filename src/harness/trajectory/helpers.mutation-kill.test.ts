import { describe, expect, it } from "vitest";
import {
	commandFamily,
	detectAllSecretLiterals,
	detectSecretLiteral,
	isSecretPath,
	isSourceCodeFile,
	isTestFile,
	looksLikeHighConfidenceSecret,
	looksLikeSecretLiteral,
} from "./helpers.js";

// Mutation-kill companion targeting module-scope regex/string-literal survivors
// in helpers.ts: verifier-family regexes, file-extension classifiers, the
// secret-shape table, and the secret-path table. Mutant-id -> fixture mapping
// lives in scratch/fleet-r3/receipts/src_harness_trajectory_helpers.ts.jsonl.

describe("commandFamily — verifier-family regex spacing must be a RUN, not a single/non-space char", () => {
	it("go/cargo/deno + test: needs one-or-more whitespace, not exactly one", () => {
		expect(commandFamily("go  test")).toBe("test");
	});

	it("vite/cargo/go + build: needs one-or-more whitespace, not exactly one", () => {
		expect(commandFamily("go  build")).toBe("build");
	});

	it("npm-family test: outer spacing is a RUN; run-prefix, when present, is optional and its own spacing is a RUN (not non-whitespace)", () => {
		expect(commandFamily("npm  test")).toBe("test");
		expect(commandFamily("npm run  test")).toBe("test");
		expect(commandFamily("npm run test")).toBe("test");
	});

	it("npm-family build: outer spacing is a RUN; run-prefix is optional (not mandatory); its spacing is a RUN", () => {
		expect(commandFamily("npm  build")).toBe("build");
		expect(commandFamily("npm build")).toBe("build");
		expect(commandFamily("npm run  build")).toBe("build");
	});
});

describe("isSourceCodeFile / isTestFile — extension-list end anchors ($)", () => {
	it("a NON_CODE_EXT suffix that is not the actual trailing extension must not exclude real source", () => {
		expect(isSourceCodeFile("config.json.ts")).toBe(true);
	});

	it("a .d.ts-shaped substring that is not the real trailing extension stays source", () => {
		expect(isSourceCodeFile("src/foo.d.tsx")).toBe(true);
	});

	it("a source-extension-shaped substring that is not the real trailing extension is not source", () => {
		expect(isSourceCodeFile("notes.go.bak")).toBe(false);
	});

	it("test/ directory prefix (^ or /), optional trailing 's', and the .test.<ext> suffix ($) are each load-bearing", () => {
		expect(isTestFile("test/foo.ts")).toBe(true);
		expect(isTestFile("foo.test.ts.orig")).toBe(false);
		expect(isTestFile("foo.test.cts")).toBe(true);
	});
});

describe("secret-shape table — each kind label and its high-confidence flag", () => {
	it("private_key kind label survives (not blanked to '')", () => {
		expect(detectSecretLiteral("-----BEGIN PRIVATE KEY-----")?.kind).toBe("private_key");
	});

	it("github_pat kind label survives", () => {
		expect(detectSecretLiteral(`ghp_${"a".repeat(36)}`)?.kind).toBe("github_pat");
	});

	it("anthropic_key kind label survives and is high-confidence", () => {
		const content = `sk-ant-${"a".repeat(25)}`;
		expect(detectSecretLiteral(content)?.kind).toBe("anthropic_key");
		expect(looksLikeHighConfidenceSecret(content)).toBe(true);
	});

	it("slack_token kind label survives", () => {
		expect(detectSecretLiteral(`xoxb-${"1".repeat(12)}`)?.kind).toBe("slack_token");
	});

	it("openai_key kind label survives", () => {
		expect(detectSecretLiteral(`sk-${"a".repeat(25)}`)?.kind).toBe("openai_key");
	});

	it("anthropic_key regex: the {20,} floor is load-bearing (a 1-char tail must not qualify)", () => {
		expect(looksLikeSecretLiteral("token sk-ant-a end")).toBe(false);
	});

	it("slack_token regex: the {10,} floor is load-bearing (a 1-char tail must not qualify)", () => {
		expect(looksLikeSecretLiteral("token xoxb-a end")).toBe(false);
	});

	it("no pattern matches a plain sentence (StringLiteral/Regex mutants must not turn benign text into a hit)", () => {
		expect(detectAllSecretLiterals("hello world, nothing to see here")).toEqual([]);
	});
});

describe("isSecretPath — every SECRET_PATH_RES entry, both its ^/ prefix and its $ suffix anchor", () => {
	it(".env: word-char suffix must match, but only when the string actually ENDS there", () => {
		expect(isSecretPath(".env.local")).toBe(true);
		expect(isSecretPath(".env.production")).toBe(true);
		expect(isSecretPath("config/.envrc")).toBe(false);
	});

	it(".ssh/id_rsa at the start of the string (no leading slash) still matches", () => {
		expect(isSecretPath(".ssh/id_rsa")).toBe(true);
	});

	it(".aws/credentials at the start of the string still matches (isolated from the generic 'credentials' entry via a suffix the generic entry's $ rejects)", () => {
		expect(isSecretPath(".aws/credentials")).toBe(true);
		expect(isSecretPath(".aws/credentials.bak")).toBe(true);
	});

	it(".config/gcloud/ at the start of the string still matches", () => {
		expect(isSecretPath(".config/gcloud/token.json")).toBe(true);
	});

	it(".kube/config at the start of the string still matches", () => {
		expect(isSecretPath(".kube/config")).toBe(true);
	});

	it(".docker/config.json at the start of the string still matches", () => {
		expect(isSecretPath(".docker/config.json")).toBe(true);
	});

	it(".npmrc: start-of-string prefix and end-of-string suffix are both load-bearing", () => {
		expect(isSecretPath(".npmrc")).toBe(true);
		expect(isSecretPath("project/.npmrc.bak")).toBe(false);
	});

	it(".netrc: start-of-string prefix and end-of-string suffix are both load-bearing", () => {
		expect(isSecretPath(".netrc")).toBe(true);
		expect(isSecretPath("home/.netrc.old")).toBe(false);
	});

	it(".pgpass: start-of-string prefix and end-of-string suffix are both load-bearing", () => {
		expect(isSecretPath(".pgpass")).toBe(true);
		expect(isSecretPath("db/.pgpass.bak")).toBe(false);
	});

	it("credentials/secrets: ^ prefix, optional trailing 's', optional suffix group, and ya?ml are each load-bearing", () => {
		expect(isSecretPath("credentials")).toBe(true);
		expect(isSecretPath("secret")).toBe(true);
		expect(isSecretPath("app/credentials.txt")).toBe(false);
		expect(isSecretPath("config/credentials.yml")).toBe(true);
	});
});
