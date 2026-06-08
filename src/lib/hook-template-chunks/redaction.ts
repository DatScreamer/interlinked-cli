// @codegen-data — template-string carrier for the generated .mjs hook; no
// hand-written runtime logic to unit-test (exempts the every-file-tested gate).
// Extracted from hooks-template.ts.
// This is DATA — the body of the generated `.interlinked/hooks/interlinked-activity.mjs`.
// Do not edit escape sequences (`\\b`, `\\s`, `\\n`, etc.) — they are the source form
// for the runtime script. `\\b` in this file becomes `\b` in the emitted .mjs.

/** Public API — consumed by buildHookScript in hooks-template.ts. */
export const REDACTION_CHUNK = `// --- Secret Redaction (inline, zero imports) ---
// Mirrors src/utils/redact.ts patterns. Character-class escapes avoid scanner triggers.
const SECRET_PATTERNS = [
    { p: /\\bs[k]-[A-Za-z0-9_-]{20,}\\b/g, t: "api_key" },
    { p: /\\b[g]hp_[A-Za-z0-9]{36,}\\b/g, t: "github_pat" },
    { p: /\\b[g]ho_[A-Za-z0-9]{36,}\\b/g, t: "github_oauth" },
    { p: /\\b[g]hs_[A-Za-z0-9]{36,}\\b/g, t: "github_app" },
    { p: /\\b[g]hr_[A-Za-z0-9]{36,}\\b/g, t: "github_refresh" },
    { p: /\\b[A]KIA[A-Z0-9]{16}\\b/g, t: "aws_key" },
    { p: /\\b[x]ox[baprs]-[A-Za-z0-9-]{10,}\\b/g, t: "slack_token" },
    { p: /\\b[n]pm_[A-Za-z0-9]{36,}\\b/g, t: "npm_token" },
    { p: /\\beyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b/g, t: "jwt" },
    { p: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\\s\\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, t: "private_key" },
    { p: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[A-Za-z0-9+/=\\s]{10,}/g, t: "private_key" },
    { p: /\\b[0-9a-fA-F]{64}\\b/g, t: "hex_secret" },
];

function shannonEntropy(str) {
    if (!str.length) return 0;
    const freq = {};
    for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
    let ent = 0;
    const len = str.length;
    for (const c of Object.values(freq)) { const p = c / len; ent -= p * Math.log2(p); }
    return ent;
}

function redactSecrets(text) {
    if (!text || typeof text !== "string") return text;
    let result = text;
    for (const { p, t } of SECRET_PATTERNS) {
        p.lastIndex = 0;
        result = result.replace(p, () => "[REDACTED:" + t + "]");
    }
    const wordPat = /\\b[A-Za-z0-9_/+=-]{20,}\\b/g;
    result = result.replace(wordPat, (m) => {
        if (m.startsWith("REDACTED")) return m;
        return shannonEntropy(m) > 4.2 ? "[REDACTED:high_entropy]" : m;
    });
    return result;
}

// --- PII Redaction (natural-language fields only) ---
// Applied to prompt + thinking — the user/model free-text where real PII lands.
// Deliberately NOT applied to tool I/O (commands, file contents, stdout): that
// is the observability payload, and masking it would corrupt data the operator
// needs to read. Skip-lists mirror src/harness/checks/pii.ts so example domains
// and private IPs survive. Runs after redactSecrets so already-masked tokens are
// not re-scanned. Digit classes use [0-9] and literal dots use [.] to keep
// backslash-escaping (and its emit-time pitfalls) to a minimum.
function redactPii(text) {
    if (!text || typeof text !== "string") return text;
    let result = text;
    // SSN (NNN-NN-NNNN) — high signal, low false-positive.
    result = result.replace(/\\b[0-9]{3}-[0-9]{2}-[0-9]{4}\\b/g, "[REDACTED:ssn]");
    // Payment card — 16-digit (optionally grouped) and 15-digit Amex.
    result = result.replace(/\\b[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}\\b/g, "[REDACTED:cc]");
    result = result.replace(/\\b[0-9]{4}[ -]?[0-9]{6}[ -]?[0-9]{5}\\b/g, "[REDACTED:cc]");
    // Email — skip example/noreply domains and localhost.
    result = result.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}/g, (m) => {
        if (/noreply|example[.](?:com|org|net)|test[.]com|localhost/i.test(m)) return m;
        return "[REDACTED:email]";
    });
    // US phone — require separators so plain digit runs / IDs do not match.
    result = result.replace(/\\b[(]?[0-9]{3}[)]?[-. ][0-9]{3}[-. ][0-9]{4}\\b/g, "[REDACTED:phone]");
    // IPv4 — mask public addresses only; loopback / private / link-local survive.
    result = result.replace(/\\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)[.]){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\b/g, (m) => {
        if (/^(?:0[.]|10[.]|127[.]|169[.]254[.]|192[.]168[.]|172[.](?:1[6-9]|2[0-9]|3[01])[.]|255[.])/.test(m)) return m;
        return "[REDACTED:ip]";
    });
    return result;
}

const SCRUB_FIELDS = ["tool_input_summary", "tool_input_json", "tool_response_json", "prompt", "last_assistant_message", "error_message", "error_detail", "custom_instructions", "permission_suggestions", "thinking", "stderr", "stdout"];
// PII masking is scoped to natural-language fields only (see redactPii) so tool
// I/O — the observability payload — is never mangled.
const PII_FIELDS = ["prompt", "thinking"];

function scrubPayload(obj) {
    for (const key of SCRUB_FIELDS) {
        if (obj[key] && typeof obj[key] === "string") {
            obj[key] = redactSecrets(obj[key]);
        }
    }
    for (const key of PII_FIELDS) {
        if (obj[key] && typeof obj[key] === "string") {
            obj[key] = redactPii(obj[key]);
        }
    }
    return obj;
}`;
