import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STUBS = ["dist/index.d.ts", "dist/harness/server.d.ts"];

for (const rel of STUBS) {
	const path = join(process.cwd(), rel);
	if (existsSync(path)) {
		writeFileSync(path, "export {};\n");
	}
}
