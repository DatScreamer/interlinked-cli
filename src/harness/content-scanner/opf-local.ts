// ===========================================
// Content Scanner — Local OPF backend
// ===========================================
//
// Wraps `SidecarManager` as a `ContentScanner`. Translates OPF's span shape
// (label / start / end / text) into the scanner's `ScanFinding` shape and
// stamps each finding with the originating source field so the policy layer
// can group findings across multiple scan parts from the same event.

import { SidecarManager, type SidecarStatus } from "./sidecar-manager.js";
import { SidecarPool } from "./sidecar-pool.js";
import type {
	ContentScanner,
	ContentScannerConfig,
	ScanFinding,
	ScannerStatus,
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
	/** Optional — only real `SidecarManager` exposes lifecycle; test fakes don't have to. */
	getStatus?(): SidecarStatus;
}

/** Map the sidecar's internal state enum to the public scanner state. */
function projectStatus(s: SidecarStatus): ScannerStatus {
	const state: ScannerStatus["state"] = s.state === "spawning" ? "starting" : s.state;
	return { state, pid: s.pid, detail: s.detail, sinceIso: s.sinceIso };
}

/**
 * Translate the local-runtime config block into the CLI arg list the OPF
 * Python sidecar expects at startup. Returns `undefined` when no flags are
 * needed so the spawn line stays bit-identical to the pre-calibration
 * behavior (avoids spurious snapshot churn in spawn-tracing tests).
 *
 * Exported for unit testing and to give callers a stable seam for stubbing
 * the calibration plumbing without standing up a real `OpfLocalScanner`.
 */
export function deriveSidecarScriptArgs(
	local: ContentScannerConfig["local"],
): readonly string[] | undefined {
	if (!local.viterbi_calibration_path) return undefined;
	return ["--viterbi-calibration-path", local.viterbi_calibration_path];
}

export class OpfLocalScanner implements ContentScanner {
	readonly name = "opf-local";
	readonly runtime = "local" as const;
	private readonly sidecar: SidecarLike;
	private statusListeners: Array<(status: ScannerStatus) => void> = [];
	private lastStatus: ScannerStatus = {
		state: "idle",
		sinceIso: new Date().toISOString(),
	};

	constructor(private readonly config: ContentScannerConfig, sidecar?: SidecarLike) {
		// Pool size defaults to 3: we've tested 1/2/3 and 3 handles ~8 concurrent
		// Claude sessions without the 1.5 s scan budget aborting. Configurable
		// via guard-rules.local.json → content_scanner.local.pool_size.
		const poolSize = config.local.pool_size ?? 3;
		const scriptArgs = deriveSidecarScriptArgs(config.local);
		const poolOpts = {
			python_bin: config.local.python_bin,
			script_path: config.local.sidecar_script,
			script_args: scriptArgs,
			startup_timeout_ms: config.local.startup_timeout_ms,
			scan_timeout_ms: config.local.scan_timeout_ms,
			idle_shutdown_ms: config.local.idle_shutdown_ms,
			max_restarts: config.local.max_restarts,
			onStatusChange: (s: SidecarStatus) => {
				this.lastStatus = projectStatus(s);
				for (const cb of this.statusListeners) {
					try {
						cb(this.lastStatus);
					} catch {
						// best-effort — never let a listener take down the scanner
					}
				}
			},
		};
		// Degenerate pool_size=1 uses the bare SidecarManager so we don't pay
		// the wrapper's indirection when nobody wants concurrency.
		this.sidecar =
			sidecar ??
			(poolSize > 1
				? new SidecarPool({ ...poolOpts, pool_size: poolSize })
				: new SidecarManager(poolOpts));
		// If an external sidecar was injected (test fake), seed status from it if possible.
		if (sidecar?.getStatus) this.lastStatus = projectStatus(sidecar.getStatus());
	}

	onStatusChange(cb: (status: ScannerStatus) => void): void {
		this.statusListeners.push(cb);
		// Fire immediately so the subscriber sees the current state without
		// having to wait for the next transition.
		try {
			cb(this.lastStatus);
		} catch {
			// best-effort
		}
	}

	getStatus(): ScannerStatus {
		return this.lastStatus;
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
