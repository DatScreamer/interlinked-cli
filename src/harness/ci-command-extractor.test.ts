// Extractors pull executable command text out of CI/build files so the
// recurrence scanner can run the same destructive-command guard rules over
// commands that never pass through a PreToolUse hook (they run in CI, not in
// an agent session). A gap surfaced by the destructive_command_guard intake
// (their `dcg scan` walks workflow YAML / Dockerfiles); see
// docs/external-pulse/destructive-command-guard.md.

import { describe, expect, it } from "vitest";
import {
	extractCICommands,
	extractDockerfileCommands,
	extractMakefileCommands,
	extractWorkflowCommands,
	isCIFile,
} from "./ci-command-extractor.js";

describe("isCIFile", () => {
	it("classifies GitHub workflow files", () => {
		expect(isCIFile(".github/workflows/ci.yml")).toBe("workflow");
		expect(isCIFile(".github/workflows/release.yaml")).toBe("workflow");
	});
	it("classifies Dockerfiles in any common shape", () => {
		expect(isCIFile("Dockerfile")).toBe("dockerfile");
		expect(isCIFile("docker/api.Dockerfile")).toBe("dockerfile");
		expect(isCIFile("Dockerfile.prod")).toBe("dockerfile");
	});
	it("classifies Makefiles", () => {
		expect(isCIFile("Makefile")).toBe("makefile");
		expect(isCIFile("build/tasks.mk")).toBe("makefile");
	});
	it("returns null for non-CI files and plain YAML", () => {
		expect(isCIFile("src/index.ts")).toBe(null);
		expect(isCIFile("config/app.yml")).toBe(null);
		expect(isCIFile("docker-compose.yml")).toBe(null);
	});
});

describe("extractWorkflowCommands", () => {
	it("extracts an inline run:", () => {
		const yaml = ["steps:", "  - run: rm -rf /tmp/cache"].join("\n");
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]?.command).toBe("rm -rf /tmp/cache");
		expect(cmds[0]?.line).toBe(2);
	});

	it("extracts a literal block scalar (run: |) as one joined script", () => {
		const yaml = [
			"steps:",
			"  - name: build",
			"    run: |",
			"      npm ci",
			"      rm -rf dist",
			"  - run: echo done",
		].join("\n");
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds).toHaveLength(2);
		expect(cmds[0]?.command).toBe("npm ci\nrm -rf dist");
		expect(cmds[0]?.line).toBe(3);
		expect(cmds[1]?.command).toBe("echo done");
	});

	it("handles a folded block scalar (run: >) and chomping indicators", () => {
		const yaml = ["    run: >-", "      git push", "      --force origin main"].join("\n");
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]?.command).toContain("git push");
		expect(cmds[0]?.command).toContain("--force");
	});

	it("does not treat a later same-indent key as block body", () => {
		const yaml = ["    run: |", "      make build", "    env:", "      X: 1"].join("\n");
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds[0]?.command).toBe("make build");
	});

	it("strips surrounding quotes on an inline command", () => {
		const yaml = ['  - run: "rm -rf /tmp/x"'].join("\n");
		expect(extractWorkflowCommands(yaml)[0]?.command).toBe("rm -rf /tmp/x");
	});

	it("preserves a blank line inside a block scalar body", () => {
		const yaml = ["    run: |", "      npm ci", "", "      rm -rf dist", "    env:"].join("\n");
		const cmds = extractWorkflowCommands(yaml);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]?.command).toBe("npm ci\n\nrm -rf dist");
	});
});

describe("extractDockerfileCommands", () => {
	it("extracts a shell-form RUN", () => {
		const df = ["FROM node:20", "RUN rm -rf /var/lib/apt/lists/*"].join("\n");
		const cmds = extractDockerfileCommands(df);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]?.command).toBe("rm -rf /var/lib/apt/lists/*");
		expect(cmds[0]?.line).toBe(2);
	});

	it("joins backslash line continuations", () => {
		const df = ["RUN apt-get update \\", "    && rm -rf /etc/secret"].join("\n");
		const cmds = extractDockerfileCommands(df);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]?.command).toBe("apt-get update && rm -rf /etc/secret");
	});

	it("handles the JSON-array exec form", () => {
		const df = 'RUN ["rm", "-rf", "/data"]';
		const cmds = extractDockerfileCommands(df);
		expect(cmds[0]?.command).toBe("rm -rf /data");
	});

	it("is case-insensitive on the RUN instruction", () => {
		const df = "run echo hi";
		expect(extractDockerfileCommands(df)[0]?.command).toBe("echo hi");
	});

	it("falls back to shell form when a bracketed RUN is not valid JSON", () => {
		const df = "RUN [not, valid, json]";
		expect(extractDockerfileCommands(df)[0]?.command).toBe("[not, valid, json]");
	});

	it("ignores non-RUN instructions", () => {
		const df = ["FROM x", "COPY . .", "ENV A=1"].join("\n");
		expect(extractDockerfileCommands(df)).toHaveLength(0);
	});
});

describe("extractMakefileCommands", () => {
	it("extracts tab-indented recipe lines and strips @/-/+ prefixes", () => {
		const mk = ["clean:", "\trm -rf dist", "\t@echo done", "\t-rm -f tmp"].join("\n");
		const cmds = extractMakefileCommands(mk);
		expect(cmds.map((c) => c.command)).toEqual(["rm -rf dist", "echo done", "rm -f tmp"]);
	});

	it("does not treat non-tab lines (targets, variables) as recipes", () => {
		const mk = ["VAR = 1", "build: dep", "\tnpm run build"].join("\n");
		const cmds = extractMakefileCommands(mk);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]?.command).toBe("npm run build");
	});

	it("joins backslash continuations in a recipe", () => {
		const mk = ["wipe:", "\trm -rf a \\", "\t  b c"].join("\n");
		const cmds = extractMakefileCommands(mk);
		expect(cmds[0]?.command).toBe("rm -rf a b c");
	});
});

describe("extractCICommands dispatch", () => {
	it("routes by file type", () => {
		expect(extractCICommands(".github/workflows/x.yml", "  - run: rm -rf /tmp/z")).toHaveLength(1);
		expect(extractCICommands("Dockerfile", "RUN echo hi")).toHaveLength(1);
		expect(extractCICommands("Makefile", "t:\n\techo hi")).toHaveLength(1);
		expect(extractCICommands("src/x.ts", "const x = 1")).toHaveLength(0);
	});
});
