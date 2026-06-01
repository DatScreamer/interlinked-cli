// Extracted from hooks-template.ts.
// This is DATA — the body of the generated `.interlinked/hooks/interlinked-activity.mjs`.
// Do not edit escape sequences (`\\s`, `\\n`, `\\*`, etc.) — they are the source form
// for the runtime script. `\\s` in this file becomes `\s` in the emitted .mjs.
//
// ===========================================
// Hook Event Normalization Layer
// ===========================================
// Each AI coding client emits a different hook payload shape. The .mjs
// script holds a per-client `normalizeXxxEvent(input)` function that maps
// the raw payload to a single canonical event record:
//
//   {
//     event_type: "session_start" | "tool_use_start" | "tool_use" | ...
//     tool_name: string | null
//     tool_input_summary: string | null
//     hook_event: <original native event name, preserved verbatim>
//     ...event-specific fields (tool_input, tokens, prompt, etc.)
//     ...envelope fields (cwd, transcript_path, session_id_hint)
//   }
//
// The downstream pipeline (local JSONL append, harness forwarding, server
// POST) speaks ONLY this canonical shape — adding a new client means
// authoring exactly one normalizer and a detector entry in CLIENT_HANDLERS.
//
// Per-client status:
//   - Claude Code:  PascalCase events, full 14-event vocabulary
//   - Codex CLI:    PascalCase events, Claude-compatible payloads, 6 events
//                   (delegates to normalizeClaudeEvent, tagged client_runner)
//   - Gemini CLI:   PascalCase BeforeTool/AfterTool variant
//   - Copilot CLI:  camelCase, no `hook_event_name`, shape inferred from payload
//
// Each per-client normalizer dispatches through a lookup table keyed on
// the native event name, so adding/removing an event is a one-line change
// rather than a switch-statement edit.
//
// This module is a thin assembler. The actual normalizer source — a large
// template-literal of runtime JavaScript — is split by client across four
// sibling files so each stays under the per-file line cap:
//   - event-normalizers-claude.ts   shared helpers + Claude + Codex
//   - event-normalizers-gemini.ts   Gemini CLI
//   - event-normalizers-copilot.ts  GitHub Copilot CLI
//   - event-normalizers-cursor.ts   Cursor IDE
// EVENT_NORMALIZERS_CHUNK concatenates them verbatim (direct join, no
// separators) so the emitted `.mjs` bytes are identical to the pre-split
// single-literal form. The composed length + structural invariant are
// pinned in event-normalizers.test.ts.

import { CLAUDE_NORMALIZERS } from "./event-normalizers-claude.js";
import { COPILOT_NORMALIZERS } from "./event-normalizers-copilot.js";
import { CURSOR_NORMALIZERS } from "./event-normalizers-cursor.js";
import { GEMINI_NORMALIZERS } from "./event-normalizers-gemini.js";

/** Public API — consumed by buildHookScript in hooks-template.ts. */
export const EVENT_NORMALIZERS_CHUNK = `${CLAUDE_NORMALIZERS}${GEMINI_NORMALIZERS}${COPILOT_NORMALIZERS}${CURSOR_NORMALIZERS}`;
