import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sanitizeSessionId } from "../session-paths.js";

// Background - the vulnerability this regression test guards against:
//
// processEvent() in server.ts used to write the session trajectory with:
//
//   writeFileSync(
//     join(sessDir, `${event.session_id}.trajectory.json`),
//     JSON.stringify(...),
//   );
//
// event.session_id arrives over the Unix socket as arbitrary JSON-parsed
// data. Passing it directly through path.join allowed a payload like
// "../../../.config/target" to escape .interlinked/sessions/ because
// path.join does NOT contain traversal: ../ segments collapse.
//
// The fix:
//   1. Run event.session_id through sanitizeSessionId (whitelist charset +
//      length cap) before building the path.
//   2. Defense-in-depth: resolve() the target and ensure it lives under
//      resolve(sessDir) + sep (or equals it) before writing.
//
// These tests pin both halves in place via a source-level pattern assertion
// plus behavioral checks on sanitizeSessionId and the containment logic.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SERVER_TS = resolve(HERE, "..", "server.ts");

describe("harness trajectory write - path traversal regression", () => {
	const serverSource = readFileSync(SERVER_TS, "utf-8");

	it("imports sanitizeSessionId from session-paths", () => {
		// Brace group is [^}]* on both sides so the assertion survives an
		// import-organizer merging sanitizeSessionId with co-imports from
		// the same module (e.g. `{ daemonPathsFor, sanitizeSessionId }`).
		expect(serverSource).toMatch(
			/import\s*\{[^}]*\bsanitizeSessionId\b[^}]*\}\s*from\s*["']\.\/session-paths\.js["']/,
		);
	});

	it("applies sanitizeSessionId before building the trajectory path", () => {
		expect(serverSource).toContain("sanitizeSessionId(event.session_id)");
		expect(serverSource).toContain("`${safeId}.trajectory.json`");
	});

	it("does NOT concatenate raw event.session_id into the trajectory filename", () => {
		expect(serverSource).not.toContain("${event.session_id}.trajectory.json");
	});

	it("performs a resolve-and-containment check before writing", () => {
		expect(serverSource).toMatch(/resolve\s*\(\s*sessDir\s*\)/);
		expect(serverSource).toMatch(/resolve\s*\(\s*targetPath\s*\)/);
		expect(serverSource).toContain("resolvedDir + sep");
	});

	it("throws (triggering tryFn error path) when sanitization produces an empty id", () => {
		expect(serverSource).toContain('throw new Error("invalid session_id: no safe characters")');
	});
});

describe("sanitizeSessionId + path containment - behavioral guarantees", () => {
	const sessDir = "/tmp/fake-repo/.interlinked/sessions";
	const resolvedDir = resolve(sessDir);

	// Simulates the exact containment check that server.ts now performs.
	function resolvedWriteTarget(rawSessionId: string): {
		safeId: string;
		targetPath: string;
		contained: boolean;
	} {
		const safeId = sanitizeSessionId(rawSessionId);
		const targetPath = join(sessDir, `${safeId}.trajectory.json`);
		const resolved = resolve(targetPath);
		const contained =
			resolved === resolvedDir || resolved.startsWith(resolvedDir + sep);
		return { safeId, targetPath, contained };
	}

	it("contains the write for a benign UUID-shaped session id", () => {
		const { safeId, targetPath, contained } = resolvedWriteTarget(
			"01J6E6AWKR3T4YV5DJH5QVVAK5",
		);
		expect(safeId).toBe("01J6E6AWKR3T4YV5DJH5QVVAK5");
		expect(contained).toBe(true);
		expect(targetPath).toBe(
			join(sessDir, "01J6E6AWKR3T4YV5DJH5QVVAK5.trajectory.json"),
		);
	});

	it("neutralizes the path-traversal payload from the vuln report", () => {
		const { safeId, targetPath, contained } = resolvedWriteTarget(
			"../../../../.config/some-path/pwn",
		);
		expect(safeId).not.toContain("..");
		expect(safeId).not.toContain("/");
		expect(contained).toBe(true);
		expect(targetPath.startsWith(sessDir + sep)).toBe(true);
	});

	it("neutralizes absolute-path payloads", () => {
		const { safeId, contained } = resolvedWriteTarget("/etc/passwd");
		expect(safeId).not.toContain("/");
		expect(contained).toBe(true);
	});

	it("neutralizes payloads that mix whitespace and separators", () => {
		const { safeId, contained } = resolvedWriteTarget("abc /etc/passwd");
		expect(safeId).not.toContain(" ");
		expect(safeId).not.toContain("/");
		expect(contained).toBe(true);
	});

	it("caps absurd length to 64 chars", () => {
		const { safeId } = resolvedWriteTarget("a".repeat(10_000));
		expect(safeId.length).toBe(64);
	});

	it("backslash traversal is handled equivalently on POSIX", () => {
		const backslash = String.fromCharCode(92);
		const payload = `..${backslash}..${backslash}evil`;
		const { safeId, contained } = resolvedWriteTarget(payload);
		expect(safeId).not.toContain(backslash);
		expect(contained).toBe(true);
	});
});
