import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const STUBS = ["index.d.ts", "harness/server.d.ts"];

// Public build-finalizer seam consumed by the failure-atomic distribution builder.
export function fixDistDts(outputDirectory = join(process.cwd(), "dist")) {
    const outputRoot = resolve(outputDirectory);
    for (const rel of STUBS) {
        const path = join(outputRoot, rel);
        if (existsSync(path)) {
            writeFileSync(path, "export {};\n");
        }
    }
}
