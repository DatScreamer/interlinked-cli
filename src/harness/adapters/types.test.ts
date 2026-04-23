import { describe, expect, it } from "vitest";
import type {
	AdapterOutput,
	InstallerManifestEntry,
	MergeStrategy,
	RunnerAdapter,
	SettingsFragment,
} from "./types.js";

// These are type-only contracts; the tests here verify the interface shape by
// constructing a minimal no-op adapter and poking its public surface. If the
// interface drifts, the type-checker catches it; the runtime assertions just
// keep coverage honest.

describe("RunnerAdapter contract", () => {
	it("allows a minimal conformant implementation", () => {
		const fragment: SettingsFragment = {
			path: "~/.fake/settings.json",
			fragment: {},
			mergeStrategy: "deep-merge",
		};
		const output: AdapterOutput = { stdout: "", stderr: "", exit_code: 0 };
		const adapter: RunnerAdapter = {
			id: "unknown",
			label: "Fake",
			experimental: true,
			nativeEventNames: ["Fake"],
			detectFromEnv: () => false,
			parseHookInput: () => ({
				schema_version: "1",
				event_id: "evt-t",
				session_id: "s",
				ts: "2026-04-23T00:00:00.000Z",
				runner: "unknown",
				runner_native_event: "Fake",
				phase: "other",
				action: { kind: "other", subkind: "noop", data: null },
				context: { cwd: "/" },
				raw: {},
			}),
			classifyToolClass: () => "unknown",
			renderSettingsFragment: () => fragment,
			encodeDecision: () => output,
		};
		expect(adapter.id).toBe("unknown");
		expect(adapter.nativeEventNames).toContain("Fake");
		expect(adapter.detectFromEnv(process.env)).toBe(false);
	});

	it("accepts all three merge strategies", () => {
		const strategies: MergeStrategy[] = ["deep-merge", "array-append", "replace-key"];
		for (const s of strategies) {
			const f: SettingsFragment = { path: "/p", fragment: {}, mergeStrategy: s };
			expect(f.mergeStrategy).toBe(s);
		}
	});

	it("InstallerManifestEntry captures required fields", () => {
		const entry: InstallerManifestEntry = {
			runner: "claude-code",
			scope: "project",
			settings_path: ".claude/settings.json",
			added_paths: ["/hooks/PreToolUse/0"],
			binary_path: "/usr/local/bin/interlinked-hook",
			installed_at: "2026-04-23T00:00:00.000Z",
			schema_version: "1",
		};
		expect(entry.runner).toBe("claude-code");
		expect(entry.scope).toBe("project");
		expect(entry.added_paths.length).toBe(1);
	});
});
