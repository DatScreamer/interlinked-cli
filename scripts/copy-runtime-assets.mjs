import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const ASSETS = [
	{
		from: "src/harness/content-scanner/sidecars/opf-sidecar.py",
		to: "dist/sidecars/opf-sidecar.py",
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
