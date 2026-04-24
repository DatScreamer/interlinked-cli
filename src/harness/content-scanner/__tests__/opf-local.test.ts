import { describe, expect, it, vi } from "vitest";
import { OpfLocalScanner, type SidecarLike } from "../opf-local.js";
import type { ContentScannerConfig } from "../types.js";

function makeConfig(): ContentScannerConfig {
	return {
		enabled: true,
		runtime: "local",
		scan_points: {
			write_edit: true,
			bash_command: true,
			external_egress: true,
			read_grep_taint: true,
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
	};
}

function makeFakeSidecar(): {
	sidecar: SidecarLike;
	send: ReturnType<typeof vi.fn>;
	shutdown: ReturnType<typeof vi.fn>;
} {
	const send = vi.fn();
	const shutdown = vi.fn().mockResolvedValue(undefined);
	return { sidecar: { send, shutdown }, send, shutdown };
}

describe("OpfLocalScanner", () => {
	it("maps sidecar spans to ScanFindings and stamps the source field", async () => {
		const { sidecar, send } = makeFakeSidecar();
		send.mockResolvedValue({
			ok: true,
			spans: [
				{ label: "private_email", start: 7, end: 24, text: "a@b.com" },
				{ label: "secret", start: 30, end: 42, text: "sk_live_abc" },
			],
			redacted_text: "...",
		});

		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		const findings = await scanner.scan({ text: "hello a@b.com and sk_live_abc", source: "Write.content" });

		expect(findings).toHaveLength(2);
		expect(findings[0]).toMatchObject({
			label: "private_email",
			start: 7,
			end: 24,
			source: "Write.content",
		});
		expect(findings[1].label).toBe("secret");
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ op: "scan", text: expect.any(String) }));
	});

	it("returns [] on ok:false (fail-open)", async () => {
		const { sidecar, send } = makeFakeSidecar();
		send.mockResolvedValue({ ok: false, error: "timeout after 1500ms" });
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		const findings = await scanner.scan({ text: "x", source: "Write.content" });
		expect(findings).toEqual([]);
	});

	it("returns [] when the sidecar response has no spans", async () => {
		const { sidecar, send } = makeFakeSidecar();
		send.mockResolvedValue({ ok: true });
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		const findings = await scanner.scan({ text: "x", source: "Bash.command" });
		expect(findings).toEqual([]);
	});

	it("ready() returns true on a successful ping", async () => {
		const { sidecar, send } = makeFakeSidecar();
		send.mockResolvedValue({ ok: true });
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		expect(await scanner.ready()).toBe(true);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ op: "ping", timeout_ms: 45_000 }),
		);
	});

	it("ready() returns false when the sidecar fails to respond", async () => {
		const { sidecar, send } = makeFakeSidecar();
		send.mockResolvedValue({ ok: false, error: "spawn failed" });
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		expect(await scanner.ready()).toBe(false);
	});

	it("forwards the AbortSignal to the sidecar", async () => {
		const { sidecar, send } = makeFakeSidecar();
		send.mockResolvedValue({ ok: true, spans: [] });
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		const controller = new AbortController();
		await scanner.scan({ text: "x", source: "s", signal: controller.signal });
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ signal: controller.signal }),
		);
	});

	it("shutdown() delegates to the sidecar", async () => {
		const { sidecar, shutdown } = makeFakeSidecar();
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		await scanner.shutdown();
		expect(shutdown).toHaveBeenCalledOnce();
	});
});
