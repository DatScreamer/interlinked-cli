// ===========================================
// Content Scanner — Types
// ===========================================
//
// ML-based PII/secret detection that runs against tool-call content at
// PreToolUse (Write/Edit bodies, Bash commands, external-egress args) and
// PostToolUse (Read/Grep results → taint ratchet).
//
// The shape is deliberately *detector-oriented*: a scanner emits structured
// findings (label + span + score) and the policy module maps findings to a
// block/allow decision. This is distinct from the existing generative
// policy-classifier, which emits free-form verdicts.

/**
 * Canonical OPF label taxonomy. Pinned here so tests and docs agree; the
 * freshness test (content-scanner/__tests__/policy.test.ts) asserts this
 * matches the labels defined in `reference-repos/privacy-filter/opf/_common/
 * label_space.py` if that reference tree is present.
 */
export const OPF_LABELS = [
	"account_number",
	"private_address",
	"private_date",
	"private_email",
	"private_person",
	"private_phone",
	"private_url",
	"secret",
] as const;

export type OpfLabel = (typeof OPF_LABELS)[number];

/** Which backend actually answers scan requests. */
export type ContentScannerRuntime = "local" | "huggingface" | "custom_http";

/**
 * Configuration for the ML content scanner. Opt-in via `enabled: true` in
 * `.interlinked/guard-rules.local.json`. Disabled by default because the
 * local runtime needs a Python prereq (`pip install opf`).
 */
export interface ContentScannerConfig {
	/** Master switch. Default: false. */
	enabled: boolean;

	/** Which backend to use. Default: "local". */
	runtime: ContentScannerRuntime;

	/** Per-hook toggles so operators can enable a subset without losing the others. */
	scan_points: {
		/** PreToolUse — Write/Edit/MultiEdit/NotebookEdit/str_replace. */
		write_edit: boolean;
		/** PreToolUse — Bash command body. */
		bash_command: boolean;
		/** PreToolUse — WebFetch URL/prompt, curl/wget external, MCP external args. */
		external_egress: boolean;
		/** PostToolUse — Read/Grep results → taint ratchet (no block). */
		read_grep_taint: boolean;
		/** UserPromptSubmit — mask PII in the user's prompt before it's persisted
		 *  to activity.jsonl. Never blocks the prompt; redacts the recorded copy. */
		user_prompt: boolean;
	};

	/** Local Python sidecar knobs. */
	local: {
		/** `python3` by default. Override with a venv python if needed. */
		python_bin: string;
		/** Absolute path to the shipped sidecar script. Resolved at runtime. */
		sidecar_script: string;
		/** First scan may include multi-second model load. Default: 45000. */
		startup_timeout_ms: number;
		/** Warm scan timeout. Default: 1500 — under the 1 s decision budget with margin. */
		scan_timeout_ms: number;
		/** Shut sidecar down after this idle period to reclaim RAM. Default: 1_800_000 (30 min). */
		idle_shutdown_ms: number;
		/** Cap on crash respawns per session. Default: 3. */
		max_restarts: number;
		/** Number of sidecar processes to run behind a round-robin pool.
		 *  Default: 3. Each sidecar is single-threaded (Python), so N children
		 *  give N× concurrency for parallel scan requests from multiple
		 *  sessions. Children spawn lazily — pool_size is a MAX, not a MIN.
		 *  Optional for backward compatibility — callers that omit it fall
		 *  back to the default inside OpfLocalScanner. */
		pool_size?: number;
	};

	/** HuggingFace Inference API knobs (for gpt-oss-safeguard and future models). */
	huggingface: {
		/** Default: "openai/gpt-oss-safeguard-20b". NOT `openai/privacy-filter` — that model requires trust_remote_code. */
		model: string;
		/** Env var name holding the HF token. Default: "HF_TOKEN". */
		api_key_env: string;
		/** Default: 4000. */
		timeout_ms: number;
	};

	/** Generic HTTP backend — any OpenAI/HF-compatible token-classification endpoint. */
	custom_http: {
		endpoint: string;
		api_key_env?: string;
		timeout_ms: number;
	};

	/** Minimum score to count a finding. Default: 0 (every span blocks). */
	min_score: number;

	/** Per-scan byte cap. Default: reuse `rules.output_scanning.max_scan_bytes` (100_000). */
	max_scan_bytes: number;

	/**
	 * Allowlist applied AFTER the model emits findings, BEFORE the policy decides.
	 * Matching findings are dropped silently. Use it to suppress known false
	 * positives — `noreply@*`, `*@example.com`, snake_case identifiers misread
	 * as private_person, etc.
	 *
	 * Each entry is checked against the finding's `text` (the raw matched
	 * substring). If `label` is set, the entry only applies to findings of
	 * that category — so `noreply@anthropic.com` allowlisted as
	 * `private_email` won't accidentally allowlist a string that happens to
	 * match if the model later labels it as `secret`.
	 *
	 * Two-tier: defaults ship in DEFAULT_CONFIG; user additions go in
	 * `.interlinked/guard-rules.json` (team) and `.interlinked/guard-rules.local.json`
	 * (personal, gitignored). Merged additively — locals append, never replace.
	 */
	allowlist?: AllowlistEntry[];
}

/**
 * A pattern that drops a finding when matched. The supported kinds form a
 * fixed catalog — user-supplied regex would create a ReDoS surface, and the
 * cases we actually need (exact match, prefix/suffix/contains, email domain,
 * common identifier shapes) all map to constant-cost string operations or
 * hardcoded regex literals.
 *
 *   - exact:                  text === pattern  (case-sensitive)
 *   - prefix:                 text.toLowerCase().startsWith(pattern.toLowerCase())
 *   - suffix:                 text.toLowerCase().endsWith(pattern.toLowerCase())
 *   - contains:               text.toLowerCase().includes(pattern.toLowerCase())
 *   - email_domain:           text matches *@<pattern> case-insensitively
 *   - snake_case_identifier:  text is a snake_case identifier (no pattern arg)
 *   - uuid:                   text is a UUID v1–v5 (no pattern arg)
 *
 * For requests that none of the above cover, file an issue rather than
 * extending this with arbitrary regex — keeping the surface narrow makes
 * audit and ReDoS-safety trivial.
 */
export type AllowlistEntry =
	| { kind: "exact"; pattern: string; label?: string; reason?: string }
	| { kind: "prefix"; pattern: string; label?: string; reason?: string }
	| { kind: "suffix"; pattern: string; label?: string; reason?: string }
	| { kind: "contains"; pattern: string; label?: string; reason?: string }
	| { kind: "email_domain"; pattern: string; label?: string; reason?: string }
	| { kind: "snake_case_identifier"; label?: string; reason?: string }
	| { kind: "uuid"; label?: string; reason?: string };

/**
 * A single detected span emitted by a scanner. `text` is kept for internal
 * logging and taint attribution but is NEVER echoed in a block reason — doing
 * so would leak the redacted content back to the agent.
 */
export interface ScanFinding {
	/** Category label. For OPF, one of `OPF_LABELS`. Other scanners may emit custom labels. */
	label: string;
	/** Character offset of the span start within the scanned text. */
	start: number;
	/** Character offset of the span end (exclusive). */
	end: number;
	/** The matched substring. Internal use only — NOT surfaced to the agent. */
	text: string;
	/** Confidence 0..1 when the provider supplies it. OPF local omits this. */
	score?: number;
	/** Echoes the originating ScanRequest.source so findings can be grouped by tool field. */
	source: string;
}

/** Input to a single scanner call. */
export interface ScanRequest {
	text: string;
	/** Logical origin of the text (e.g., "Write.content", "Bash.command"). */
	source: string;
	/** Honors caller-side deadlines so hook response stays within budget. */
	signal?: AbortSignal;
}

/**
 * Backend-agnostic lifecycle snapshot surfaced to the harness so the statusline
 * and `harness status` can show whether the scanner is actually running.
 *
 * State machine:
 *   - idle        never attempted a scan yet (initial)
 *   - starting    spawn kicked off / first request in flight
 *   - ready       backend served at least one successful response
 *   - dormant     transient close (idle-timer, recoverable crash) — will re-spawn
 *   - disabled    permanent (explicit shutdown or restart-budget exhausted)
 */
export type ScannerState = "idle" | "starting" | "ready" | "dormant" | "disabled";

export interface ScannerStatus {
	state: ScannerState;
	/** Populated for backends that run an OS process (local sidecar). */
	pid?: number;
	/** Short human-readable context ("exceeded max_restarts", "child exited (code=1)"). */
	detail?: string;
	/** ISO timestamp of the last transition into `state`. */
	sinceIso: string;
}

/**
 * Uniform interface all backends implement. `ready()` is a cheap probe
 * (ping the sidecar, HEAD the endpoint) — it MAY cause a lazy spawn for
 * the local backend but must return within the configured timeout.
 */
export interface ContentScanner {
	/** Human-readable identifier, e.g. "opf-local", "hf:gpt-oss-safeguard-20b". */
	name: string;
	runtime: "local" | "http";
	ready(): Promise<boolean>;
	scan(req: ScanRequest): Promise<ScanFinding[]>;
	shutdown(): Promise<void>;
	/**
	 * Register a callback fired on every lifecycle transition. Optional —
	 * backends that don't model lifecycle (e.g., stateless HTTP) may omit this.
	 * The harness uses it to write `.interlinked/content-scanner.status`.
	 */
	onStatusChange?(cb: (status: ScannerStatus) => void): void;
	/** Read the current lifecycle snapshot. Optional for the same reason. */
	getStatus?(): ScannerStatus;
}

/**
 * Bundle of scannable-text fragments derived from a single HarnessEvent.
 * Built synchronously in the evaluator; the async scan happens in server.ts.
 */
export interface ContentScanRequest {
	/** Which hook fired this — powers telemetry and logs, not policy. */
	hook:
		| "pre_write_edit"
		| "pre_bash_command"
		| "pre_external_egress"
		| "post_read_grep"
		| "user_prompt";
	/** One entry per distinct string field worth scanning. */
	parts: Array<{ source: string; text: string }>;
}
