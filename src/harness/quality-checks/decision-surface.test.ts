import { describe, expect, it } from "vitest";
import {
	detectDecisionSurface,
	detectLockfileMultiplicity,
	type DetectDecisionSurfaceOptions,
} from "./decision-surface.js";

// ===========================================
// Fixture helpers
// ===========================================
// Tests inject a virtual filesystem rather than touching disk. Every
// fixture is a map: absolute-style path → file contents. `exists`,
// `readFile`, and `readdir` are derived from it.

interface FixtureFs {
	files: Record<string, string>;
	/** Optional override of top-level entries returned by readdir. */
	topLevelEntries?: string[];
}

function makeOptions(fs: FixtureFs): DetectDecisionSurfaceOptions {
	return {
		readFile: (path) => (path in fs.files ? (fs.files[path] ?? null) : null),
		exists: (path) => path in fs.files,
		readdir: () => {
			if (fs.topLevelEntries) return fs.topLevelEntries;
			const root = "/repo";
			const prefix = `${root}/`;
			const entries = new Set<string>();
			for (const path of Object.keys(fs.files)) {
				if (!path.startsWith(prefix)) continue;
				const rest = path.slice(prefix.length);
				const next = rest.split("/")[0];
				if (next) entries.add(next);
			}
			return [...entries];
		},
	};
}

function pkgJson(sections: {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}): string {
	return JSON.stringify(sections, null, 2);
}

// ===========================================
// Tests
// ===========================================

describe("detectDecisionSurface — empty / baseline cases", () => {
	it("returns all categories empty when nothing is present", () => {
		const opts = makeOptions({ files: {} });
		const report = detectDecisionSurface("/repo", opts);
		expect(report.totalSurface).toBe(0);
		expect(report.byCategory.package_manager).toEqual([]);
		expect(report.byCategory.test_framework).toEqual([]);
		expect(report.byCategory.linter).toEqual([]);
		expect(report.byCategory.formatter).toEqual([]);
		expect(report.byCategory.bundler).toEqual([]);
		expect(report.byCategory.http_client).toEqual([]);
		expect(report.byCategory.date_lib).toEqual([]);
	});

	it("returns projectRoot unchanged", () => {
		const report = detectDecisionSurface("/some/path", makeOptions({ files: {} }));
		expect(report.projectRoot).toBe("/some/path");
	});

	it("returns all 7 categories even when empty", () => {
		const report = detectDecisionSurface("/repo", makeOptions({ files: {} }));
		expect(Object.keys(report.byCategory).sort()).toEqual([
			"bundler",
			"date_lib",
			"formatter",
			"http_client",
			"linter",
			"package_manager",
			"test_framework",
		]);
	});
});

describe("detectDecisionSurface — test_framework", () => {
	it("detects vitest from devDependencies", () => {
		const fs = { files: { "/repo/package.json": pkgJson({ devDependencies: { vitest: "^1.0.0" } }) } };
		const report = detectDecisionSurface("/repo", makeOptions(fs));
		expect(report.byCategory.test_framework).toEqual(["vitest"]);
	});

	it("detects jest from dependencies", () => {
		const fs = { files: { "/repo/package.json": pkgJson({ dependencies: { jest: "29.0.0" } }) } };
		const report = detectDecisionSurface("/repo", makeOptions(fs));
		expect(report.byCategory.test_framework).toEqual(["jest"]);
	});

	it("detects mocha + ava + tap simultaneously (multi-framework repo)", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({
					devDependencies: { mocha: "^10", ava: "^5", tap: "^16" },
				}),
			},
		};
		const report = detectDecisionSurface("/repo", makeOptions(fs));
		expect(report.byCategory.test_framework).toEqual(["ava", "mocha", "tap"]);
	});

	it("does NOT count @types/jest, @vitest/coverage, or @nestjs/testing", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({
					devDependencies: {
						"@types/jest": "^29",
						"@vitest/coverage-v8": "^1",
						"@nestjs/testing": "^10",
					},
				}),
			},
		};
		const report = detectDecisionSurface("/repo", makeOptions(fs));
		expect(report.byCategory.test_framework).toEqual([]);
	});

	it("does NOT count unrelated packages (lodash, react)", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({
					dependencies: { lodash: "^4", react: "^18" },
				}),
			},
		};
		const report = detectDecisionSurface("/repo", makeOptions(fs));
		expect(report.byCategory.test_framework).toEqual([]);
	});

	it("does NOT count test framework when only a partial-match name appears", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({
					dependencies: { "vitest-fetch-mock": "^1" }, // adjacent name, not vitest itself
				}),
			},
		};
		const report = detectDecisionSurface("/repo", makeOptions(fs));
		expect(report.byCategory.test_framework).toEqual([]);
	});
});

describe("detectDecisionSurface — linter / formatter", () => {
	it("detects eslint", () => {
		const fs = { files: { "/repo/package.json": pkgJson({ devDependencies: { eslint: "^9" } }) } };
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.linter).toEqual(["eslint"]);
	});

	it("detects oxlint + xo together", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({ devDependencies: { oxlint: "^0.5", xo: "^0.55" } }),
			},
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.linter).toEqual(["oxlint", "xo"]);
	});

	it("detects prettier in formatter only", () => {
		const fs = { files: { "/repo/package.json": pkgJson({ devDependencies: { prettier: "^3" } }) } };
		const report = detectDecisionSurface("/repo", makeOptions(fs));
		expect(report.byCategory.formatter).toEqual(["prettier"]);
		expect(report.byCategory.linter).toEqual([]);
	});

	it("counts biome in BOTH linter and formatter (dual-role)", () => {
		const fs = {
			files: { "/repo/package.json": pkgJson({ devDependencies: { "@biomejs/biome": "^1" } }) },
		};
		const report = detectDecisionSurface("/repo", makeOptions(fs));
		expect(report.byCategory.linter).toEqual(["biome"]);
		expect(report.byCategory.formatter).toEqual(["biome"]);
	});

	it("does NOT count @typescript-eslint/parser as a linter (it's a plugin)", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({
					devDependencies: { "@typescript-eslint/parser": "^7", "@typescript-eslint/eslint-plugin": "^7" },
				}),
			},
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.linter).toEqual([]);
	});

	it("does NOT count prettier plugins", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({
					devDependencies: { "prettier-plugin-organize-imports": "^4" },
				}),
			},
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.formatter).toEqual([]);
	});
});

describe("detectDecisionSurface — bundler", () => {
	it("detects vite + esbuild + tsup together", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({
					devDependencies: { vite: "^5", esbuild: "^0.21", tsup: "^8" },
				}),
			},
		};
		const report = detectDecisionSurface("/repo", makeOptions(fs));
		expect(report.byCategory.bundler).toEqual(["esbuild", "tsup", "vite"]);
	});

	it("does NOT count @rollup/plugin-typescript", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({ devDependencies: { "@rollup/plugin-typescript": "^11" } }),
			},
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.bundler).toEqual([]);
	});

	it("does NOT count vite-plugin-react", () => {
		const fs = {
			files: { "/repo/package.json": pkgJson({ devDependencies: { "vite-plugin-react": "^4" } }) },
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.bundler).toEqual([]);
	});

	it("does NOT count nx, turbo (monorepo orchestrators, not bundlers)", () => {
		const fs = {
			files: { "/repo/package.json": pkgJson({ devDependencies: { nx: "^19", turbo: "^2" } }) },
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.bundler).toEqual([]);
	});
});

describe("detectDecisionSurface — http_client", () => {
	it("detects axios in dependencies", () => {
		const fs = { files: { "/repo/package.json": pkgJson({ dependencies: { axios: "^1" } }) } };
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.http_client).toEqual(["axios"]);
	});

	it("detects axios + got + ky simultaneously (a real decision-surface explosion)", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({
					dependencies: { axios: "^1", got: "^14", ky: "^1" },
				}),
			},
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.http_client).toEqual([
			"axios",
			"got",
			"ky",
		]);
	});

	it("detects undici (which competes with native fetch)", () => {
		const fs = { files: { "/repo/package.json": pkgJson({ dependencies: { undici: "^6" } }) } };
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.http_client).toEqual(["undici"]);
	});

	it("does NOT count fetch-mock or @whatwg-node/fetch (test/polyfill)", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({
					devDependencies: { "fetch-mock": "^10", "@whatwg-node/fetch": "^0.9" },
				}),
			},
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.http_client).toEqual([]);
	});

	it("does NOT count axios-retry, ky-universal (extension libs)", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({
					dependencies: { "axios-retry": "^4", "ky-universal": "^0.12" },
				}),
			},
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.http_client).toEqual([]);
	});

	it("does NOT count unrelated network libs (ws, socket.io)", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({ dependencies: { ws: "^8", "socket.io": "^4" } }),
			},
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.http_client).toEqual([]);
	});
});

describe("detectDecisionSurface — date_lib", () => {
	it("detects moment", () => {
		const fs = { files: { "/repo/package.json": pkgJson({ dependencies: { moment: "^2" } }) } };
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.date_lib).toEqual(["moment"]);
	});

	it("detects moment + dayjs + date-fns (migration in flight)", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({
					dependencies: { moment: "^2", dayjs: "^1", "date-fns": "^3" },
				}),
			},
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.date_lib).toEqual([
			"date-fns",
			"dayjs",
			"moment",
		]);
	});

	it("detects luxon", () => {
		const fs = { files: { "/repo/package.json": pkgJson({ dependencies: { luxon: "^3" } }) } };
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.date_lib).toEqual(["luxon"]);
	});

	it("does NOT count moment-timezone (extension)", () => {
		const fs = {
			files: { "/repo/package.json": pkgJson({ dependencies: { "moment-timezone": "^0.5" } }) },
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.date_lib).toEqual([]);
	});

	it("does NOT count date-fns-tz (timezone plugin)", () => {
		const fs = {
			files: { "/repo/package.json": pkgJson({ dependencies: { "date-fns-tz": "^3" } }) },
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.date_lib).toEqual([]);
	});

	it("does NOT count @internationalized/date (i18n adjunct)", () => {
		const fs = {
			files: { "/repo/package.json": pkgJson({ dependencies: { "@internationalized/date": "^3" } }) },
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.date_lib).toEqual([]);
	});
});

describe("detectDecisionSurface — package_manager (lockfiles)", () => {
	it("detects npm from package-lock.json", () => {
		const fs = { files: { "/repo/package-lock.json": "{}" } };
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.package_manager).toEqual(["npm"]);
	});

	it("detects pnpm from pnpm-lock.yaml", () => {
		const fs = { files: { "/repo/pnpm-lock.yaml": "lockfileVersion: 9" } };
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.package_manager).toEqual([
			"pnpm",
		]);
	});

	it("flags lockfile multiplicity (npm + pnpm + yarn + bun)", () => {
		const fs = {
			files: {
				"/repo/package-lock.json": "{}",
				"/repo/pnpm-lock.yaml": "lockfileVersion: 9",
				"/repo/yarn.lock": "",
				"/repo/bun.lockb": "",
			},
		};
		const report = detectDecisionSurface("/repo", makeOptions(fs));
		expect(report.byCategory.package_manager).toEqual(["bun", "npm", "pnpm", "yarn"]);
	});

	it("deduplicates bun.lockb + bun.lock to a single 'bun' entry", () => {
		const fs = { files: { "/repo/bun.lockb": "", "/repo/bun.lock": "" } };
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.package_manager).toEqual([
			"bun",
		]);
	});

	it("does NOT detect a package manager when no lockfile exists", () => {
		const fs = { files: { "/repo/package.json": pkgJson({}) } };
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.package_manager).toEqual([]);
	});
});

describe("detectDecisionSurface — config file signals dedup with package.json", () => {
	it("vitest in deps + vitest.config.ts produces one entry, not two", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({ devDependencies: { vitest: "^1" } }),
				"/repo/vitest.config.ts": "export default {}",
			},
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.test_framework).toEqual([
			"vitest",
		]);
	});

	it("biome.json alone (no package.json entry) still credits both linter and formatter", () => {
		const fs = { files: { "/repo/biome.json": "{}" } };
		const report = detectDecisionSurface("/repo", makeOptions(fs));
		expect(report.byCategory.linter).toEqual(["biome"]);
		expect(report.byCategory.formatter).toEqual(["biome"]);
	});

	it("eslint.config.js alone detects eslint as linter", () => {
		const fs = { files: { "/repo/eslint.config.js": "export default []" } };
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.linter).toEqual(["eslint"]);
	});

	it("ignores config files in subdirectories (top-level only)", () => {
		const fs = {
			files: { "/repo/packages/app/vitest.config.ts": "" },
			topLevelEntries: ["packages"],
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.test_framework).toEqual([]);
	});
});

describe("detectDecisionSurface — robustness", () => {
	it("absorbs malformed package.json without crashing", () => {
		const fs = { files: { "/repo/package.json": "{not valid json,," } };
		const report = detectDecisionSurface("/repo", makeOptions(fs));
		expect(report.totalSurface).toBe(0);
	});

	it("absorbs non-object package.json (array, string, null)", () => {
		expect(
			detectDecisionSurface("/repo", makeOptions({ files: { "/repo/package.json": "[]" } }))
				.totalSurface,
		).toBe(0);
		expect(
			detectDecisionSurface("/repo", makeOptions({ files: { "/repo/package.json": '"hi"' } }))
				.totalSurface,
		).toBe(0);
		expect(
			detectDecisionSurface("/repo", makeOptions({ files: { "/repo/package.json": "null" } }))
				.totalSurface,
		).toBe(0);
	});

	it("absorbs non-object dep sections", () => {
		const content = JSON.stringify({ dependencies: "broken", devDependencies: ["wrong"] });
		const fs = { files: { "/repo/package.json": content } };
		expect(detectDecisionSurface("/repo", makeOptions(fs)).totalSurface).toBe(0);
	});

	it("counts a package present in multiple dep sections only once", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({
					dependencies: { vitest: "^1" },
					devDependencies: { vitest: "^1" },
					peerDependencies: { vitest: "^1" },
				}),
			},
		};
		expect(detectDecisionSurface("/repo", makeOptions(fs)).byCategory.test_framework).toEqual([
			"vitest",
		]);
	});

	it("output arrays are sorted deterministically", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({
					devDependencies: { vitest: "^1", jest: "^29", mocha: "^10", ava: "^5" },
				}),
			},
		};
		const report = detectDecisionSurface("/repo", makeOptions(fs));
		expect(report.byCategory.test_framework).toEqual(["ava", "jest", "mocha", "vitest"]);
	});
});

describe("detectLockfileMultiplicity", () => {
	function existsFromFiles(files: string[]): (path: string) => boolean {
		const set = new Set(files);
		return (path) => set.has(path);
	}

	it("reports no multiplicity when zero lockfiles are present", () => {
		const result = detectLockfileMultiplicity("/repo", { exists: () => false });
		expect(result.multiplicity).toBe(false);
		expect(result.lockfiles).toEqual([]);
		expect(result.managers).toEqual([]);
	});

	it("reports no multiplicity for a single lockfile", () => {
		const result = detectLockfileMultiplicity("/repo", {
			exists: existsFromFiles(["/repo/package-lock.json"]),
		});
		expect(result.multiplicity).toBe(false);
		expect(result.lockfiles).toEqual(["package-lock.json"]);
		expect(result.managers).toEqual(["npm"]);
	});

	it("flags multiplicity when npm + pnpm coexist", () => {
		const result = detectLockfileMultiplicity("/repo", {
			exists: existsFromFiles(["/repo/package-lock.json", "/repo/pnpm-lock.yaml"]),
		});
		expect(result.multiplicity).toBe(true);
		expect(result.managers).toEqual(["npm", "pnpm"]);
		expect(result.lockfiles).toEqual(["package-lock.json", "pnpm-lock.yaml"]);
	});

	it("flags multiplicity across all four managers", () => {
		const result = detectLockfileMultiplicity("/repo", {
			exists: existsFromFiles([
				"/repo/package-lock.json",
				"/repo/pnpm-lock.yaml",
				"/repo/yarn.lock",
				"/repo/bun.lockb",
			]),
		});
		expect(result.multiplicity).toBe(true);
		expect(result.managers).toEqual(["bun", "npm", "pnpm", "yarn"]);
	});

	it("does NOT flag bun.lockb + bun.lock as multiplicity (same manager, two formats)", () => {
		const result = detectLockfileMultiplicity("/repo", {
			exists: existsFromFiles(["/repo/bun.lockb", "/repo/bun.lock"]),
		});
		expect(result.multiplicity).toBe(false);
		expect(result.managers).toEqual(["bun"]);
		expect(result.lockfiles).toEqual(["bun.lock", "bun.lockb"]);
	});

	it("returns sorted lockfile basenames for stable output", () => {
		const result = detectLockfileMultiplicity("/repo", {
			exists: existsFromFiles([
				"/repo/yarn.lock",
				"/repo/package-lock.json",
				"/repo/pnpm-lock.yaml",
			]),
		});
		expect(result.lockfiles).toEqual(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
	});

	it("with default exists, returns no multiplicity on a nonexistent path", () => {
		const result = detectLockfileMultiplicity("/nonexistent-dir-do-not-create-12345");
		expect(result.multiplicity).toBe(false);
		expect(result.lockfiles).toEqual([]);
	});
});

describe("detectDecisionSurface — totalSurface composition", () => {
	it("counts a fully narrow repo (1 of each) correctly", () => {
		const fs = {
			files: {
				"/repo/package.json": pkgJson({
					devDependencies: {
						vitest: "^1",
						"@biomejs/biome": "^1", // counts as linter + formatter (2 categories)
						tsup: "^8",
						axios: "^1",
						dayjs: "^1",
					},
				}),
				"/repo/package-lock.json": "{}",
			},
		};
		const report = detectDecisionSurface("/repo", makeOptions(fs));
		// 1 pm + 1 test + 1 linter + 1 formatter + 1 bundler + 1 http + 1 date = 7
		expect(report.totalSurface).toBe(7);
	});

	it("a 'pick one of each' repo + an alternative for one category = total grows by 1", () => {
		const narrow = {
			files: {
				"/repo/package.json": pkgJson({
					devDependencies: { vitest: "^1", eslint: "^9", prettier: "^3", tsup: "^8" },
				}),
				"/repo/package-lock.json": "{}",
			},
		};
		const expanded = {
			files: {
				"/repo/package.json": pkgJson({
					devDependencies: {
						vitest: "^1",
						jest: "^29", // <-- second test framework
						eslint: "^9",
						prettier: "^3",
						tsup: "^8",
					},
				}),
				"/repo/package-lock.json": "{}",
			},
		};
		const narrowReport = detectDecisionSurface("/repo", makeOptions(narrow));
		const expandedReport = detectDecisionSurface("/repo", makeOptions(expanded));
		expect(expandedReport.totalSurface).toBe(narrowReport.totalSurface + 1);
		expect(expandedReport.byCategory.test_framework).toEqual(["jest", "vitest"]);
	});
});
