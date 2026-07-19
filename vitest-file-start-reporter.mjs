// Diagnostic reporter (2026-07): names each test FILE and each test CASE as it
// starts/ends, in real time from the main process (so buffered per-file worker
// output can't hide a hang). The unit-lane Linux-only hang — one test never
// finishes on the CI runner but passes at CI=1 on macOS — is pinpointed from
// the CI log: the last [FILE-START]/[CASE-START] with no matching END is the
// culprit. Vitest instantiates a path-loaded reporter with `new`, so this is a
// class. Remove once the hang is fixed.
export default class FileStartReporter {
	onTestModuleStart(testModule) {
		process.stderr.write(`[FILE-START] ${testModule?.moduleId ?? "?"}\n`);
	}
	onTestModuleEnd(testModule) {
		process.stderr.write(`[FILE-END] ${testModule?.moduleId ?? "?"}\n`);
	}
	onTestCaseReady(testCase) {
		process.stderr.write(`[CASE-START] ${testCase?.name ?? "?"}\n`);
	}
	onTestCaseResult(testCase) {
		process.stderr.write(`[CASE-END] ${testCase?.name ?? "?"}\n`);
	}
}
