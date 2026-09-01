import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateCandidates, type OrphanCandidate } from "./harness-process-reap.js";

const CWD = "/repo";
const CANDIDATE: OrphanCandidate = {
	pid: 4242,
	ppid: 1,
	command: "node /repo/dist/harness/server.js --cwd /repo",
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("terminateCandidates process identity fencing", () => {
	it("never SIGTERMs a replacement that appears after candidate authentication", () => {
		const identify = vi
			.fn<(cwd: string, pid: number) => string | null>()
			.mockReturnValueOnce("original")
			.mockReturnValue("replacement");
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);

		expect(terminateCandidates([CANDIDATE], CWD, identify)).toEqual([]);
		expect(kill.mock.calls.filter((call) => call[1] !== 0)).toEqual([]);
	});

	it("never signals a pid that cannot be authenticated", () => {
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		expect(terminateCandidates([CANDIDATE], CWD, () => null)).toEqual([]);
		expect(kill).not.toHaveBeenCalled();
	});

	it("does not SIGKILL when the original exits and the pid is reused after SIGTERM", () => {
		const identify = vi
			.fn<(cwd: string, pid: number) => string | null>()
			.mockReturnValueOnce("original")
			.mockReturnValueOnce("original")
			.mockReturnValue("replacement");
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);

		expect(terminateCandidates([CANDIDATE], CWD, identify)).toEqual([4242]);
		expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
		expect(kill).not.toHaveBeenCalledWith(4242, "SIGKILL");
	});
});
