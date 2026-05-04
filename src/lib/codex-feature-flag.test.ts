import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureCodexFeatureFlag } from "./codex-feature-flag.js";

describe("ensureCodexFeatureFlag", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "codex-flag-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("creates .codex/config.toml with the feature flag when none exists", () => {
		const result = ensureCodexFeatureFlag(tmp);
		expect(result).toBe("created");
		const tomlPath = join(tmp, ".codex", "config.toml");
		expect(existsSync(tomlPath)).toBe(true);
		const toml = readFileSync(tomlPath, "utf-8");
		expect(toml).toMatch(/\[features\]/);
		expect(toml).toMatch(/codex_hooks\s*=\s*true/);
	});

	it("preserves an existing config that already enables codex_hooks", () => {
		const tomlPath = join(tmp, ".codex", "config.toml");
		const existing = "# user-managed\n[features]\ncodex_hooks = true\nfoo = 42\n";
		mkdirSync(join(tmp, ".codex"), { recursive: true });
		writeFileSync(tomlPath, existing);

		const result = ensureCodexFeatureFlag(tmp);
		expect(result).toBe("preserved");
		expect(readFileSync(tomlPath, "utf-8")).toBe(existing);
	});

	it("appends [features] when the flag is missing from an existing config", () => {
		const tomlPath = join(tmp, ".codex", "config.toml");
		const existing = '[model]\nname = "synthetic-model-v5"\n';
		mkdirSync(join(tmp, ".codex"), { recursive: true });
		writeFileSync(tomlPath, existing);

		const result = ensureCodexFeatureFlag(tmp);
		expect(result).toBe("appended");
		const toml = readFileSync(tomlPath, "utf-8");
		expect(toml).toContain("[model]");
		expect(toml).toMatch(/codex_hooks\s*=\s*true/);
	});

	it("adds the flag inside an existing [features] block instead of duplicating it", () => {
		const tomlPath = join(tmp, ".codex", "config.toml");
		const existing = '[model]\nname = "synthetic-model-v5"\n\n[features]\nfoo = true\n[profiles.default]\napproval_policy = "never"\n';
		mkdirSync(join(tmp, ".codex"), { recursive: true });
		writeFileSync(tomlPath, existing);

		const result = ensureCodexFeatureFlag(tmp);
		expect(result).toBe("appended");
		const toml = readFileSync(tomlPath, "utf-8");
		expect((toml.match(/\[features\]/g) || []).length).toBe(1);
		expect(toml).toContain("[features]\nfoo = true\ncodex_hooks = true\n[profiles.default]");
	});

	it("ignores a commented-out flag and treats the file as missing the flag", () => {
		// A `# codex_hooks = true` line is documentation, not enablement.
		// We must still append a real flag so hooks actually fire.
		const tomlPath = join(tmp, ".codex", "config.toml");
		const existing = "# codex_hooks = true\n[model]\nname = \"synthetic-model-v5\"\n";
		mkdirSync(join(tmp, ".codex"), { recursive: true });
		writeFileSync(tomlPath, existing);

		const result = ensureCodexFeatureFlag(tmp);
		expect(result).toBe("appended");
		const toml = readFileSync(tomlPath, "utf-8");
		expect(toml).toMatch(/^codex_hooks\s*=\s*true$/m);
	});

	it("creates the .codex directory if absent", () => {
		// The base dir might not even have a .codex folder yet (first-time
		// install). The helper must mkdirSync it.
		expect(existsSync(join(tmp, ".codex"))).toBe(false);
		ensureCodexFeatureFlag(tmp);
		expect(existsSync(join(tmp, ".codex"))).toBe(true);
	});
});
