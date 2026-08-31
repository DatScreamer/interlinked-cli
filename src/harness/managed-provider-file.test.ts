import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    isManagedProviderFile,
    managedProviderFileHash,
    MANAGED_PROVIDER_FILE_MARKER,
    removeManagedProviderFile,
} from "./managed-provider-file.js";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(content: string): string {
    const root = mkdtempSync(join(tmpdir(), "interlinked-managed-provider-"));
    roots.push(root);
    const path = join(root, "interlinked.js");
    writeFileSync(path, content);
    return path;
}

describe("managed provider file ownership", () => {
    const managed = `${MANAGED_PROVIDER_FILE_MARKER}\nexport default {};\n`;

    it("requires the exact ownership sentinel on the first line", () => {
        expect(isManagedProviderFile(managed)).toBe(true);
        expect(isManagedProviderFile(`// prefix\n${managed}`)).toBe(false);
        expect(isManagedProviderFile("// interlinked-provider-bridge:v2\n")).toBe(false);
    });

    it("hashes content deterministically", () => {
        expect(managedProviderFileHash(managed)).toMatch(/^[a-f0-9]{64}$/);
        expect(managedProviderFileHash(managed)).toBe(managedProviderFileHash(managed));
        expect(managedProviderFileHash(`${managed}changed`)).not.toBe(managedProviderFileHash(managed));
    });

    it("removes only an unmodified owned file", () => {
        const path = fixture(managed);
        expect(removeManagedProviderFile(path, managedProviderFileHash(managed), false)).toBe("removed");
        expect(existsSync(path)).toBe(false);
        expect(removeManagedProviderFile(path, undefined, false)).toBe("missing");
    });

    it("preserves foreign and user-modified files", () => {
        const foreign = fixture("export default {};\n");
        expect(removeManagedProviderFile(foreign, undefined, false)).toBe("foreign");
        expect(existsSync(foreign)).toBe(true);

        const modified = fixture(`${managed}// local edit\n`);
        expect(removeManagedProviderFile(modified, managedProviderFileHash(managed), false)).toBe("modified");
        expect(readFileSync(modified, "utf-8")).toContain("local edit");
    });

    it("reports a dry-run removal without changing the file", () => {
        const path = fixture(managed);
        expect(removeManagedProviderFile(path, undefined, true)).toBe("removed");
        expect(readFileSync(path, "utf-8")).toBe(managed);
    });
});
