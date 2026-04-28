import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// Runtime assets that must accompany the bundled JS in `dist/`. The OPF
// content-scanner's default config (`harness/rules/default-config.ts`)
// passes `viterbi_calibration_path: HIGH_PRECISION_OPF_CALIBRATION_PATH`
// into the sidecar by default — so the calibration JSON has to ship in
// installed packages too, not just the Python script. Resolver layouts
// covered: `dist/sidecars/<file>` and `dist/sidecars/calibrations/<file>`
// (see `resolveDefaultOpfSidecarScript` / `resolveDefaultOpfCalibrationPath`).
const ASSETS = [
	{
		from: "src/harness/content-scanner/sidecars/opf-sidecar.py",
		to: "dist/sidecars/opf-sidecar.py",
	},
	{
		from: "src/harness/content-scanner/sidecars/calibrations/default.json",
		to: "dist/sidecars/calibrations/default.json",
	},
	{
		from: "src/harness/content-scanner/sidecars/calibrations/high_precision.json",
		to: "dist/sidecars/calibrations/high_precision.json",
	},
	// The /enforce skill body — copied so `findEnforceSkillSource()` in
	// `src/lib/skill-installers.ts` can resolve it at runtime in the
	// published package (the dev path lives at `<repo>/skills/...`).
	{
		from: "skills/enforce/SKILL.md",
		to: "dist/skills/enforce/SKILL.md",
	},
];

for (const asset of ASSETS) {
	const src = join(process.cwd(), asset.from);
	const dest = join(process.cwd(), asset.to);
	if (!existsSync(src)) {
		throw new Error(`Runtime asset missing: ${asset.from}`);
	}
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(src, dest);
}
