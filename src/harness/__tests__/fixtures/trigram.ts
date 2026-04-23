import { extractTrigrams, type PostingList, TrigramIndex } from "../../trigram-index.js";

// Fixed timestamp for deterministic test fixtures. Not time-sensitive
// for these tests — only exists to satisfy the HarnessEvent shape.
export const FIXED_TIMESTAMP = "2024-01-01T00:00:00.000Z";

// Build a test index from synthetic files.
export function buildTestIndex(files: Record<string, string>): TrigramIndex {
	const filePaths = Object.keys(files);
	const postingsBuilder = new Map<number, number[]>();
	const fileArray: string[] = [];

	for (let fileId = 0; fileId < filePaths.length; fileId++) {
		const path = filePaths[fileId];
		fileArray.push(path);
		const trigrams = extractTrigrams(files[path]);
		for (const tri of trigrams) {
			let list = postingsBuilder.get(tri);
			if (!list) {
				list = [];
				postingsBuilder.set(tri, list);
			}
			list.push(fileId);
		}
	}

	const postings = new Map<number, PostingList>();
	for (const [tri, list] of postingsBuilder) {
		const fileIds = new Uint32Array(list);
		postings.set(tri, {
			fileIds,
			locMasks: new Uint8Array(fileIds.length),
			nextMasks: new Uint8Array(fileIds.length),
		});
	}

	return new TrigramIndex(fileArray, postings, new Set(), "abc123", "/tmp/test");
}
