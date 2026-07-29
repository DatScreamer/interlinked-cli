// ===========================================
// Statusline daemon-down branch — grace, auto-revive, alarm
// ===========================================
// The generated statusline is the daemon's only idle-time heartbeat: the
// runner re-executes it every few seconds (refreshInterval) even when no
// tools run. Before 2026-07-28 the down-branch only ALARMED — a daemon killed
// during idle (jetsam on a swap-pinned 16GB box; ledger shows row-less
// SIGKILLs at RSS as low as 450MB) stayed dead for HOURS, statusline red,
// until the next tool call's self-heal fired. So the down-branch now spawns
// the daemon itself: throttled by a marker file, arbitrated by the daemon's
// own anti-stomp (a loser exits and writes its ledger row), rendered as a
// calm "auto-reviving" row that escalates to the red alarm only when revival
// is demonstrably failing.
//
// Absolute node/server paths are BAKED at generation time (`interlinked
// enable` / regeneration) because the render-time environment has no reliable
// PATH. Pure string builders — the whole fragment is unit-testable without
// writing the script to disk.

import { getHarnessServerPath } from "../commands/harness-process.js";
import { DEFAULT_DAEMON_HEAP_MB } from "../harness/memory-ceiling.js";

export interface ReviveBakes {
	/** Absolute node binary of the generating process. */
	nodeBin: string;
	/** Absolute path to dist/harness/server.js, or "" when unresolvable. */
	serverJs: string;
	/** V8 old-space MB — the same regulator every spawn path applies. */
	heapMb: number;
}

/** Resolve the paths to bake. Never throws: an unresolvable install layout
 *  yields an empty server path and the bash spawn guard no-ops on it. */
export function resolveReviveBakes(): ReviveBakes {
	let serverJs = "";
	try {
		serverJs = getHarnessServerPath();
	} catch (err) {
		// Generation must not fail over a probe error; revival simply no-ops.
		void err;
	}
	return { nodeBin: process.execPath, serverJs, heapMb: DEFAULT_DAEMON_HEAP_MB };
}

/**
 * The full `ALIVE=0` branch of the generated script, from grace debounce
 * through revival to render, plus the marker cleanup on the healthy path.
 * Escaping contract: this fragment is interpolated into the same template
 * string as the rest of the script, so `\${...}` survives as a shell
 * expansion and `\\n` as a printf newline — identical conventions.
 */
export function downBranchBash(b: ReviveBakes): string {
	return `# Debounce transient restart windows. A self-healing respawn (or a SessionStart
# relaunch) leaves harness.pid pointing at a dead process for ~1-3s; without a
# grace period the statusline paints the full outage alarm on that blip even
# though the cold-path gate is already blocking edits fail-closed.
DOWN_MARK="$ID/.statusline-down-since"
DOWN_GRACE_SECS=6
# Auto-revive: this script is the daemon's only idle-time heartbeat, so past
# the grace window it SPAWNS the daemon rather than only alarming. Throttled
# by a marker file; the daemon's own anti-stomp arbitrates races (a loser
# exits and writes its own ledger row). Paths are baked at generation time.
REVIVE_NODE="${b.nodeBin}"
REVIVE_SERVER="${b.serverJs}"
REVIVE_MARK="$ID/.statusline-revive-at"
REVIVE_THROTTLE_SECS=20
REVIVE_ALARM_SECS=45
if [ "$ALIVE" = "0" ]; then
    NOW=$(date +%s)
    SINCE="$NOW"
    if [ -f "$DOWN_MARK" ]; then
        SINCE=$(cat "$DOWN_MARK" 2>/dev/null || echo "$NOW")
    else
        echo "$NOW" > "$DOWN_MARK" 2>/dev/null
    fi
    case "$SINCE" in *[!0-9]*) SINCE="$NOW";; esac
    if [ "$((NOW - SINCE))" -lt "$DOWN_GRACE_SECS" ]; then
        LINE1="\${YELLOW}\${BOLD}◆ interlinked\${RESET}\${SEP}\${YELLOW}↻ harness restarting…\${RESET}"
        LINE2="\${DIM}auto-recovering — edits blocked until it's back\${RESET}"
        printf '%s\\n%s' "$LINE1" "$LINE2"
        exit 0
    fi
    # Past grace: attempt revival, at most once per throttle window.
    LAST_TRY=0
    [ -f "$REVIVE_MARK" ] && LAST_TRY=$(cat "$REVIVE_MARK" 2>/dev/null)
    case "$LAST_TRY" in *[!0-9]*|"") LAST_TRY=0;; esac
    if [ "$((NOW - LAST_TRY))" -ge "$REVIVE_THROTTLE_SECS" ] && [ -n "$REVIVE_SERVER" ] && [ -x "$REVIVE_NODE" ] && [ -f "$REVIVE_SERVER" ]; then
        echo "$NOW" > "$REVIVE_MARK" 2>/dev/null
        # Subshell-level redirects matter: without them the daemon inherits the
        # statusline's stdout PIPE and holds it open — every render then hangs
        # waiting for EOF until the runner's timeout (caught live 2026-07-28).
        ( cd "$ROOT" 2>/dev/null && "$REVIVE_NODE" --max-old-space-size=${b.heapMb} --expose-gc "$REVIVE_SERVER" --cwd "$ROOT" --protocol dual --session-id default </dev/null >/dev/null 2>&1 & ) </dev/null >/dev/null 2>&1
    fi
    if [ "$((NOW - SINCE))" -lt "$REVIVE_ALARM_SECS" ]; then
        LINE1="\${YELLOW}\${BOLD}◆ interlinked\${RESET}\${SEP}\${YELLOW}↻ harness down — auto-reviving…\${RESET}"
        LINE2="\${DIM}respawn fires from this statusline every \${REVIVE_THROTTLE_SECS}s — edits blocked until it's back\${RESET}"
        printf '%s\\n%s' "$LINE1" "$LINE2"
        exit 0
    fi
    BRAND="\${RED}\${BOLD}◆ interlinked\${RESET}"
    LINE1="\${BRAND}\${SEP}\${YELLOW}▼ harness offline — auto-revive failing\${RESET}\${SEP}\${RED}Claude is bypassing guardrails\${RESET}"
    LINE2="\${CYAN}↻ interlinked harness start\${RESET}"
    printf '%s\\n%s' "$LINE1" "$LINE2"
    exit 0
fi
rm -f "$DOWN_MARK" "$REVIVE_MARK" 2>/dev/null`;
}
