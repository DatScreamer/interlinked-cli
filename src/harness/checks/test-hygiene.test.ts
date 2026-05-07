import { describe, expect, it } from "vitest";
import {
	checkDuplicateTestNames,
	checkHardcodedTimeoutInTests,
	checkMockingTheSutSelf,
	checkRealIoInTests,
	checkTestMissingSutImport,
	checkTestNondeterminism,
} from "./test-hygiene.js";

const TEST = "src/lib/foo.test.ts";
const SRC = "src/lib/foo.ts";

describe("checkDuplicateTestNames", () => {
	it("flags two it() blocks with identical names", () => {
		const code = `
it("returns 404 when missing", () => { expect(a).toBe(1); });
it("returns 404 when missing", () => { expect(b).toBe(2); });
`;
		const matches = checkDuplicateTestNames(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("returns 404 when missing");
	});

	it("flags duplicate test() and specify() too", () => {
		const code = `
test("foo", () => {});
specify("foo", () => {});
`;
		expect(checkDuplicateTestNames(code, TEST).length).toBe(1);
	});

	it("does not fire on unique names", () => {
		const code = `it("foo", () => {}); it("bar", () => {});`;
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("does not fire on non-test files", () => {
		expect(checkDuplicateTestNames(`it("a"); it("a");`, SRC)).toEqual([]);
	});
});

describe("checkRealIoInTests", () => {
	it("flags fetch to a real URL", () => {
		const code = `await fetch("https://api.example.com/users");`;
		const matches = checkRealIoInTests(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("api.example.com");
	});

	it("does not fire on localhost / 127.0.0.1", () => {
		expect(
			checkRealIoInTests(`fetch("http://127.0.0.1:3000");`, TEST),
		).toEqual([]);
		expect(
			checkRealIoInTests(`fetch("http://localhost:8080/x");`, TEST),
		).toEqual([]);
	});

	it("flags writeFileSync to a real path", () => {
		const code = `writeFileSync("/etc/passwd", data);`;
		expect(checkRealIoInTests(code, TEST).length).toBe(1);
	});

	it("does not fire on writeFileSync to /tmp or __fixtures__", () => {
		expect(
			checkRealIoInTests(`writeFileSync("/tmp/test.txt", data);`, TEST),
		).toEqual([]);
		expect(
			checkRealIoInTests(`writeFileSync("__fixtures__/snap.txt", d);`, TEST),
		).toEqual([]);
	});

	it("does not fire in production source", () => {
		expect(
			checkRealIoInTests(`fetch("https://api.example.com/users");`, SRC),
		).toEqual([]);
	});
});

describe("checkTestNondeterminism", () => {
	it("flags Date.now() in test bodies", () => {
		expect(checkTestNondeterminism(`it("a", () => { const t = Date.now(); });`, TEST).length).toBe(1);
	});

	it("flags Math.random()", () => {
		expect(
			checkTestNondeterminism(`it("a", () => { const r = Math.random(); });`, TEST).length,
		).toBe(1);
	});

	it("does not fire when the file uses vi.useFakeTimers", () => {
		const code = `
beforeAll(() => { vi.useFakeTimers(); });
it("a", () => { const t = Date.now(); });
`;
		expect(checkTestNondeterminism(code, TEST)).toEqual([]);
	});

	it("does not fire on vi.setSystemTime call sites themselves", () => {
		expect(
			checkTestNondeterminism(`vi.setSystemTime(new Date(2024, 1, 1));`, TEST),
		).toEqual([]);
	});

	it("does not fire in non-test files", () => {
		expect(checkTestNondeterminism(`Date.now();`, SRC)).toEqual([]);
	});
});

describe("checkHardcodedTimeoutInTests", () => {
	it("flags setTimeout(_, 1000) in tests", () => {
		const code = `await new Promise(r => setTimeout(r, 1000));`;
		expect(checkHardcodedTimeoutInTests(code, TEST).length).toBe(1);
	});

	it("does not fire on setTimeout(_, 0) microtask flush", () => {
		expect(
			checkHardcodedTimeoutInTests(`await new Promise(r => setTimeout(r, 0));`, TEST),
		).toEqual([]);
	});

	it("does not fire in non-test files", () => {
		expect(checkHardcodedTimeoutInTests(`setTimeout(fn, 5000);`, SRC)).toEqual([]);
	});
});

describe("checkTestMissingSutImport", () => {
	it("flags a foo.test.ts that does not import ./foo", () => {
		const code = `
import { something } from "./bar.js";
it("does a thing", () => {});
`;
		const matches = checkTestMissingSutImport(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("does not fire when the SUT is imported", () => {
		const code = `
import { foo } from "./foo.js";
it("works", () => { expect(foo()).toBe(1); });
`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("does not fire when the SUT is imported via ../", () => {
		const code = `import { foo } from "../foo.js";`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("does not fire when the SUT is imported via require()", () => {
		const code = `const { foo } = require("./foo");`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("does not fire on index.test.ts (barrel file)", () => {
		expect(checkTestMissingSutImport(`it("a")`, "src/lib/index.test.ts")).toEqual([]);
	});

	it("does not fire in __fixtures__ paths", () => {
		expect(
			checkTestMissingSutImport(`it("a")`, "src/__fixtures__/foo.test.ts"),
		).toEqual([]);
	});
});

describe("checkMockingTheSutSelf", () => {
	it("flags vi.mock(\"./foo\") inside foo.test.ts", () => {
		const code = `vi.mock("./foo");`;
		const matches = checkMockingTheSutSelf(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("flags jest.mock(\"./foo\")", () => {
		expect(checkMockingTheSutSelf(`jest.mock("./foo.js");`, TEST).length).toBe(1);
	});

	it("does not fire when mocking a different module", () => {
		expect(checkMockingTheSutSelf(`vi.mock("./bar");`, TEST)).toEqual([]);
	});

	it("does not fire in production source", () => {
		expect(checkMockingTheSutSelf(`vi.mock("./foo");`, SRC)).toEqual([]);
	});
});
