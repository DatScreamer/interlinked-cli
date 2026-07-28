import { describe, expect, it } from "vitest";
import type {
	ContentScanner,
	ContentScannerConfig,
	ContentScanRequest,
	OpfLabel,
	ScanFinding,
	ScanRequest,
} from "../types.js";
import { OPF_LABELS } from "../types.js";

describe("OPF_LABELS", () => {
	it("has eight canonical categories in alphabetical order", () => {
		expect([...OPF_LABELS]).toEqual([
			"account_number",
			"private_address",
			"private_date",
			"private_email",
			"private_person",
			"private_phone",
			"private_url",
			"secret",
		]);
	});

	it("exposes a narrowed type that covers every member", () => {
		// Compile-time check: assigning each tuple entry to OpfLabel must type-check.
		for (const label of OPF_LABELS) {
			const typed: OpfLabel = label;
			expect(typeof typed).toBe("string");
		}
	});
});

describe("type shapes (compile-time sanity)", () => {
	it("ContentScannerConfig accepts the documented default shape", () => {
		const cfg: ContentScannerConfig = {
			enabled: false,
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
				sidecar_script: "/abs/path/opf-sidecar.py",
				startup_timeout_ms: 45_000,
				scan_timeout_ms: 1500,
				idle_shutdown_ms: 1_800_000,
				max_restarts: 3,
			},
			huggingface: {
				model: "openai/gpt-oss-safeguard-20b",
				api_key_env: "HF_TOKEN",
				timeout_ms: 4000,
			},
			custom_http: { endpoint: "", timeout_ms: 4000 },
			min_score: 0,
			max_scan_bytes: 100_000,
		};
		expect(cfg.enabled).toBe(false);
		expect(cfg.runtime).toBe("local");
	});

	it("ScanFinding keeps score optional for providers that omit it", () => {
		const f: ScanFinding = {
			label: "private_email",
			start: 0,
			end: 7,
			text: "a@b.com",
			source: "Test.field",
		};
		expect(f.score).toBeUndefined();
	});

	it("ScanRequest accepts an AbortSignal", () => {
		const controller = new AbortController();
		const req: ScanRequest = { text: "hello", source: "x", signal: controller.signal };
		expect(req.signal?.aborted).toBe(false);
	});

	it("ContentScanRequest accepts all five hook phases", () => {
		const hooks: ContentScanRequest["hook"][] = [
			"pre_write_edit",
			"pre_bash_command",
			"pre_external_egress",
			"post_read_grep",
			"user_prompt",
		];
		expect(hooks).toHaveLength(5);
	});

	it("ContentScanner can be structurally implemented by a stub", () => {
		const stub: ContentScanner = {
			name: "stub",
			runtime: "local",
			ready: async () => true,
			scan: async () => [],
			shutdown: async () => {},
		};
		expect(stub.name).toBe("stub");
	});
});
