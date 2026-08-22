// ===========================================
// Tool Runner — TypeScript Diff-Overlay (dispatcher)
// ===========================================
// Detects type errors introduced by a proposed edit BEFORE it lands, by
// running TypeScript's incremental LanguageService against an in-memory
// overlay of the target file. This module is the PUBLIC entry point;
// the LanguageService-construction logic itself lives in
// tsc-overlay-service.ts (shared with the sidecar process entry).
//
// Modes (config: `tsc_overlay.mode`, default "sidecar"):
//   - "sidecar"    (default) — spawn a disposable child process per check.
//     The whole-project LanguageService heap (~1-2GB on this repo) lives in
//     that child, not the daemon; every sidecar failure mode degrades to
//     no findings + one stderr warning (tsc-overlay-sidecar-client.ts).
//   - "in-process" — run the LanguageService directly in this process (the
//     pre-2026-08 behavior). Faster per-call (no spawn), but the daemon
//     pays the retained heap — this is the RSS-pinning problem the sidecar
//     exists to fix. Kept as an explicit opt-out and for the existing
//     LS-behavior test suite (tsc-overlay.test.ts).
//   - "off" — never run the overlay check.
//
// Deliberate departure from a fully async sidecar transport: see the module
// doc in tsc-overlay-sidecar-client.ts for why this stays synchronous.

import { loadRules } from "../../rules-loader.js";
import type { CheckResult } from "../types.js";
import { runOverlayViaSidecar } from "./tsc-overlay-sidecar-client.js";
import {
	clearOverlayServiceCache,
	OVERLAY_EXT,
	type RunTscOverlayInput,
	runOverlayCheckInProcess,
} from "./tsc-overlay-service.js";

export type { RunTscOverlayInput };

type TscOverlayMode = "sidecar" | "in-process" | "off";

const DEFAULT_MODE: TscOverlayMode = "sidecar";

/** Cached per project root so every overlay check doesn't re-read
 *  guard-rules.json off disk — refreshed by clearTscOverlayCache. */
const _modeCache = new Map<string, TscOverlayMode>();

/** Test-only override — bypasses loadRules entirely so unit tests (which
 *  run against tmpdir "projects" with no real .interlinked/ config) can pin
 *  a mode without writing config files. `null` clears the override. */
let _modeOverrideForTest: TscOverlayMode | null = null;

export function _setTscOverlayModeOverrideForTest(mode: TscOverlayMode | null): void {
	_modeOverrideForTest = mode;
	_modeCache.clear();
}

function getTscOverlayMode(projectRoot: string): TscOverlayMode {
	if (_modeOverrideForTest) return _modeOverrideForTest;
	const cached = _modeCache.get(projectRoot);
	if (cached) return cached;
	let mode: TscOverlayMode = DEFAULT_MODE;
	try {
		mode = loadRules(projectRoot).tsc_overlay?.mode ?? DEFAULT_MODE;
	} catch {
		// intentional: a tmpdir/fixture project root with no readable config
		// tree falls back to the default rather than throwing out of a
		// PreToolUse check.
		mode = DEFAULT_MODE;
	}
	_modeCache.set(projectRoot, mode);
	return mode;
}

/**
 * Run the overlay check against a proposed file content, dispatching to the
 * configured transport. Returns diagnostics FOR THAT FILE ONLY. Cross-file
 * regressions (an edit to A breaks B) are left to PostToolUse.
 */
export function runTscOverlay(input: RunTscOverlayInput): CheckResult[] {
	if (!OVERLAY_EXT.test(input.filePath)) return [];

	const mode = getTscOverlayMode(input.projectRoot);
	if (mode === "off") return [];
	if (mode === "in-process") return runOverlayCheckInProcess(input);
	return runOverlayViaSidecar(input);
}

/**
 * Drop the cached LanguageService (in-process mode) and mode resolution
 * (both modes) for a project (or all projects). Call when tsconfig.json
 * changes, files are added/removed, or (daemon path) to shed retained heap
 * under idle/RSS pressure.
 */
export function clearTscOverlayCache(projectRoot?: string): void {
	clearOverlayServiceCache(projectRoot);
	if (projectRoot) {
		_modeCache.delete(projectRoot);
	} else {
		_modeCache.clear();
	}
}
