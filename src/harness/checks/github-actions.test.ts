import { describe, expect, it } from "vitest";

import { checkGithubActionsInjection } from "./github-actions.js";

const WORKFLOW = ".github/workflows/ci.yml";
const WORKFLOW_YAML = ".github/workflows/release.yaml";

describe("checkGithubActionsInjection — positive cases (matches dangerous interpolations)", () => {
	it("flags github.event.issue.title in a run: block", () => {
		const yaml = `name: build
on: [issues]
jobs:
  log:
    runs-on: ubuntu-latest
    steps:
      - run: echo "Title is \${{ github.event.issue.title }}"
`;
		expect(checkGithubActionsInjection(yaml, WORKFLOW).length).toBeGreaterThan(0);
	});

	it("flags github.event.pull_request.body", () => {
		const yaml = `jobs:
  x:
    steps:
      - run: |
          echo "\${{ github.event.pull_request.body }}"
`;
		expect(checkGithubActionsInjection(yaml, WORKFLOW).length).toBeGreaterThan(0);
	});

	it("flags github.event.head_commit.message", () => {
		const yaml = `steps:
  - run: echo "\${{ github.event.head_commit.message }}"
`;
		expect(checkGithubActionsInjection(yaml, WORKFLOW).length).toBeGreaterThan(0);
	});

	it("flags github.head_ref", () => {
		const yaml = `steps:
  - run: git checkout \${{ github.head_ref }}
`;
		expect(checkGithubActionsInjection(yaml, WORKFLOW).length).toBeGreaterThan(0);
	});

	it("flags arbitrary client_payload subpath (repository_dispatch attacker-controlled bag)", () => {
		const yaml = `steps:
  - run: echo "\${{ github.event.client_payload.malicious_field }}"
`;
		expect(checkGithubActionsInjection(yaml, WORKFLOW_YAML).length).toBeGreaterThan(0);
	});
});

describe("checkGithubActionsInjection — negative cases (does NOT fire on safe shapes)", () => {
	it("does not fire on the safe env: indirection pattern (still flags expression site)", () => {
		// The env: line itself still contains the dangerous expression — flagging
		// here is correct (the expression IS the attacker-controlled value);
		// the safety comes from how the env var is then *used* in `run:`. This
		// case lives in the negative section to document the intentional split:
		// detection is at the interpolation site, not the run: site.
		// Confirm a single match (the env: line), not two.
		const yaml = `jobs:
  x:
    steps:
      - env:
          TITLE: \${{ github.event.pull_request.title }}
        run: echo "$TITLE"
`;
		const matches = checkGithubActionsInjection(yaml, WORKFLOW);
		expect(matches.length).toBe(1);
	});

	it("does not fire on github.event.repository.name (safe — repo-owner-controlled)", () => {
		const yaml = `steps:
  - run: echo "\${{ github.event.repository.name }}"
`;
		expect(checkGithubActionsInjection(yaml, WORKFLOW)).toEqual([]);
	});

	it("does not fire on github.actor (safe — sanitized by GitHub)", () => {
		const yaml = `steps:
  - run: echo "\${{ github.actor }}"
`;
		expect(checkGithubActionsInjection(yaml, WORKFLOW)).toEqual([]);
	});

	it("does not fire on a .yml file outside .github/workflows/", () => {
		const yaml = `key: \${{ github.event.issue.title }}`;
		expect(checkGithubActionsInjection(yaml, "config/app.yml")).toEqual([]);
	});

	it("does not fire on non-YAML extensions inside .github/", () => {
		const content = `\${{ github.event.issue.title }}`;
		expect(checkGithubActionsInjection(content, ".github/workflows/README.md")).toEqual([]);
	});

	it("does not fire on test fixtures even at the workflow path", () => {
		const yaml = `steps:
  - run: echo "\${{ github.event.issue.title }}"
`;
		expect(
			checkGithubActionsInjection(yaml, ".github/workflows/__tests__/example.test.yml"),
		).toEqual([]);
	});
});
