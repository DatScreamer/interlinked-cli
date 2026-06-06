import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// ============================================================================
// Behavioral tests for the implicit-entry flow (`interlinked` with no args).
//
// Strategy:
//   - Mock every cross-module collaborator (lib/auth, lib/config,
//     lib/onboarding, sibling commands enable/login/status) so we observe
//     the exact call shapes handleImplicitEntry produces.
//   - Mock node:readline/promises so the interactive wizard reads scripted
//     answers instead of real stdin — fully deterministic, no TTY required.
//   - Mock lib/formatter so `c.*` are identity pass-throughs; asserted output
//     strings are then independent of NO_COLOR / CI / isTTY ANSI behavior.
//   - Stub process.argv, process.env, process.stdin.isTTY / stdout.isTTY and
//     global.fetch per-test; spy console.log.
// ============================================================================

interface RlMock {
	question: Mock<(prompt: string) => Promise<string>>;
	close: Mock<() => void>;
}

const {
	mockIsConfigured,
	mockResolveConfig,
	mockResolveAuthToken,
	mockEnsureRemoteOnboarding,
	mockEnableCommand,
	mockLoginCommand,
	mockStatusCommand,
	questionAnswers,
	rlClose,
	mockCreateInterface,
} = vi.hoisted(() => {
	// Scripted readline answers: each test pushes the answers it expects to be
	// consumed in order. `question()` shifts the queue; an empty queue yields ""
	// (the "user pressed Enter / accept default" case).
	const questionAnswers: string[] = [];
	const rlClose = vi.fn<() => void>();
	const mockCreateInterface = vi.fn(
		(): RlMock => ({
			question: vi.fn(async (_prompt: string): Promise<string> => questionAnswers.shift() ?? ""),
			close: rlClose,
		}),
	);
	return {
		mockIsConfigured: vi.fn((): boolean => false),
		mockResolveConfig: vi.fn(() => ({
			server_url: "https://remote.example.com",
			agent_name: "ConfiguredAgent" as string | undefined,
			sync_mode: "realtime" as string | undefined,
		})),
		mockResolveAuthToken: vi.fn((): string | null => null),
		mockEnsureRemoteOnboarding: vi.fn(
			async (): Promise<Record<string, unknown>> => ({ status: "skipped", reason: "noop" }),
		),
		mockEnableCommand: vi.fn(async (_opts: Record<string, unknown>): Promise<void> => {}),
		mockLoginCommand: vi.fn(async (_opts: Record<string, unknown>): Promise<void> => {}),
		mockStatusCommand: vi.fn(async (_opts: Record<string, unknown>): Promise<void> => {}),
		questionAnswers,
		rlClose,
		mockCreateInterface,
	};
});

vi.mock("../lib/config.js", () => ({
	isConfigured: mockIsConfigured,
	resolveConfig: mockResolveConfig,
}));
vi.mock("../lib/auth.js", () => ({ resolveAuthToken: mockResolveAuthToken }));
vi.mock("../lib/onboarding.js", () => ({ ensureRemoteOnboarding: mockEnsureRemoteOnboarding }));
vi.mock("./enable.js", () => ({ enableCommand: mockEnableCommand }));
vi.mock("./login.js", () => ({ loginCommand: mockLoginCommand }));
vi.mock("./status.js", () => ({ statusCommand: mockStatusCommand }));
vi.mock("node:readline/promises", () => ({ createInterface: mockCreateInterface }));
// Identity formatter — asserted strings are color-agnostic.
vi.mock("../lib/formatter.js", () => ({
	c: {
		bold: (s: string) => s,
		dim: (s: string) => s,
		green: (s: string) => s,
		yellow: (s: string) => s,
	},
}));

import { handleImplicitEntry } from "./first-run.js";

// ---- shared harness ---------------------------------------------------------

let logSpy: Mock<(...args: unknown[]) => void>;
const ORIGINAL_ENV = { ...process.env };

/** All env vars first-run.ts reads — cleared before each test for isolation. */
const READ_ENV_KEYS = [
	"INTERLINKED_SERVER_URL",
	"INTERLINKED_AGENT_NAME",
	"INTERLINKED_AGENT",
	"AGENT_NAME",
	"USER",
	"INTERLINKED_TOKEN",
	"INTERLINKED_ACCESS_TOKEN",
	"INTERLINKED_SYNC_MODE",
	"INTERLINKED_CLIENTS",
];

function setTty(value: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

/** Concatenate every console.log argument list into one searchable string. */
function loggedText(): string {
	return logSpy.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");
}

/** The RlMock produced by the first createInterface() call this test made. */
function currentRl(): RlMock {
	const result = mockCreateInterface.mock.results[0];
	if (!result || result.type !== "return") throw new Error("createInterface was not called");
	return result.value;
}

function stubFetchOk(ok: boolean): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (): Promise<Response> => ({ ok }) as Response),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	questionAnswers.length = 0;
	for (const k of READ_ENV_KEYS) delete process.env[k];
	// Default: configured=false, no token, onboarding noop. Tests override.
	mockIsConfigured.mockReturnValue(false);
	mockResolveAuthToken.mockReturnValue(null);
	mockEnsureRemoteOnboarding.mockResolvedValue({ status: "skipped", reason: "noop" });
	// fetch defaults to "server reachable" (200 OK) unless a test overrides it.
	stubFetchOk(true);
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {}) as unknown as Mock<
		(...args: unknown[]) => void
	>;
	setTty(false);
	process.argv = ["node", "interlinked"];
});

afterEach(() => {
	vi.unstubAllGlobals();
	process.env = { ...ORIGINAL_ENV };
});

// ---- handleImplicitEntry: dispatch branches --------------------------------

describe("handleImplicitEntry — dispatch", () => {
	it("returns false and runs nothing when args are present", async () => {
		process.argv = ["node", "interlinked", "status"];
		const result = await handleImplicitEntry();
		expect(result).toBe(false);
		expect(mockIsConfigured).not.toHaveBeenCalled();
		expect(mockEnableCommand).not.toHaveBeenCalled();
		expect(mockStatusCommand).not.toHaveBeenCalled();
	});

	it("runs the interactive wizard when unconfigured + TTY", async () => {
		mockIsConfigured.mockReturnValue(false);
		setTty(true);
		// local server reachable -> stays local -> no login prompt path
		const result = await handleImplicitEntry();
		expect(result).toBe(true);
		expect(mockCreateInterface).toHaveBeenCalledTimes(1);
		expect(mockEnableCommand).toHaveBeenCalledTimes(1);
		expect(loggedText()).toContain("Interlinked CLI Setup Wizard");
		expect(loggedText()).toContain("Setup complete.");
	});

	it("runs non-interactive bootstrap when unconfigured + non-TTY", async () => {
		mockIsConfigured.mockReturnValue(false);
		setTty(false);
		const result = await handleImplicitEntry();
		expect(result).toBe(true);
		expect(mockCreateInterface).not.toHaveBeenCalled();
		expect(mockEnableCommand).toHaveBeenCalledTimes(1);
		expect(loggedText()).toContain("No config found. Running non-interactive bootstrap");
	});

	it("shows status with quick-start when configured + TTY", async () => {
		mockIsConfigured.mockReturnValue(true);
		setTty(true);
		const result = await handleImplicitEntry();
		expect(result).toBe(true);
		expect(mockStatusCommand).toHaveBeenCalledWith({});
		expect(loggedText()).toContain("Command Quick Start");
	});

	it("shows status WITHOUT quick-start when configured + non-TTY", async () => {
		mockIsConfigured.mockReturnValue(true);
		setTty(false);
		const result = await handleImplicitEntry();
		expect(result).toBe(true);
		expect(mockStatusCommand).toHaveBeenCalledWith({});
		expect(loggedText()).not.toContain("Command Quick Start");
	});
});

// ---- runInteractiveWizard: chooseDefaultServer + prompts --------------------

describe("interactive wizard — server selection", () => {
	beforeEach(() => setTty(true));

	it("honors INTERLINKED_SERVER_URL without probing", async () => {
		process.env.INTERLINKED_SERVER_URL = "https://env.example.com";
		await handleImplicitEntry();
		expect(fetch).not.toHaveBeenCalled();
		expect(mockEnableCommand).toHaveBeenCalledWith(
			expect.objectContaining({ server: "https://env.example.com" }),
		);
	});

	it("uses local server when the health probe returns ok", async () => {
		stubFetchOk(true);
		await handleImplicitEntry();
		expect(fetch).toHaveBeenCalledWith(
			"http://localhost:8787/health",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(mockEnableCommand).toHaveBeenCalledWith(
			expect.objectContaining({ server: "http://localhost:8787" }),
		);
	});

	it("falls back to the remote default when the probe is not ok", async () => {
		stubFetchOk(false);
		await handleImplicitEntry();
		// Both DEFAULT_LOCAL_SERVER and DEFAULT_REMOTE_SERVER are localhost:8787
		// in the public distribution, so the fallback resolves to the same URL —
		// what we pin is that the not-ok branch is taken (probe still ran).
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(mockEnableCommand).toHaveBeenCalledWith(
			expect.objectContaining({ server: "http://localhost:8787" }),
		);
	});

	it("falls back when the health probe throws (unreachable)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				throw new Error("ECONNREFUSED");
			}),
		);
		await handleImplicitEntry();
		expect(mockEnableCommand).toHaveBeenCalledWith(
			expect.objectContaining({ server: "http://localhost:8787" }),
		);
	});

	it("aborts the health probe after the timeout fires (setTimeout callback path)", async () => {
		// fetch hangs until its AbortSignal fires; advancing fake timers past the
		// reachability timeout triggers the setTimeout(() => controller.abort())
		// callback, which rejects the fetch -> caught -> server treated unreachable.
		vi.useFakeTimers();
		const fetchMock = vi.fn(
			(_url: string, init?: { signal?: AbortSignal }): Promise<Response> =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("Aborted", "AbortError")),
					);
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const entryPromise = handleImplicitEntry();
			// Run pending timers so the abort callback executes, then let the
			// rejected fetch and the rest of the async flow settle.
			await vi.runAllTimersAsync();
			await entryPromise;
		} finally {
			vi.useRealTimers();
		}
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(mockEnableCommand).toHaveBeenCalledWith(
			expect.objectContaining({ server: "http://localhost:8787" }),
		);
	});

	it("passes scripted server/agent/sync answers through to enableCommand", async () => {
		process.env.INTERLINKED_SERVER_URL = "https://ignored-probe.example.com";
		// Override the three prompts: server, agent, sync.
		questionAnswers.push("https://typed.example.com", "TypedAgent", "manual");
		await handleImplicitEntry();
		expect(mockEnableCommand).toHaveBeenCalledWith({
			server: "https://typed.example.com",
			agent: "TypedAgent",
			syncMode: "manual",
		});
		expect(rlClose).toHaveBeenCalledTimes(1);
	});

	it("accepts defaults when the user presses Enter (blank answers)", async () => {
		process.env.INTERLINKED_SERVER_URL = "https://default-srv.example.com";
		process.env.INTERLINKED_AGENT_NAME = "EnvAgent";
		// No answers queued -> question() yields "" each time -> defaults used.
		await handleImplicitEntry();
		expect(mockEnableCommand).toHaveBeenCalledWith({
			server: "https://default-srv.example.com",
			agent: "EnvAgent",
			syncMode: "realtime",
		});
	});
});

// ---- runInteractiveWizard: login-prompt gate + parseYesNo -------------------

describe("interactive wizard — auth prompt gate", () => {
	beforeEach(() => setTty(true));

	it("does NOT prompt for login on a local server", async () => {
		process.env.INTERLINKED_SERVER_URL = "http://127.0.0.1:9999";
		await handleImplicitEntry();
		// createInterface().question called exactly 3x (server/agent/sync), not 4.
		expect(currentRl().question).toHaveBeenCalledTimes(3);
		expect(mockLoginCommand).not.toHaveBeenCalled();
	});

	it("does NOT prompt for login when a token is in the environment", async () => {
		process.env.INTERLINKED_SERVER_URL = "https://remote.example.com";
		process.env.INTERLINKED_TOKEN = "tok_env";
		await handleImplicitEntry();
		expect(currentRl().question).toHaveBeenCalledTimes(3);
		// envToken branch runs loginCommand with the token.
		expect(mockLoginCommand).toHaveBeenCalledWith({
			server: "https://remote.example.com",
			token: "tok_env",
		});
		expect(loggedText()).toContain("Using INTERLINKED_TOKEN from environment.");
	});

	it("does NOT prompt for login when already authenticated", async () => {
		process.env.INTERLINKED_SERVER_URL = "https://remote.example.com";
		mockResolveAuthToken.mockReturnValue("existing-token");
		await handleImplicitEntry();
		expect(currentRl().question).toHaveBeenCalledTimes(3);
		expect(mockLoginCommand).not.toHaveBeenCalled();
	});

	it("prompts for login on a remote server with no token, and runs login on yes", async () => {
		process.env.INTERLINKED_SERVER_URL = "https://remote.example.com";
		questionAnswers.push("", "", "", "yes"); // server, agent, sync, login=yes
		await handleImplicitEntry();
		expect(currentRl().question).toHaveBeenCalledTimes(4);
		expect(mockLoginCommand).toHaveBeenCalledWith({ server: "https://remote.example.com" });
	});

	it("skips login and prints guidance when the user answers no", async () => {
		process.env.INTERLINKED_SERVER_URL = "https://remote.example.com";
		questionAnswers.push("", "", "", "n");
		await handleImplicitEntry();
		expect(mockLoginCommand).not.toHaveBeenCalled();
		expect(loggedText()).toContain("Authentication skipped. Run `interlinked login` when ready.");
	});

	it("treats a blank login answer as the yes default", async () => {
		process.env.INTERLINKED_SERVER_URL = "https://remote.example.com";
		questionAnswers.push("", "", "", ""); // login prompt blank -> defaultValue true
		await handleImplicitEntry();
		expect(mockLoginCommand).toHaveBeenCalledWith({ server: "https://remote.example.com" });
	});

	it("treats an unrecognized login answer as the yes default", async () => {
		process.env.INTERLINKED_SERVER_URL = "https://remote.example.com";
		questionAnswers.push("", "", "", "maybe"); // unknown -> defaultValue true
		await handleImplicitEntry();
		expect(mockLoginCommand).toHaveBeenCalledWith({ server: "https://remote.example.com" });
	});
});

// ---- runInteractiveWizard: post-login onboarding reflection ----------------

describe("interactive wizard — onboarding reflection (no login ran)", () => {
	beforeEach(() => {
		setTty(true);
		// Local server -> no login path -> didRunLogin stays false -> onboarding runs.
		process.env.INTERLINKED_SERVER_URL = "http://localhost:8787";
	});

	it("reports a newly-linked remote agent (new mode, with handle)", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			agentName: "Worker-New",
			agentHandle: "@worker.new",
			isNewAgent: true,
			reclaimedAgent: false,
		});
		await handleImplicitEntry();
		expect(loggedText()).toContain("Remote agent linked: Worker-New (new) @worker.new");
	});

	it("reports a reclaimed remote agent (reclaimed mode)", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			agentName: "Worker-Re",
			isNewAgent: false,
			reclaimedAgent: true,
		});
		await handleImplicitEntry();
		expect(loggedText()).toContain("Remote agent linked: Worker-Re (reclaimed)");
	});

	it("reports an existing remote agent and falls back to 'agent' when name is blank", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			agentName: "",
			isNewAgent: false,
			reclaimedAgent: false,
		});
		await handleImplicitEntry();
		expect(loggedText()).toContain("Remote agent linked: agent (existing)");
	});

	it("reports the agent_name_missing skip reason", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "skipped",
			reason: "agent_name_missing",
		});
		await handleImplicitEntry();
		expect(loggedText()).toContain(
			"Remote onboarding skipped: set agent name to auto-link remote identity.",
		);
	});

	it("prints no onboarding line for an unrelated skip reason", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "skipped",
			reason: "not_authenticated",
		});
		await handleImplicitEntry();
		expect(loggedText()).not.toContain("Remote onboarding skipped");
		expect(loggedText()).not.toContain("Remote agent linked");
	});

	it("does NOT run onboarding when a login already ran (envToken path)", async () => {
		process.env.INTERLINKED_SERVER_URL = "https://remote.example.com";
		process.env.INTERLINKED_TOKEN = "tok_env";
		await handleImplicitEntry();
		expect(mockEnsureRemoteOnboarding).not.toHaveBeenCalled();
	});
});

// ---- runNonInteractiveBootstrap --------------------------------------------

describe("non-interactive bootstrap", () => {
	beforeEach(() => setTty(false));

	it("passes env-derived server/agent/sync/clients to enableCommand", async () => {
		process.env.INTERLINKED_SERVER_URL = "https://boot.example.com";
		process.env.INTERLINKED_AGENT_NAME = "BootAgent";
		process.env.INTERLINKED_SYNC_MODE = "local";
		process.env.INTERLINKED_CLIENTS = "claude,codex";
		await handleImplicitEntry();
		expect(mockEnableCommand).toHaveBeenCalledWith({
			server: "https://boot.example.com",
			agent: "BootAgent",
			syncMode: "local",
			clients: "claude,codex",
		});
	});

	it("runs login when a token is present and skips onboarding", async () => {
		process.env.INTERLINKED_SERVER_URL = "https://boot.example.com";
		process.env.INTERLINKED_ACCESS_TOKEN = "tok_access";
		await handleImplicitEntry();
		expect(mockLoginCommand).toHaveBeenCalledWith({
			server: "https://boot.example.com",
			token: "tok_access",
		});
		expect(mockEnsureRemoteOnboarding).not.toHaveBeenCalled();
	});

	it("warns when remote + no token + unauthenticated, then runs onboarding", async () => {
		process.env.INTERLINKED_SERVER_URL = "https://boot.example.com";
		mockResolveAuthToken.mockReturnValue(null);
		await handleImplicitEntry();
		expect(mockLoginCommand).not.toHaveBeenCalled();
		expect(loggedText()).toContain("No token available. Set INTERLINKED_TOKEN");
		expect(mockEnsureRemoteOnboarding).toHaveBeenCalledWith({
			serverUrl: "https://boot.example.com",
		});
	});

	it("does not warn on a local server and still runs onboarding", async () => {
		process.env.INTERLINKED_SERVER_URL = "http://localhost:8787";
		await handleImplicitEntry();
		expect(mockLoginCommand).not.toHaveBeenCalled();
		expect(loggedText()).not.toContain("No token available");
		expect(mockEnsureRemoteOnboarding).toHaveBeenCalled();
	});

	it("does not warn when already authenticated and still runs onboarding", async () => {
		process.env.INTERLINKED_SERVER_URL = "https://boot.example.com";
		mockResolveAuthToken.mockReturnValue("already-have-token");
		await handleImplicitEntry();
		expect(mockLoginCommand).not.toHaveBeenCalled();
		expect(loggedText()).not.toContain("No token available");
		expect(mockEnsureRemoteOnboarding).toHaveBeenCalled();
	});

	it("prints the linked line WITH a handle when onboarding links with a handle", async () => {
		process.env.INTERLINKED_SERVER_URL = "http://localhost:8787";
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			agentName: "Boot-Linked",
			agentHandle: "@boot.linked",
		});
		await handleImplicitEntry();
		expect(loggedText()).toContain("Remote agent linked: Boot-Linked (@boot.linked)");
	});

	it("prints the linked line WITHOUT a handle and falls back to 'agent' when name blank", async () => {
		process.env.INTERLINKED_SERVER_URL = "http://localhost:8787";
		mockEnsureRemoteOnboarding.mockResolvedValue({ status: "linked", agentName: "" });
		await handleImplicitEntry();
		expect(loggedText()).toContain("Remote agent linked: agent");
		expect(loggedText()).not.toContain("Remote agent linked: agent (");
	});

	it("prints no linked line when onboarding did not link", async () => {
		process.env.INTERLINKED_SERVER_URL = "http://localhost:8787";
		mockEnsureRemoteOnboarding.mockResolvedValue({ status: "failed", reason: "bootstrap_failed" });
		await handleImplicitEntry();
		expect(loggedText()).not.toContain("Remote agent linked");
	});
});

// ---- printEntrypointQuickStart (configured + TTY) --------------------------

describe("quick-start suggestions (configured + TTY)", () => {
	beforeEach(() => {
		mockIsConfigured.mockReturnValue(true);
		setTty(true);
	});

	it("suggests attach when no agent_name is set", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "https://remote.example.com",
			agent_name: undefined,
			sync_mode: "realtime",
		});
		await handleImplicitEntry();
		expect(loggedText()).toContain("interlinked attach --agent <name>");
	});

	it("does NOT suggest attach when agent_name is set", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "https://remote.example.com",
			agent_name: "HasAgent",
			sync_mode: "realtime",
		});
		await handleImplicitEntry();
		expect(loggedText()).not.toContain("interlinked attach --agent <name>");
	});

	it("suggests login on a remote server with no auth", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "https://remote.example.com",
			agent_name: "HasAgent",
			sync_mode: "realtime",
		});
		mockResolveAuthToken.mockReturnValue(null);
		await handleImplicitEntry();
		expect(loggedText()).toContain("interlinked login");
	});

	it("does NOT suggest login on a local server", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "http://localhost:8787",
			agent_name: "HasAgent",
			sync_mode: "realtime",
		});
		mockResolveAuthToken.mockReturnValue(null);
		await handleImplicitEntry();
		expect(loggedText()).not.toContain("  interlinked login");
	});

	it("does NOT suggest login when authenticated on a remote server", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "https://remote.example.com",
			agent_name: "HasAgent",
			sync_mode: "realtime",
		});
		mockResolveAuthToken.mockReturnValue("a-token");
		await handleImplicitEntry();
		// "interlinked login" appears only as its own suggestion line; assert the
		// specific indented form is absent.
		expect(loggedText()).not.toContain("  interlinked login");
	});

	it("suggests sync when sync_mode is not local", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "http://localhost:8787",
			agent_name: "HasAgent",
			sync_mode: "realtime",
		});
		await handleImplicitEntry();
		expect(loggedText()).toContain("interlinked sync");
	});

	it("does NOT suggest sync when sync_mode is local", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "http://localhost:8787",
			agent_name: "HasAgent",
			sync_mode: "local",
		});
		await handleImplicitEntry();
		expect(loggedText()).not.toContain("interlinked sync");
	});

	it("always includes the activity / tasks / help suggestions", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "http://localhost:8787",
			agent_name: "HasAgent",
			sync_mode: "local",
		});
		await handleImplicitEntry();
		const text = loggedText();
		expect(text).toContain("interlinked activity --since 1h");
		expect(text).toContain("interlinked tasks list");
		expect(text).toContain("interlinked --help");
	});
});

// ---- getDefaultAgentName env-precedence chain ------------------------------

describe("default agent name precedence (via bootstrap enableCommand)", () => {
	beforeEach(() => {
		setTty(false);
		process.env.INTERLINKED_SERVER_URL = "http://localhost:8787";
	});

	async function agentPassedToEnable(): Promise<string> {
		await handleImplicitEntry();
		const call = mockEnableCommand.mock.calls[0]?.[0] as { agent: string };
		return call.agent;
	}

	it("prefers INTERLINKED_AGENT_NAME", async () => {
		process.env.INTERLINKED_AGENT_NAME = "A1";
		process.env.INTERLINKED_AGENT = "A2";
		process.env.AGENT_NAME = "A3";
		process.env.USER = "A4";
		expect(await agentPassedToEnable()).toBe("A1");
	});

	it("falls back to INTERLINKED_AGENT", async () => {
		process.env.INTERLINKED_AGENT = "A2";
		process.env.AGENT_NAME = "A3";
		process.env.USER = "A4";
		expect(await agentPassedToEnable()).toBe("A2");
	});

	it("falls back to AGENT_NAME", async () => {
		process.env.AGENT_NAME = "A3";
		process.env.USER = "A4";
		expect(await agentPassedToEnable()).toBe("A3");
	});

	it("falls back to USER", async () => {
		process.env.USER = "A4";
		expect(await agentPassedToEnable()).toBe("A4");
	});

	it("falls back to the literal 'Agent' when nothing is set", async () => {
		expect(await agentPassedToEnable()).toBe("Agent");
	});
});

// ---- normalizeSyncMode (via bootstrap) -------------------------------------

describe("sync-mode normalization (via bootstrap enableCommand)", () => {
	beforeEach(() => {
		setTty(false);
		process.env.INTERLINKED_SERVER_URL = "http://localhost:8787";
	});

	async function syncPassedToEnable(): Promise<string> {
		await handleImplicitEntry();
		const call = mockEnableCommand.mock.calls[0]?.[0] as { syncMode: string };
		return call.syncMode;
	}

	it("passes through 'local'", async () => {
		process.env.INTERLINKED_SYNC_MODE = "local";
		expect(await syncPassedToEnable()).toBe("local");
	});

	it("passes through 'manual' (case-insensitive, trimmed)", async () => {
		process.env.INTERLINKED_SYNC_MODE = "  MANUAL ";
		expect(await syncPassedToEnable()).toBe("manual");
	});

	it("coerces an unknown mode to 'realtime'", async () => {
		process.env.INTERLINKED_SYNC_MODE = "weird";
		expect(await syncPassedToEnable()).toBe("realtime");
	});

	it("coerces an unset mode to 'realtime'", async () => {
		expect(await syncPassedToEnable()).toBe("realtime");
	});
});
