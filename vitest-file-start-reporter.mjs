// Diagnostic reporter (2026-07): names each test file as it STARTS and ENDS,
// so a file that hangs (starts, never ends) is identifiable from the CI log.
// The unit-lane Linux-only hang — a leaked `node` grandchild holds vitest's
// stdio pipe so the file never finishes — does not reproduce on macOS, so we
// pinpoint it on the CI runner: the last [FILE-START] with no matching
// [FILE-END] is the culprit. Remove once the hang is fixed.
//
// Vitest instantiates a path-loaded reporter with `new`, so this must be a class.
export default class FileStartReporter {
	onTestModuleStart(testModule) {
		process.stderr.write(`[FILE-START] ${testModule?.moduleId ?? "?"}\n`);
	}
	onTestModuleEnd(testModule) {
		process.stderr.write(`[FILE-END] ${testModule?.moduleId ?? "?"}\n`);
	}
}
