// ===========================================
// Statusline row 3 — bash template chunk
// ===========================================
// Extracted from hook-installers-statusline.ts (2026-08-17) when the
// mutation-loop row pushed that file over the line cap. Same contract as
// src/lib/hook-template-chunks/: a bash fragment carried as a TS string,
// interpolated verbatim into the generated statusline script. Bash variables
// are written `\${VAR}` so the TS template leaves them for bash; `$(…)` and
// bare `$VAR` pass through untouched.
//
// Row-3 priority (last override wins upward): sponsor slot (opt-in default)
// < 24/7 mutation loop < live viz dashboard.

export const STATUSLINE_ROW3_BASH = `# --- Row 3 (priority): live visualizer link ---
# \`interlinked viz serve\` writes .interlinked/viz.status while it is listening
# (url= + pid=). The link is rendered ONLY when that pid is still alive, so the
# row never offers a dead link after the server exits. A live dashboard outranks
# everything else on row 3 — it is the operator's own running process.
VIZ_FILE="$ROOT/.interlinked/viz.status"
VIZ_SEG=""
if [ -f "$VIZ_FILE" ]; then
    VZ_PID=$(grep -E '^pid=' "$VIZ_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
    VZ_URL=$(grep -E '^url=' "$VIZ_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ -n "\$VZ_PID" ] && [ -n "\$VZ_URL" ] && ps -p "\$VZ_PID" > /dev/null 2>&1; then
        VIZ_SEG="\${DIM}◈ viz\${RESET}\${SEP}$(osc8 "\$VZ_URL" "\$VZ_URL") \${DIM}↗\${RESET}"
    fi
fi

# --- Row 3 (mid-priority): 24/7 mutation-measurement loop ---
# scratch/two-box-runner/mutation-24x7.sh writes .interlinked/mutation-24x7.status
# once per slice: state (measuring/degraded/paused), a one-line lane detail, and
# hardened/tracked/open derived from the survivors index. Fresh <15 min renders;
# an exited loop ages out instead of pinning stale numbers on screen.
MUT_FILE="$ROOT/.interlinked/mutation-24x7.status"
MUT_SEG=""
if [ -f "$MUT_FILE" ]; then
    MU_NOW=$(date +%s)
    MU_MT=$(stat -f %m "$MUT_FILE" 2>/dev/null || stat -c %Y "$MUT_FILE" 2>/dev/null || echo 0)
    if [ $((MU_NOW - MU_MT)) -lt 900 ]; then
        MU_STATE=$(grep -E '^state=' "$MUT_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
        MU_HARD=$(grep -E '^hardened=' "$MUT_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
        MU_TOT=$(grep -E '^tracked=' "$MUT_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
        MU_OPEN=$(grep -E '^open=' "$MUT_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
        MU_DETAIL=$(grep -E '^detail=' "$MUT_FILE" 2>/dev/null | head -1 | cut -d= -f2- | cut -c1-60)
        if [ -n "\$MU_STATE" ]; then
            MUT_SEG="\${DIM}⟳ mut\${RESET}\${SEP}\${MU_STATE} · \${MU_HARD}/\${MU_TOT} hardened · \${MU_OPEN} open\${SEP}\${DIM}\${MU_DETAIL}\${RESET}"
        fi
    fi
fi

# --- Row 3: sponsor slot (opt-in; docs/design/sponsor-slots.md) ---
# Reads the daemon-sanitized kv file. Rendered only when enabled=1 AND the
# file is fresh (<30 min) — a dead daemon ages the sponsor out instead of
# pinning a stale creative on screen. The daemon stripped control bytes
# before writing, so these fields are safe to interpolate.
SPONSOR_FILE="$ID/sponsor.status"
LINE3=""
if [ -f "$SPONSOR_FILE" ]; then
    SP_EN=$(grep -E '^enabled=' "$SPONSOR_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ "\$SP_EN" = "1" ]; then
        SP_NOW=$(date +%s)
        SP_MT=$(stat -f %m "$SPONSOR_FILE" 2>/dev/null || stat -c %Y "$SPONSOR_FILE" 2>/dev/null || echo 0)
        if [ $((SP_NOW - SP_MT)) -lt 1800 ]; then
            SP_TEXT=$(grep -E '^text=' "$SPONSOR_FILE" | head -1 | cut -d= -f2-)
            SP_URL=$(grep -E '^url=' "$SPONSOR_FILE" | head -1 | cut -d= -f2-)
            if [ -n "$SP_TEXT" ]; then
                if [ -n "$SP_URL" ]; then
                    LINE3="\${DIM}♥ sponsor\${RESET}\${SEP}$(osc8 "$SP_URL" "$SP_TEXT") \${DIM}↗\${RESET}"
                else
                    LINE3="\${DIM}♥ sponsor\${RESET}\${SEP}\${DIM}\${SP_TEXT}\${RESET}"
                fi
            fi
        fi
    fi
fi

# Row-3 priority: live dashboard > mutation loop > sponsor slot.
[ -n "\$MUT_SEG" ] && LINE3="\$MUT_SEG"
[ -n "\$VIZ_SEG" ] && LINE3="\$VIZ_SEG"
`;
