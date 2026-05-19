// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Sensitivity / Taint Tracking Types
// ===========================================

export type SensitivityLevel = "Public" | "Internal" | "Confidential" | "HighlyConfidential";

export interface TaintSource {
	file: string;
	level: SensitivityLevel;
	at_step: number;
}

export interface TaintTrackingConfig {
	enabled: boolean;
	/** File patterns → sensitivity level mappings */
	file_sensitivity: Array<{ glob: string; level: SensitivityLevel }>;
	/** Step limits per sensitivity level */
	step_limits: Record<SensitivityLevel, number>;
	/** Block outbound network at this level and above */
	network_block_at: SensitivityLevel;
}

// ===========================================
// Output Scanning Configuration
// ===========================================

export interface OutputScanningConfig {
	enabled: boolean;
	/** Scan Bash output for leaked secrets */
	scan_bash_secrets: boolean;
	/** Scan WebFetch results for prompt injection */
	scan_web_injection: boolean;
	/** Scan file read results for indirect injection */
	scan_file_injection: boolean;
	/** Maximum bytes to scan per response (default: 100KB) */
	max_scan_bytes: number;
}
