import { describe, expect, it } from "vitest";

import {
	INJECTION_DETECTORS,
	exfilToPublicWriteable,
	fetchedExternalThenSecretRead,
	githubIssueBodyThenAction,
	lethalTrifectaStructural,
	planVsTrajectoryDrift,
} from "./injection.js";

// Targets the module-level detector-object literal fields (id/description/
// determinism) and the INJECTION_DETECTORS array declaration. Each StringLiteral
// mutant in the brief replaces a non-empty field value with "" — asserting the
// exact non-empty value directly kills it. The ArrayDeclaration mutant replaces
// the whole array with [] — asserting length + membership kills it.

describe("lethalTrifectaStructural — static metadata", () => {
	it("id is the exact non-empty string (kills c09208bd/18cc5752 id mutant)", () => {
		expect(lethalTrifectaStructural.id).toBe("lethal_trifecta_structural");
	});

	it("description is the exact non-empty string (kills 0aa6511a mutant)", () => {
		expect(lethalTrifectaStructural.description).toBe(
			"All three legs of the lethal trifecta active (private data + untrusted content + external comm)",
		);
	});

	it("determinism is fully_deterministic (kills 35c13a6c mutant)", () => {
		expect(lethalTrifectaStructural.determinism).toBe("fully_deterministic");
	});
});

describe("fetchedExternalThenSecretRead — static metadata", () => {
	it("id is the exact non-empty string (kills b09ff8e0 mutant)", () => {
		expect(fetchedExternalThenSecretRead.id).toBe("fetched_external_then_secret_read");
	});

	it("description is the exact non-empty string (kills ea7025e7 mutant)", () => {
		expect(fetchedExternalThenSecretRead.description).toBe(
			"Read of a sensitive file after an untrusted-content fetch",
		);
	});

	it("determinism is fully_deterministic (kills c473cf10 mutant)", () => {
		expect(fetchedExternalThenSecretRead.determinism).toBe("fully_deterministic");
	});
});

describe("exfilToPublicWriteable — static metadata", () => {
	it("id is the exact non-empty string (kills 2ba0dd96 mutant)", () => {
		expect(exfilToPublicWriteable.id).toBe("exfil_to_public_writeable");
	});

	it("description is the exact non-empty string (kills 98469cfc mutant)", () => {
		expect(exfilToPublicWriteable.description).toBe(
			"Write/POST to a deterministically-public surface while at Confidential+",
		);
	});

	it("determinism is fully_deterministic (kills b693630b mutant)", () => {
		expect(exfilToPublicWriteable.determinism).toBe("fully_deterministic");
	});
});

describe("githubIssueBodyThenAction — static metadata", () => {
	it("id is the exact non-empty string (kills 055e5e71 mutant)", () => {
		expect(githubIssueBodyThenAction.id).toBe("github_issue_body_then_action");
	});

	it("description is the exact non-empty string (kills 54128b2f mutant)", () => {
		expect(githubIssueBodyThenAction.description).toBe(
			"External network call following a GitHub-CLI fetch of attacker-controllable content",
		);
	});

	it("determinism is fully_deterministic (kills 8b626229 mutant)", () => {
		expect(githubIssueBodyThenAction.determinism).toBe("fully_deterministic");
	});
});

describe("planVsTrajectoryDrift — static metadata", () => {
	it("id is the exact non-empty string (kills 7d891dc7 mutant)", () => {
		expect(planVsTrajectoryDrift.id).toBe("plan_vs_trajectory_drift");
	});

	it("description is the exact non-empty string (kills 657ac3fc mutant)", () => {
		expect(planVsTrajectoryDrift.description).toBe(
			"Candidate diverges from the declared plan AND untrusted content was ingested after capture",
		);
	});

	it("determinism is fully_deterministic (kills a1d746dc mutant)", () => {
		expect(planVsTrajectoryDrift.determinism).toBe("fully_deterministic");
	});
});

describe("INJECTION_DETECTORS array (kills dbbd1127 mutant)", () => {
	it("contains all five detectors in the declared order", () => {
		expect(INJECTION_DETECTORS.length).toBe(5);
		expect(INJECTION_DETECTORS.map((d) => d.id)).toEqual([
			"lethal_trifecta_structural",
			"fetched_external_then_secret_read",
			"exfil_to_public_writeable",
			"github_issue_body_then_action",
			"plan_vs_trajectory_drift",
		]);
	});

	it("is not empty (a bare [] would fail this)", () => {
		expect(INJECTION_DETECTORS).not.toEqual([]);
		expect(INJECTION_DETECTORS.every((d) => typeof d.fn === "function")).toBe(true);
	});
});
