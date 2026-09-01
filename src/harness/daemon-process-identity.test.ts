import { describe, expect, it } from "vitest";
import {
	isHarnessDaemonCommandForCwd,
	sameProcessIdentity,
	verifiedProcessIdentities,
} from "./daemon-process-identity.js";

const CWD = "/repo with spaces";
const DAEMON =
	"/opt/node --max-old-space-size=1536 --expose-gc " +
	`/opt/interlinked-cli/dist/harness/server.js --cwd ${CWD} --protocol dual`;

describe("isHarnessDaemonCommandForCwd", () => {
	it("accepts a generated daemon for the exact project, including spaces", () => {
		expect(isHarnessDaemonCommandForCwd({ command: DAEMON, cwd: CWD })).toBe(true);
		expect(
			isHarnessDaemonCommandForCwd({
				command:
					"/opt/node --max-old-space-size=1536 --expose-gc " +
					"/work/renamed-checkout/dist/harness/server.js --cwd /repo --protocol dual",
				cwd: "/repo",
			}),
		).toBe(true);
		expect(
			isHarnessDaemonCommandForCwd({
				command: "/usr/bin/bun /work/dist/harness/server.js --cwd=/repo --protocol=raw",
				cwd: "/repo",
			}),
		).toBe(true);
	});

	it.each([
		["wrong project", DAEMON, "/other"],
		["look-alike entry", DAEMON.replace("server.js", "server.js.bak"), CWD],
		["ordinary node process", `/opt/node /app.js --cwd ${CWD}`, CWD],
		[
			"daemon path mentioned by another script",
			"/usr/bin/node /app/user.js --note /opt/interlinked-cli/dist/harness/server.js --cwd /repo",
			"/repo",
		],
		[
			"eval payload mentioning the daemon",
			"/usr/bin/node -e console.log('/opt/interlinked-cli/dist/harness/server.js') --cwd /repo",
			"/repo",
		],
		[
			"daemon path passed as a second operand to another script",
			"/usr/bin/node /tmp/other.js /repo/dist/harness/server.js --cwd /repo",
			"/repo",
		],
		[
			"daemon argv with an unrecognized trailing option",
			"/usr/bin/node /repo/dist/harness/server.js --cwd /repo --execute-unrelated",
			"/repo",
		],
	])("rejects %s", (_name, command, cwd) => {
		expect(isHarnessDaemonCommandForCwd({ command, cwd })).toBe(false);
	});
});

describe("verified process identity", () => {
	it("keeps only candidates authenticated as this project's daemon", () => {
		const found = verifiedProcessIdentities(CWD, [11, 22], (_cwd, pid) =>
			pid === 11 ? "start-a\nargv" : null,
		);
		expect([...found]).toEqual([[11, "start-a\nargv"]]);
	});

	it("rejects a reused PID when its start identity changes", () => {
		expect(
			sameProcessIdentity({
				cwd: CWD,
				pid: 11,
				expectedIdentity: "start-a\nargv",
				isAlive: () => true,
				identify: () => "start-b\nargv",
			}),
		).toBe(false);
	});
});
