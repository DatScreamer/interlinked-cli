// ===========================================
// Content Scanner — Local OPF backend
// ===========================================
//
// Wraps `SidecarManager` as a `ContentScanner`. Translates OPF's span shape
// (label / start / end / text) into the scanner's `ScanFinding` shape and
// stamps each finding with the originating source field so the policy layer
// can group findings across multiple scan parts from the same event.

import { SidecarManager } from "./sidecar-manager.js";
import type {
	ContentScanner,
	ContentScannerConfig,
	ScanFinding,
	ScanRequest,
} from "./types.js";

/** Minimal interface the local scanner needs from its sidecar. Extracted so
 *  tests can inject a fake without dragging in the whole `SidecarManager`. */
export interface SidecarLike {
	send(req: {
		op: "ping" | "scan" | "shutdown";
		text?: string;
		signal?: AbortSignal;
		timeout_ms?: number;
	}): Promise<{
		ok: boolean;
		error?: string;
		spans?: Array<{ label: string; start: number; end: number; text: string; score?: number }>;
		redacted_text?: string;
	}>;
	shutdown(): Promise<void>;
}

export class OpfLocalScanner implements ContentScanner {
	readonly name = "opf-local";
	readonly runtime = "local" as const;
	private readonly sidecar: SidecarLike;

	constructor(private readonly config: ContentScannerConfig, sidecar?: SidecarLike) {
		this.sidecar =
			sidecar ??
			new SidecarManager({
				python_bin: config.local.python_bin,
				script_path: config.local.sidecar_script,
				startup_timeout_ms: config.local.startup_timeout_ms,
				scan_timeout_ms: config.local.scan_timeout_ms,
				idle_shutdown_ms: config.local.idle_shutdown_ms,
				max_restarts: config.local.max_restarts,
			});
	}

	async ready(): Promise<boolean> {
		const r = await this.sidecar.send({
			op: "ping",
			timeout_ms: this.config.local.startup_timeout_ms,
		});
		return r.ok;
	}

	async scan(req: ScanRequest): Promise<ScanFinding[]> {
		const r = await this.sidecar.send({
			op: "scan",
			text: req.text,
			signal: req.signal,
		});
		if (!r.ok) {
			// Fail-open but noisy: surface sidecar errors so operators see timeouts
			// and shape config accordingly. Empty findings (ok: true, spans: [])
			// stay silent — that's a real "no PII" result.
			process.stderr.write(
				`[interlinked:opf-local] sidecar error on ${req.source} (${req.text.length} chars): ${r.error ?? "unknown"}\n`,
			);
			return [];
		}
		if (!r.spans) return [];
		return r.spans.map((s) => ({
			label: s.label,
			start: s.start,
			end: s.end,
			text: s.text,
			score: s.score,
			source: req.source,
		}));
	}

	async shutdown(): Promise<void> {
		await this.sidecar.shutdown();
	}
}
