// Extracted from hooks-template.ts.
// This is DATA — the body of the generated `.interlinked/hooks/interlinked-activity.mjs`.
// Do not edit escape sequences (`\\b`, `\\s`, `\\n`, etc.) — they are the source form
// for the runtime script. `\\n` in this file becomes `\n` in the emitted .mjs.

/** Public API — consumed by buildHookScript in hooks-template.ts. */
export const SESSION_STATE_CHUNK = `// --- Thinking Extraction — real-time capture from transcript ---
// Reads new thinking blocks from the Claude Code transcript JSONL on each
// hook invocation. Uses a byte-offset cursor persisted to disk so the
// short-lived hook process only reads incremental content.
const THINKING_CURSOR_PATH = join(DATA_DIR, "thinking-cursor.json");
const THINKING_MAX_LEN = 4000;

function extractNewThinking(transcriptPath) {
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    try {
        const stat = statSync(transcriptPath);
        const fileSize = stat.size;

        let cursor = { path: "", offset: 0 };
        try { cursor = JSON.parse(readFileSync(THINKING_CURSOR_PATH, "utf-8")); } catch (_err) { void 0; /* intentional: no-op */ }

        // Reset cursor if transcript changed (new session)
        if (cursor.path !== transcriptPath) cursor = { path: transcriptPath, offset: 0 };
        if (cursor.offset >= fileSize) return null;

        // Read only new bytes since last invocation
        const fd = openSync(transcriptPath, "r");
        const buf = Buffer.alloc(fileSize - cursor.offset);
        readSync(fd, buf, 0, buf.length, cursor.offset);
        closeSync(fd);

        const newContent = buf.toString("utf-8");

        // Extract thinking blocks from new JSONL lines
        const thinkingParts = [];
        for (const line of newContent.split("\\n")) {
            if (!line.trim()) continue;
            try {
                const obj = JSON.parse(line);
                if (obj.type === "assistant") {
                    for (const block of (obj.message?.content || [])) {
                        if (block.type === "thinking" && block.thinking) {
                            thinkingParts.push(block.thinking);
                        }
                    }
                }
            } catch (_err) { void 0; /* intentional: no-op */ }
        }

        // Persist updated cursor
        try { writeFileSync(THINKING_CURSOR_PATH, JSON.stringify({ path: transcriptPath, offset: fileSize })); } catch (_err) { void 0; /* intentional: no-op */ }

        if (thinkingParts.length === 0) return null;

        let combined = thinkingParts.join("\\n---\\n");
        if (combined.length > THINKING_MAX_LEN) {
            combined = combined.slice(0, THINKING_MAX_LEN) + "... [truncated]";
        }
        return combined;
    } catch {
        return null;
    }
}

// --- Local JSONL append (full capture, sync) ---
function appendLocal(event, hookEvent, sessionId, agentName, workspaceKey, projectKey) {
    try {
        const dir = dirname(ACTIVITY_PATH);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const record = {
            schema_version: 3,
            ts: new Date().toISOString(),
            agent: agentName || "unknown",
            workspace_key: workspaceKey || null,
            project_key: projectKey || null,
            type: event.event_type,
            tool: event.tool_name || null,
            summary: event.tool_input_summary || null,
            session: sessionId || null,
            hook: hookEvent || null,
        };
        // v2 fields
        if (event.tokens) record.tokens = event.tokens;
        if (event.duration_ms) record.duration_ms = event.duration_ms;
        if (event.parent_agent) record.parent_agent = event.parent_agent;
        if (event.subagent_id) record.subagent_id = event.subagent_id;
        if (event.files_modified) record.files_modified = event.files_modified;
        // v3 full-capture fields
        if (event.tool_input !== undefined) record.tool_input = event.tool_input;
        if (event.tool_response !== undefined) record.tool_response = event.tool_response;
        if (event.tool_use_id) record.tool_use_id = event.tool_use_id;
        if (event.error !== undefined) record.error = event.error;
        if (event.is_interrupt !== undefined) record.is_interrupt = event.is_interrupt;
        if (event.cwd) record.cwd = event.cwd;
        if (event.permission_mode) record.permission_mode = event.permission_mode;
        if (event.transcript_path) record.transcript_path = event.transcript_path;
        if (event.model) record.model = event.model;
        if (event.source) record.source = event.source;
        if (event.agent_type) record.agent_type = event.agent_type;
        if (event.last_assistant_message !== undefined) record.last_assistant_message = event.last_assistant_message;
        if (event.agent_transcript_path) record.agent_transcript_path = event.agent_transcript_path;
        if (event.prompt !== undefined) record.prompt = event.prompt;
        if (event.notification_type) record.notification_type = event.notification_type;
        if (event.notification_title) record.notification_title = event.notification_title;
        if (event.notification_message) record.notification_message = event.notification_message;
        if (event.task_id) record.task_id = event.task_id;
        if (event.task_subject) record.task_subject = event.task_subject;
        if (event.task_description) record.task_description = event.task_description;
        if (event.teammate_name) record.teammate_name = event.teammate_name;
        if (event.team_name) record.team_name = event.team_name;
        if (event.trigger) record.trigger = event.trigger;
        if (event.custom_instructions) record.custom_instructions = event.custom_instructions;
        if (event.reason) record.reason = event.reason;
        if (event.stop_hook_active !== undefined) record.stop_hook_active = event.stop_hook_active;
        if (event.permission_suggestions) record.permission_suggestions = event.permission_suggestions;
        if (event.thinking) record.thinking = event.thinking;
        appendFileSync(ACTIVITY_PATH, JSON.stringify(record) + "\\n");
    } catch (_err) { void 0; /* intentional: no-op */ }
}

function appendGuardDecision(decision, guardResult, event, hookEvent, sessionId, agentName, workspaceKey, projectKey, harnessMs) {
    try {
        const dir = dirname(ACTIVITY_PATH);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const typeMap = { block: "guard_block", warn: "guard_warn", allow: "guard_allow" };
        const record = {
            schema_version: 3,
            ts: new Date().toISOString(),
            agent: agentName || "unknown",
            workspace_key: workspaceKey || null,
            project_key: projectKey || null,
            type: typeMap[decision] || "guard_allow",
            tool: event.tool_name || null,
            summary: truncate(guardResult.reason || (guardResult.warnings || []).join("; ") || "allow", 500),
            session: sessionId || null,
            hook: hookEvent || null,
            guard_decision: decision,
            guard_rule_id: guardResult.rule_id || null,
            guard_severity: guardResult.severity || null,
            guard_category: guardResult.category || null,
            guard_reason: guardResult.reason || null,
            guard_warnings: guardResult.warnings || null,
            guard_harness_ms: typeof harnessMs === "number" ? harnessMs : null,
        };
        if (event.model) record.model = event.model;
        if (event.cwd) record.cwd = event.cwd;
        // Enriched data from harness (PostToolUse check results, timing, grep stats)
        if (guardResult.check_results) record.guard_check_results = guardResult.check_results;
        if (guardResult.checks_timing_ms != null) record.guard_checks_timing_ms = guardResult.checks_timing_ms;
        if (guardResult.checks_ran) record.guard_checks_ran = guardResult.checks_ran;
        if (guardResult.grep_stats) record.guard_grep_stats = guardResult.grep_stats;
        appendFileSync(ACTIVITY_PATH, JSON.stringify(record) + "\\n");
    } catch (_err) { void 0; /* intentional: no-op */ }
}

function appendSyncError(stage, message) {
    try {
        const dir = dirname(SYNC_ERRORS_PATH);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(
            SYNC_ERRORS_PATH,
            JSON.stringify({
                ts: new Date().toISOString(),
                stage,
                message: truncate(String(message || ""), 400),
            }) + "\\n",
        );
    } catch (_err) { void 0; /* intentional: no-op */ }
}

function enqueueRealtimeRetry(payload) {
    try {
        const dir = dirname(REALTIME_RETRY_PATH);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(REALTIME_RETRY_PATH, JSON.stringify(payload) + "\\n");
    } catch (_err) { void 0; /* intentional: no-op */ }
}

async function flushRealtimeRetry(serverUrl, authHeader) {
    try {
        if (!existsSync(REALTIME_RETRY_PATH)) return;
        const lines = readFileSync(REALTIME_RETRY_PATH, "utf-8").split("\\n").filter(Boolean);
        if (lines.length === 0) return;

        const remaining = [];
        for (const line of lines) {
            let payload = null;
            try { payload = JSON.parse(line); } catch (_err) { void 0; /* intentional: no-op */ }
            if (!payload) continue;
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 3000);
                const res = await fetch(serverUrl + "/api/hooks/activity", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        ...(authHeader ? { Authorization: authHeader } : {}),
                    },
                    signal: controller.signal,
                    body: JSON.stringify(payload),
                });
                clearTimeout(timeout);
                if (!res.ok) {
                    remaining.push(line);
                    appendSyncError("realtime_retry_http", "status " + res.status);
                }
            } catch (e) {
                remaining.push(line);
                appendSyncError(
                    "realtime_retry_network",
                    e instanceof Error ? e.message : String(e),
                );
            }
        }

        writeFileSync(
            REALTIME_RETRY_PATH,
            remaining.length > 0 ? (remaining.join("\\n") + "\\n") : "",
        );
    } catch (_err) { void 0; /* intentional: no-op */ }
}

// --- Capture code edit from PostToolUse Edit/Write ---
function captureCodeEdit(sessionId, agentName, event) {
    if (!sessionId) return;
    const toolName = event.tool_name;
    if (toolName !== "Edit" && toolName !== "Write") return;
    const toolInput = event.tool_input || {};
    const filePath = toolInput.file_path || toolInput.path || null;
    if (!filePath) return;

    const MAX_DIFF_SIZE = 10240; // 10KB cap per string
    const edit = {
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        agent_name: agentName || "unknown",
        file: filePath,
        tool: toolName,
        lines_added: 0,
        lines_removed: 0,
    };

    if (toolName === "Edit") {
        const oldStr = toolInput.old_string || "";
        const newStr = toolInput.new_string || "";
        const oldLines = oldStr ? oldStr.split("\\n").length : 0;
        const newLines = newStr ? newStr.split("\\n").length : 0;
        edit.lines_added = Math.max(0, newLines - oldLines);
        edit.lines_removed = Math.max(0, oldLines - newLines);
        if (oldStr.length <= MAX_DIFF_SIZE) edit.old_string = oldStr;
        if (newStr.length <= MAX_DIFF_SIZE) edit.new_string = newStr;
    } else {
        // Write: count lines, don't store full content
        const content = toolInput.content || "";
        edit.lines_added = content ? content.split("\\n").length : 0;
        edit.full_write = true;
    }

    // Append to session state
    try {
        const sessionPath = join(SESSIONS_DIR, sessionId + ".json");
        let state = null;
        if (existsSync(sessionPath)) {
            try { state = JSON.parse(readFileSync(sessionPath, "utf-8")); } catch (_err) { void 0; /* intentional: no-op */ }
        }
        if (!state) return;
        if (!state.edits) state.edits = [];
        state.edits.push(edit);

        // Update per-agent contribution
        if (!state.by_agent) state.by_agent = {};
        const contrib = state.by_agent[edit.agent_name] || {
            agent_name: edit.agent_name,
            session_id: sessionId,
            files_touched: [],
            total_added: 0,
            total_removed: 0,
            edit_count: 0,
        };
        contrib.total_added += edit.lines_added;
        contrib.total_removed += edit.lines_removed;
        contrib.edit_count += 1;
        if (!contrib.files_touched.includes(edit.file)) contrib.files_touched.push(edit.file);
        state.by_agent[edit.agent_name] = contrib;

        writeFileSync(sessionPath, JSON.stringify(state) + "\\n");
    } catch (_err) { void 0; /* intentional: no-op */ }
}

// --- Session-end commit reconciliation ---
function reconcileCommits(sessionId) {
    if (!sessionId) return;
    try {
        const sessionPath = join(SESSIONS_DIR, sessionId + ".json");
        if (!existsSync(sessionPath)) return;
        let state = null;
        try { state = JSON.parse(readFileSync(sessionPath, "utf-8")); } catch (_err) { void 0; /* intentional: no-op */ }
        if (!state || !state.session_start_head) return;
        if (!state.edits || state.edits.length === 0) return;

        // Collect files we edited in this session
        const editedFiles = new Set(state.edits.map(e => e.file));

        // Find commits since session start
        let commitLog = "";
        try {
            commitLog = execSync(
                "git log " + state.session_start_head + "..HEAD --format=\\"%H %s\\" --no-merges 2>/dev/null",
                { encoding: "utf-8", timeout: 5000 },
            ).trim();
        } catch { return; }
        if (!commitLog) return;

        const commits = [];
        for (const line of commitLog.split("\\n")) {
            if (!line.trim()) continue;
            const spaceIdx = line.indexOf(" ");
            if (spaceIdx < 0) continue;
            const hash = line.slice(0, spaceIdx);
            const message = line.slice(spaceIdx + 1);

            // Get files in this commit
            let nameOnly = "";
            try {
                nameOnly = execSync(
                    "git diff " + hash + "~1 " + hash + " --name-only 2>/dev/null",
                    { encoding: "utf-8", timeout: 5000 },
                ).trim();
            } catch { continue; }

            const commitFiles = nameOnly.split("\\n").filter(f => f.trim());
            // File-overlap filter: only attribute commits touching files we edited
            const overlap = commitFiles.filter(f => {
                for (const ef of editedFiles) {
                    if (ef.endsWith(f) || f.endsWith(ef) || ef.includes(f) || f.includes(ef)) return true;
                }
                return false;
            });
            if (overlap.length === 0) continue;

            // Get numstat for attribution
            let numstat = "";
            try {
                numstat = execSync(
                    "git diff " + hash + "~1 " + hash + " --numstat 2>/dev/null",
                    { encoding: "utf-8", timeout: 5000 },
                ).trim();
            } catch { continue; }

            const files = [];
            for (const nline of numstat.split("\\n")) {
                const parts = nline.split("\\t");
                if (parts.length < 3) continue;
                const added = parseInt(parts[0], 10) || 0;
                const removed = parseInt(parts[1], 10) || 0;
                const file = parts[2];
                // Proportional attribution from tracked edits
                const agents = {};
                for (const edit of (state.edits || [])) {
                    if (edit.file.endsWith(file) || file.endsWith(edit.file) || edit.file.includes(file) || file.includes(edit.file)) {
                        if (!agents[edit.agent_name]) agents[edit.agent_name] = { added: 0, removed: 0 };
                        agents[edit.agent_name].added += edit.lines_added;
                        agents[edit.agent_name].removed += edit.lines_removed;
                    }
                }
                const totalTracked = Object.values(agents).reduce((s, a) => s + a.added + a.removed, 0);
                const agentList = Object.entries(agents).map(([name, a]) => ({
                    agent_name: name,
                    added: a.added,
                    removed: a.removed,
                    percentage: totalTracked > 0 ? Math.round(((a.added + a.removed) / totalTracked) * 100) : 100,
                }));
                if (agentList.length === 0) {
                    agentList.push({ agent_name: state.agent || "unknown", added, removed, percentage: 100 });
                }
                files.push({ file, net_added: added, net_removed: removed, agents: agentList });
            }

            commits.push({
                commit_hash: hash,
                timestamp: new Date().toISOString(),
                message,
                files,
            });
        }

        if (commits.length > 0) {
            state.commits = (state.commits || []).concat(commits);
            // Dedup by commit_hash
            const seen = new Set();
            state.commits = state.commits.filter(c => {
                if (seen.has(c.commit_hash)) return false;
                seen.add(c.commit_hash);
                return true;
            });
            writeFileSync(sessionPath, JSON.stringify(state) + "\\n");
        }
    } catch (_err) { void 0; /* intentional: no-op */ }
}

// --- Session state update (v2: tokens, subagents) ---
function updateSessionState(sessionId, agentName, event) {
    if (!sessionId) return;
    try {
        if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
        const filePath = join(SESSIONS_DIR, sessionId + ".json");
        let existing = null;
        if (existsSync(filePath)) {
            try { existing = JSON.parse(readFileSync(filePath, "utf-8")); } catch (_err) { void 0; /* intentional: no-op */ }
        }
        const now = new Date().toISOString();
        const isEnd = event.event_type === "session_end" || event.event_type === "agent_stop";
        const isTool = event.event_type === "tool_use" || event.event_type === "tool_use_start";
        const isError = event.event_type === "tool_use_error";
        const isSubagentStart = event.event_type === "subagent_start";
        const isSubagentStop = event.event_type === "subagent_stop";

        const toolsUsed = existing?.tools_used || {};
        if (isTool && event.tool_name) toolsUsed[event.tool_name] = (toolsUsed[event.tool_name] || 0) + 1;

        const filesTouched = new Set(existing?.files_touched || []);
        if (isTool && event.tool_name && ["Read","Write","Edit","Update","ReadFile","WriteFile","EditFile","read_file","write_file","edit_file"].includes(event.tool_name) && event.tool_input_summary) {
            filesTouched.add(event.tool_input_summary);
        }

        // Track subagent state
        if (isSubagentStart && event.tool_name) {
            activeSubagent = event.tool_name;
        }
        if (isSubagentStop && event.tool_name) {
            activeSubagent = null;
        }

        // Accumulate token totals
        const tokensTotal = existing?.tokens_total || { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
        let tokenEvents = existing?.token_events || 0;
        if (event.tokens) {
            tokensTotal.input += event.tokens.input || 0;
            tokensTotal.output += event.tokens.output || 0;
            tokensTotal.cache_read += event.tokens.cache_read || 0;
            tokensTotal.cache_creation += event.tokens.cache_creation || 0;
            tokenEvents += 1;
        }

        // Track per-subagent state
        const subagents = existing?.subagents || {};
        if (activeSubagent && isTool) {
            if (!subagents[activeSubagent]) {
                subagents[activeSubagent] = { files_touched: [], tools_used: {}, tool_count: 0 };
            }
            const sa = subagents[activeSubagent];
            sa.tool_count += 1;
            if (event.tool_name) sa.tools_used[event.tool_name] = (sa.tools_used[event.tool_name] || 0) + 1;
            if (event.tool_name && ["Read","Write","Edit","Update","ReadFile","WriteFile","EditFile","read_file","write_file","edit_file"].includes(event.tool_name) && event.tool_input_summary) {
                if (!sa.files_touched.includes(event.tool_input_summary)) sa.files_touched.push(event.tool_input_summary);
            }
        }
        if (isSubagentStop && event.tool_name && subagents[event.tool_name] && event.tokens) {
            subagents[event.tool_name].tokens = {
                input: (subagents[event.tool_name].tokens?.input || 0) + (event.tokens.input || 0),
                output: (subagents[event.tool_name].tokens?.output || 0) + (event.tokens.output || 0),
            };
        }

        // Capture git HEAD on session start for commit reconciliation
        let sessionStartHead = existing?.session_start_head || null;
        if (!existing && event.event_type === "session_start") {
            try {
                sessionStartHead = execSync("git rev-parse HEAD 2>/dev/null", { encoding: "utf-8", timeout: 3000 }).trim();
            } catch (_err) { void 0; /* intentional: no-op */ }
        }

        const state = {
            session_id: sessionId,
            agent: agentName || existing?.agent || "unknown",
            phase: isEnd ? "ENDED" : "ACTIVE",
            started_at: existing?.started_at || now,
            last_event_at: now,
            tool_count: (existing?.tool_count || 0) + (isTool ? 1 : 0),
            error_count: (existing?.error_count || 0) + (isError ? 1 : 0),
            files_touched: [...filesTouched],
            tools_used: toolsUsed,
        };
        // Only include v2 fields if they have data
        const hasTokens = tokensTotal.input > 0 || tokensTotal.output > 0;
        if (hasTokens) state.tokens_total = tokensTotal;
        if (tokenEvents > 0) state.token_events = tokenEvents;
        if (Object.keys(subagents).length > 0) state.subagents = subagents;
        // Preserve v3 code activity fields
        if (sessionStartHead) state.session_start_head = sessionStartHead;
        if (existing?.edits) state.edits = existing.edits;
        if (existing?.by_agent) state.by_agent = existing.by_agent;
        if (existing?.commits) state.commits = existing.commits;

        writeFileSync(filePath, JSON.stringify(state) + "\\n");
    } catch (_err) { void 0; /* intentional: no-op */ }
}

// --- Batch sync: read unsynced events and POST in chunks ---
async function batchSync(serverUrl, authHeader, workspaceId, workspaceKey, projectKey, agentName) {
    try {
        if (!existsSync(ACTIVITY_PATH)) return;

        // Read sync cursor
        let syncedBytes = 0;
        if (existsSync(SYNC_STATE_PATH)) {
            try {
                const state = JSON.parse(readFileSync(SYNC_STATE_PATH, "utf-8"));
                syncedBytes = state.synced_through_bytes || 0;
            } catch (_err) { void 0; /* intentional: no-op */ }
        }

        const fileSize = statSync(ACTIVITY_PATH).size;
        if (syncedBytes >= fileSize) return;

        // Read from cursor to EOF
        const bytesToRead = fileSize - syncedBytes;
        const fd = openSync(ACTIVITY_PATH, "r");
        const buffer = Buffer.alloc(bytesToRead);
        readSync(fd, buffer, 0, bytesToRead, syncedBytes);
        closeSync(fd);

        const chunk = buffer.toString("utf-8");
        const lines = chunk.split("\\n").filter(Boolean);
        const events = [];
        for (const line of lines) {
            try {
                const e = JSON.parse(line);
                const ev = {
                    agent_name: e.agent || agentName || "unknown",
                    workspace_key: e.workspace_key || workspaceKey || undefined,
                    project_key: e.project_key || projectKey || undefined,
                    event_type: e.type || "unknown",
                    tool_name: e.tool || null,
                    tool_input_summary: e.summary || null,
                    occurred_at: e.ts || new Date().toISOString(),
                };
                // v2 fields
                if (e.duration_ms) ev.duration_ms = e.duration_ms;
                if (e.tokens?.input) ev.tokens_input = e.tokens.input;
                if (e.tokens?.output) ev.tokens_output = e.tokens.output;
                if (e.tokens?.cache_read) ev.tokens_cache_read = e.tokens.cache_read;
                if (e.tokens?.cache_creation) ev.tokens_cache_creation = e.tokens.cache_creation;
                if (e.parent_agent) ev.parent_agent = e.parent_agent;
                if (e.subagent_id) ev.subagent_id = e.subagent_id;
                if (e.files_modified) ev.files_modified = e.files_modified;
                // v3 fields
                if (e.hook) ev.hook_event = e.hook;
                if (e.error) ev.error_message = String(e.error);
                if (e.error) ev.error_detail = String(e.error);
                // v4 full-capture fields
                if (e.tool_input !== undefined) ev.tool_input_json = typeof e.tool_input === "string" ? e.tool_input : JSON.stringify(e.tool_input);
                if (e.tool_response !== undefined) ev.tool_response_json = typeof e.tool_response === "string" ? e.tool_response : JSON.stringify(e.tool_response);
                if (e.prompt) ev.prompt = e.prompt;
                if (e.last_assistant_message) ev.last_assistant_message = e.last_assistant_message;
                if (e.cwd) ev.cwd = e.cwd;
                if (e.model) ev.model = e.model;
                if (e.source) ev.source = e.source;
                if (e.agent_type) ev.agent_type_hook = e.agent_type;
                if (e.tool_use_id) ev.tool_use_id = e.tool_use_id;
                if (e.session) ev.session_id = e.session;
                if (e.is_interrupt !== undefined) ev.is_interrupt = e.is_interrupt;
                if (e.notification_type) ev.notification_type = e.notification_type;
                if (e.notification_title) ev.notification_title = e.notification_title;
                if (e.task_subject) ev.task_subject = e.task_subject;
                if (e.task_id) ev.task_id_hook = e.task_id;
                if (e.task_description) ev.task_description_hook = e.task_description;
                if (e.trigger) ev.trigger = e.trigger;
                if (e.reason) ev.reason = e.reason;
                if (e.permission_mode) ev.permission_mode = e.permission_mode;
                if (e.transcript_path) ev.transcript_path = e.transcript_path;
                if (e.teammate_name) ev.teammate_name = e.teammate_name;
                if (e.team_name) ev.team_name = e.team_name;
                if (e.custom_instructions) ev.custom_instructions = e.custom_instructions;
                if (e.stop_hook_active !== undefined) ev.stop_hook_active = e.stop_hook_active;
                if (e.permission_suggestions) ev.permission_suggestions = typeof e.permission_suggestions === "string" ? e.permission_suggestions : JSON.stringify(e.permission_suggestions);
                if (e.agent_transcript_path) ev.agent_transcript_path = e.agent_transcript_path;
                if (e.thinking) ev.thinking = e.thinking;
                // Scrub secrets before sending to server
                scrubPayload(ev);
                events.push(ev);
            } catch (_err) { void 0; /* intentional: no-op */ }
        }

        if (events.length === 0) return;

        // POST in 100-event chunks
        const CHUNK_SIZE = 100;
        let allSuccess = true;
        for (let i = 0; i < events.length; i += CHUNK_SIZE) {
            const batch = events.slice(i, i + CHUNK_SIZE);
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 5000);
                const res = await fetch(serverUrl + "/api/hooks/activity/batch", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        ...(authHeader ? { Authorization: authHeader } : {}),
                    },
                    signal: controller.signal,
                    body: JSON.stringify({
                        workspace_uuid: workspaceId,
                        workspace_key: workspaceKey || undefined,
                        project_key: projectKey || undefined,
                        events: batch,
                    }),
                });
                clearTimeout(timeout);
                if (!res.ok) {
                    appendSyncError("batch_sync_http", "status " + res.status);
                    allSuccess = false;
                    break;
                }
            } catch (e) {
                appendSyncError(
                    "batch_sync_network",
                    e instanceof Error ? e.message : String(e),
                );
                allSuccess = false;
                break;
            }
        }

        // Advance cursor only if all batches succeeded
        if (allSuccess) {
            writeFileSync(SYNC_STATE_PATH, JSON.stringify({
                synced_through_bytes: fileSize,
                last_sync_at: new Date().toISOString(),
            }) + "\\n");
        }
    } catch (e) {
        appendSyncError(
            "batch_sync_error",
            e instanceof Error ? e.message : String(e),
        );
        // Swallow — never block the agent
    }
}`;
