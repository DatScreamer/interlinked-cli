// ===========================================
// allowlist add — screens inspect the version being APPROVED (round 6)
// ===========================================
// `--version-range` approves a pinned release, but the metadata/OSV screens
// inspected only the registry LATEST — a clean, permissively-licensed latest
// could approve a vulnerable or differently-licensed pinned release (finding
// 2026-06: screen/approve identity mismatch). These tests pin: the OSV query
// targets the pinned resolution, the license screen reads the pinned
// version's manifest, and an unresolvable range falls back to latest LOUDLY.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAllowlist } from "../../harness/package-allowlist.js";
import { nonNull } from "../../lib/non-null.js";

const fetchRegistryMetadataMock = vi.fn();
const fetchVersionMetadataMock = vi.fn();
const queryOsvAdvisoriesMock = vi.fn();
// libyear screen (screen 4): null ⇒ "publish-date fetch failed — skipped",
// which keeps these version-screen cases focused on screens 2–3.
const fetchNpmPublishDatesMock = vi.fn(async (..._args: unknown[]) => null);

vi.mock("../../harness/registry-metadata.js", () => ({
	fetchRegistryMetadata: (...args: unknown[]) => fetchRegistryMetadataMock(...args),
	fetchVersionMetadata: (...args: unknown[]) => fetchVersionMetadataMock(...args),
	queryOsvAdvisories: (...args: unknown[]) => queryOsvAdvisoriesMock(...args),
	fetchNpmPublishDates: (...args: unknown[]) => fetchNpmPublishDatesMock(...args),
}));

// Imported after the mock is registered.
const { addAllowlistCommand } = await import("../allowlist.js");

let cwd: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "allowlist-screen-"));
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	fetchRegistryMetadataMock.mockReset();
	fetchVersionMetadataMock.mockReset();
	queryOsvAdvisoriesMock.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	rmSync(cwd, { recursive: true, force: true });
});

function stdoutText(): string {
	return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
}

// resolveScreenVersion's own unit tests live in
// `src/harness/package-version-range.test.ts` (it moved out of allowlist.ts so
// the command file stays under the per-file line cap). These integration tests
// exercise it indirectly through the pinned-version admission screens.

describe("addAllowlistCommand — version-targeted screens", () => {
	it("queries OSV for the PINNED version and refuses on its advisories, even when latest is clean", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "9.9.9", license: "MIT" });
		fetchVersionMetadataMock.mockResolvedValue({ latestVersion: "1.2.3", license: "MIT" });
		queryOsvAdvisoriesMock.mockResolvedValue([{ id: "GHSA-xxxx-old-vuln" }]);

		await expect(
			addAllowlistCommand("npm", "internal-widget-lib", {
				cwd,
				by: "tester",
				versionRange: "^1.2.3",
			}),
		).rejects.toThrow(/pinned 1\.2\.3.*GHSA-xxxx-old-vuln/);

		expect(queryOsvAdvisoriesMock).toHaveBeenCalledWith("npm", "internal-widget-lib", "1.2.3");
	});

	it("screens the PINNED version's license, not the latest release's", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "9.9.9", license: "MIT" });
		fetchVersionMetadataMock.mockResolvedValue({ latestVersion: "1.2.3", license: "AGPL-3.0-only" });
		queryOsvAdvisoriesMock.mockResolvedValue([]);

		await expect(
			addAllowlistCommand("npm", "internal-widget-lib", {
				cwd,
				by: "tester",
				versionRange: "1.2.3",
			}),
		).rejects.toThrow(/AGPL-3\.0-only/);

		expect(fetchVersionMetadataMock).toHaveBeenCalledWith("npm", "internal-widget-lib", "1.2.3");
	});

	it("without --version-range, screens the latest (the unpinned install target)", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "9.9.9", license: "MIT" });
		queryOsvAdvisoriesMock.mockResolvedValue([]);

		await addAllowlistCommand("npm", "internal-widget-lib", { cwd, by: "tester" });

		expect(queryOsvAdvisoriesMock).toHaveBeenCalledWith("npm", "internal-widget-lib", "9.9.9");
		expect(fetchVersionMetadataMock).not.toHaveBeenCalled();
	});

	it("falls back to latest LOUDLY when the range has no version literal", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "9.9.9", license: "MIT" });
		queryOsvAdvisoriesMock.mockResolvedValue([]);

		await addAllowlistCommand("npm", "internal-widget-lib", {
			cwd,
			by: "tester",
			versionRange: "*",
		});

		expect(queryOsvAdvisoriesMock).toHaveBeenCalledWith("npm", "internal-widget-lib", "9.9.9");
		expect(stdoutText()).toContain("not statically resolvable");
	});

	it("records which version the screens inspected on a pinned approval", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "9.9.9", license: "MIT" });
		fetchVersionMetadataMock.mockResolvedValue({ latestVersion: "1.2.3", license: "MIT" });
		queryOsvAdvisoriesMock.mockResolvedValue([]);

		await addAllowlistCommand("npm", "internal-widget-lib", {
			cwd,
			by: "tester",
			versionRange: "^1.2.3",
		});

		expect(stdoutText()).toContain('screens inspected pinned 1.2.3 (resolved from "^1.2.3")');
	});

	it("does NOT record the latest license when the PINNED version's license is unavailable", async () => {
		// Latest is MIT, but the pinned 1.2.3's version metadata carries no license
		// (offline / transient lookup failure). The latest's MIT must NOT be stamped
		// onto the pinned entry — an older release can be differently licensed, and
		// later hook checks trust ONLY the recorded field (finding 2026-06, round 9).
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "9.9.9", license: "MIT" });
		fetchVersionMetadataMock.mockResolvedValue({ latestVersion: "1.2.3" }); // license undefined
		queryOsvAdvisoriesMock.mockResolvedValue([]);

		await addAllowlistCommand("npm", "internal-widget-lib", {
			cwd,
			by: "tester",
			versionRange: "1.2.3",
		});

		// Recorded with NO license (not the latest release's MIT), and the note says so.
		expect(nonNull(loadAllowlist(cwd).packages.npm["internal-widget-lib"]).license).toBeUndefined();
		expect(stdoutText()).toMatch(/license for pinned 1\.2\.3 unavailable/);
	});
});
