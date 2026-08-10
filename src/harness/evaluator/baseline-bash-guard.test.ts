// Red-team F1 (docs/design/red-team-findings-2026-08-09.md): the
// baseline-integrity gate only ran on Write/Edit/MultiEdit, so ANY shell write
// to a ratchet water-line was allowed — measured live: redirect, sed -i, tee,
// cp, and an interpreter one-liner all returned `allow`, which defeats every
// ratchet at once.
//
// The refusal here is now scoped by REVERSIBILITY (2026-08-10). A recoverable
// shell write is no longer refused: the effect arm snapshots the water-lines
// before the call, so a loosening is undoable and inert
// (baseline-effect-guard.ts), and refusing it would also refuse the legitimate
// case this gate cannot see pre-execution — TIGHTENING a water-line from the
// shell. What still blocks here is the irreversible command, because no
// post-hoc evidence brings those bytes back.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baselineBashWriteRefusal } from "./baseline-bash-guard.js";

const ROOT = "/repo";
const CAPS = "/repo/.interlinked/metric-caps.json";

describe("baselineBashWriteRefusal — positive (must refuse: irreversible)", () => {
	it("P1: a recursive delete of a baseline cannot be undone", () => {
		expect(baselineBashWriteRefusal(`rm -rf ${CAPS}`, ROOT)).toContain("metric-caps.json");
	});

	it("P2: dd over a baseline destroys the prior bytes", () => {
		expect(baselineBashWriteRefusal(`dd if=/tmp/x.json of=${CAPS}`, ROOT)).toContain(
			"metric-caps.json",
		);
	});

	it("P3: the refusal names the irreversibility, not a generic denial", () => {
		expect(baselineBashWriteRefusal(`rm -rf ${CAPS}`, ROOT)).toContain("cannot be undone");
	});
});

describe("baselineBashWriteRefusal — negative (reversible: deferred to the effect arm)", () => {
	it("N1: a shell redirect is recoverable, so it is not refused here", () => {
		expect(baselineBashWriteRefusal(`echo '{}' > ${CAPS}`, ROOT)).toBeNull();
	});

	it("N2: tee is recoverable", () => {
		expect(baselineBashWriteRefusal(`echo '{}' | tee ${CAPS}`, ROOT)).toBeNull();
	});

	it("N3: in-place sed is recoverable", () => {
		expect(baselineBashWriteRefusal(`sed -i '' s/22/999/ ${CAPS}`, ROOT)).toBeNull();
	});

	it("N4: cp is recoverable", () => {
		expect(baselineBashWriteRefusal(`cp /tmp/x.json ${CAPS}`, ROOT)).toBeNull();
	});

	it("N5: an interpreter one-liner is recoverable", () => {
		const cmd = `python3 -c "open('${CAPS}','w').write('x')"`;
		expect(baselineBashWriteRefusal(cmd, ROOT)).toBeNull();
	});

	it("N6: TIGHTENING from the shell — the case a pre-execution refusal cannot distinguish", () => {
		expect(baselineBashWriteRefusal(`echo '{"max_cyclomatic":18}' > ${CAPS}`, ROOT)).toBeNull();
	});
});

describe("baselineBashWriteRefusal — negative (not this gate's business)", () => {
	it("N7: reading a baseline is untouched", () => {
		expect(baselineBashWriteRefusal(`cat ${CAPS}`, ROOT)).toBeNull();
	});

	it("N8: an irreversible command on a NON-baseline path is not this gate's business", () => {
		expect(baselineBashWriteRefusal("rm -rf /repo/.interlinked/activity.jsonl", ROOT)).toBeNull();
	});

	it("N9: an irreversible command on ordinary source is not this gate's business", () => {
		expect(baselineBashWriteRefusal("rm -rf /repo/src/foo.ts", ROOT)).toBeNull();
	});

	it("N10: a baseline path merely mentioned with no write mechanism", () => {
		expect(baselineBashWriteRefusal(`rg pattern ${CAPS}`, ROOT)).toBeNull();
	});

	it("N11: a baseline-like path outside .interlinked", () => {
		expect(baselineBashWriteRefusal("rm -rf /repo/docs/metric-caps.json", ROOT)).toBeNull();
	});

	it("N12: an empty command", () => {
		expect(baselineBashWriteRefusal("", ROOT)).toBeNull();
	});
});

describe("baselineBashWriteRefusal — bypass", () => {
	const prior = process.env.INTERLINKED_DISABLE_BASELINE_GUARD;

	beforeEach(() => {
		process.env.INTERLINKED_DISABLE_BASELINE_GUARD = "1";
	});

	afterEach(() => {
		if (prior === undefined) delete process.env.INTERLINKED_DISABLE_BASELINE_GUARD;
		else process.env.INTERLINKED_DISABLE_BASELINE_GUARD = prior;
	});

	it("N13: the documented reset env var disables even the irreversible refusal", () => {
		expect(baselineBashWriteRefusal(`rm -rf ${CAPS}`, ROOT)).toBeNull();
	});
});
