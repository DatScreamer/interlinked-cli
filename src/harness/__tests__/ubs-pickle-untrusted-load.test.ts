// Tests for `ubs_pickle_untrusted_load` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkPickleUntrustedLoad } from "../checks/ubs-language-specific.js";

describe("checkPickleUntrustedLoad", () => {
	it("flags `pickle.load(f)`", () => {
		const code = "import pickle\nobj = pickle.load(f)\n";
		const matches = checkPickleUntrustedLoad(code, "src/foo.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `pickle.loads(payload)`", () => {
		const code = "import pickle\nobj = pickle.loads(payload)\n";
		const matches = checkPickleUntrustedLoad(code, "src/foo.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `cPickle.load(f)`", () => {
		const code = "import cPickle\nobj = cPickle.load(f)\n";
		const matches = checkPickleUntrustedLoad(code, "src/foo.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `json.load(f)` (not pickle)", () => {
		const code = "import json\nobj = json.load(f)\n";
		expect(checkPickleUntrustedLoad(code, "src/foo.py")).toEqual([]);
	});

	it("does NOT fire on JS files", () => {
		const code = "pickle.load(f);";
		expect(checkPickleUntrustedLoad(code, "src/foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "pickle.load(f)";
		expect(checkPickleUntrustedLoad(code, "tests/test_foo.py")).toEqual([]);
	});

	// FP refinement (139-repo audit, 2026-05): Bandit `# noqa: S301` is
	// the explicit acknowledgment of a controlled pickle.load context.

	it("does NOT fire on `pickle.load(f)  # noqa: S301`", () => {
		const code = `import pickle\nobj = pickle.load(f)  # noqa: S301`;
		expect(checkPickleUntrustedLoad(code, "src/cache.py")).toEqual([]);
	});

	it("does NOT fire on `pickle.loads(buf)  # noqa: S301 -- trusted RPC`", () => {
		const code = `import pickle\nobj = pickle.loads(buf)  # noqa: S301 -- trusted RPC payload`;
		expect(checkPickleUntrustedLoad(code, "src/rpc.py")).toEqual([]);
	});

	it("does NOT fire on bare `# noqa`", () => {
		const code = `import pickle\nobj = pickle.loads(buf)  # noqa`;
		expect(checkPickleUntrustedLoad(code, "src/rpc.py")).toEqual([]);
	});

	// Positive cases — real positives MUST still fire.

	it("STILL fires on `pickle.load(f)` with no noqa", () => {
		const code = `import pickle\nobj = pickle.load(f)`;
		expect(checkPickleUntrustedLoad(code, "src/cache.py").length).toBeGreaterThan(0);
	});

	it("STILL fires when noqa carries an unrelated bandit code", () => {
		// S307 (eval) must NOT suppress a pickle finding.
		const code = `import pickle\nobj = pickle.loads(buf)  # noqa: S307`;
		expect(checkPickleUntrustedLoad(code, "src/cache.py").length).toBeGreaterThan(0);
	});
});
