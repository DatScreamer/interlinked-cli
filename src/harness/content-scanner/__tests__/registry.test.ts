// ===========================================
// Registry tests — backend factory + disabled-labels wrapper
// ===========================================

import { describe, expect, it, vi } from "vitest";
import { createScanner, wrapWithDisabledLabels } from "../registry.js";
import type {
	ContentScanner,
	ContentScannerConfig,
	ScanFinding,
	ScannerStatus,
} from "../types.js";

function makeConfig(overrides: Partial<ContentScannerConfig> = {}): ContentScannerConfig {
	return {
		enabled: true,
		runtime: "local",
		scan_points: {
			write_edit: true,
			bash_command: true,
			external_egress: true,
			read_grep_taint: true,
			user_prompt: true,
		},
		local: {
			python_bin: "python3",
			sidecar_script: "/tmp/opf.py",
			startup_timeout_ms: 45_000,
			scan_timeout_ms: 1500,
			idle_shutdown_ms: 1_800_000,
			max_restarts: 3,
		},
		huggingface: { model: "x", api_key_env: "HF_TOKEN", timeout_ms: 4000 },
		custom_http: { endpoint: "", timeout_ms: 4000 },
		min_score: 0,
		max_scan_bytes: 100_000,
		...overrides,
	};
}

function makeFakeBackend(spans: ScanFinding[]): {
	backend: ContentScanner;
	scan: ReturnType<typeof vi.fn>;
} {
	const scan = vi.fn().mockResolvedValue(spans);
	// Hardcoded ISO timestamp — tests must be deterministic; real Date.now()
	// would make this fixture flake under snapshot diffs and fake-timer setups.
	const status: ScannerStatus = { state: "ready", sinceIso: "2026-04-25T00:00:00.000Z" };
	const backend: ContentScanner = {
		name: "fake",
		runtime: "local",
		ready: vi.fn().mockResolvedValue(true),
		scan,
		shutdown: vi.fn().mockResolvedValue(undefined),
		getStatus: () => status,
		onStatusChange: vi.fn(),
	};
	return { backend, scan };
}

describe("createScanner", () => {
	it("returns undefined when content scanning is disabled", () => {
		expect(createScanner(makeConfig({ enabled: false }))).toBeUndefined();
	});

	it("returns undefined for an unknown runtime", () => {
		// Cast through unknown — the union type would otherwise reject the bad
		// value. Tests the runtime defensive switch, not the static check.
		const bad = makeConfig({
			runtime: "made_up" as unknown as ContentScannerConfig["runtime"],
		});
		expect(createScanner(bad)).toBeUndefined();
	});
});

describe("wrapWithDisabledLabels", () => {
	const findings: ScanFinding[] = [
		{ label: "private_email", start: 0, end: 7, text: "a@b.com", source: "Write.content" },
		{ label: "private_url", start: 10, end: 25, text: "src/foo/bar.ts", source: "Write.content" },
		{
			label: "private_person",
			start: 30,
			end: 35,
			text: "Alice",
			source: "Write.content",
		},
	];

	it("returns the backend unchanged when disabledLabels is undefined", async () => {
		const { backend, scan } = makeFakeBackend(findings);
		const wrapped = wrapWithDisabledLabels(backend, undefined);
		// Identity: no wrapping work was done.
		expect(wrapped).toBe(backend);
		await wrapped.scan({ text: "x", source: "Write.content" });
		expect(scan).toHaveBeenCalledOnce();
	});

	it("returns the backend unchanged when disabledLabels is empty", async () => {
		const { backend } = makeFakeBackend(findings);
		const wrapped = wrapWithDisabledLabels(backend, []);
		expect(wrapped).toBe(backend);
	});

	it("drops findings whose label is in disabledLabels", async () => {
		const { backend } = makeFakeBackend(findings);
		const wrapped = wrapWithDisabledLabels(backend, ["private_url"]);
		const out = await wrapped.scan({ text: "x", source: "Write.content" });
		expect(out.map((f) => f.label)).toEqual(["private_email", "private_person"]);
	});

	it("drops multiple categories at once", async () => {
		const { backend } = makeFakeBackend(findings);
		const wrapped = wrapWithDisabledLabels(backend, ["private_url", "private_email"]);
		const out = await wrapped.scan({ text: "x", source: "Write.content" });
		expect(out.map((f) => f.label)).toEqual(["private_person"]);
	});

	it("preserves backend identity for ready / shutdown / status hooks", async () => {
		const { backend } = makeFakeBackend(findings);
		const wrapped = wrapWithDisabledLabels(backend, ["private_url"]);
		expect(wrapped.name).toBe(backend.name);
		expect(wrapped.runtime).toBe(backend.runtime);
		await expect(wrapped.ready()).resolves.toBe(true);
		await wrapped.shutdown();
		expect(backend.shutdown).toHaveBeenCalledOnce();
		// getStatus should pass through.
		const status = wrapped.getStatus?.();
		expect(status?.state).toBe("ready");
	});

	it("returns an empty array when every finding is disabled", async () => {
		const { backend } = makeFakeBackend(findings);
		const wrapped = wrapWithDisabledLabels(backend, [
			"private_email",
			"private_url",
			"private_person",
		]);
		const out = await wrapped.scan({ text: "x", source: "Write.content" });
		expect(out).toEqual([]);
	});
});

