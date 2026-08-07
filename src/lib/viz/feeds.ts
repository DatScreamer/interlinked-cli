// ===========================================
// Viz Feeds — one descriptor per live lens
// ===========================================
// The dashboard has several independent live streams (tool activity, gate
// decisions, ordered test results, mutants). They differ only in WHICH file they
// tail and HOW a line maps to an event, so each is declared as a `VizFeed`
// descriptor and the server hosts them all through one generic SSE path. Adding
// a lens is a descriptor here, not another copy of the plumbing.

import { join } from "node:path";
import { type AgentPresence, AgentRoster } from "./agent-roster.js";
import {
	createActivityTailer,
	createChecksTailer,
	seedRecentChecks,
	seedRecentEvents,
} from "./event-stream.js";
import { createMutantWatcher, type MutantEvent, readMutantSnapshot } from "./mutation-feed.js";
import { createTestTailer, seedRecentTestEvents } from "./test-events.js";

/** A live stream the dashboard can subscribe to over SSE. */
export interface VizFeed {
	/** HTTP path the browser opens an EventSource against. */
	route: string;
	/** SSE hello comment — visible in devtools, names the stream. */
	hello: string;
	/** Recent backlog replayed to a joining client, oldest first. */
	seed: () => unknown[];
	/** Start delivering new events; the returned handle stops delivery. */
	subscribe: (onEvent: (ev: unknown) => void) => { stop: () => void };
}

/** Backlog size replayed to a joining client. Enough to fill a screen, not a log. */
export const SEED_EVENTS = 40;

/** Test-feed backlog. Larger: a run emits a burst, and the lens is about order. */
export const SEED_TESTS = 120;

/** Resolved locations of every file the feeds read. All overridable for tests. */
export interface FeedPaths {
	activity: string;
	checkResults: string;
	testEvents: string;
	mutationManifest: string;
}

/** Default feed paths under a project root's `.interlinked/` directory. */
export function defaultFeedPaths(root: string): FeedPaths {
	const dir = join(root, ".interlinked");
	return {
		activity: join(dir, "activity.jsonl"),
		checkResults: join(dir, "check-results.jsonl"),
		testEvents: join(dir, "test-events.jsonl"),
		mutationManifest: join(dir, "mutation-manifest.json"),
	};
}

/**
 * Seed the mutant lens with the manifest's CURRENT state, framed as `born`
 * events so a joining client renders the existing wall before any live flip.
 */
export function seedMutants(path: string): MutantEvent[] {
	return readMutantSnapshot(path).mutants.map((mutant) => ({ kind: "born", mutant }));
}

/**
 * Build the presence feed: fold the activity stream into per-actor lanes and
 * emit the UPDATED lane on every event. The roster is per-feed (one fold shared
 * by all connected browsers); the seed replays the backlog through the same fold
 * so a joining client gets the current roster, one presence per actor.
 */
export function buildAgentFeed(activityPath: string, pollMs: number): VizFeed {
	const roster = new AgentRoster();
	return {
		route: "/api/agents",
		hello: "interlinked agent presence",
		seed: (): AgentPresence[] => {
			for (const ev of seedRecentEvents(activityPath, SEED_PRESENCE)) roster.apply(ev);
			return roster.list();
		},
		subscribe: (onEvent) => createActivityTailer(activityPath, (ev) => onEvent(roster.apply(ev)), pollMs),
	};
}

/**
 * Presence backlog. Larger than the ticker's: presence is a fold, so a short
 * window would under-report an agent that has been quiet for a few minutes but
 * is very much still working.
 */
export const SEED_PRESENCE = 600;

/** Build every feed the dashboard hosts, wired to `paths`. */
export function buildFeeds(paths: FeedPaths, pollMs: number): VizFeed[] {
	return [
		{
			route: "/api/stream",
			hello: "interlinked baseline stream",
			seed: () => seedRecentEvents(paths.activity, SEED_EVENTS),
			subscribe: (onEvent) => createActivityTailer(paths.activity, onEvent, pollMs),
		},
		{
			route: "/api/checks",
			hello: "interlinked checks stream",
			seed: () => seedRecentChecks(paths.checkResults, SEED_EVENTS),
			subscribe: (onEvent) => createChecksTailer(paths.checkResults, onEvent, pollMs),
		},
		{
			route: "/api/tests",
			hello: "interlinked test stream",
			seed: () => seedRecentTestEvents(paths.testEvents, SEED_TESTS),
			subscribe: (onEvent) => createTestTailer(paths.testEvents, onEvent),
		},
		buildAgentFeed(paths.activity, pollMs),
		{
			route: "/api/mutants",
			hello: "interlinked mutant stream",
			seed: () => seedMutants(paths.mutationManifest),
			subscribe: (onEvent) => createMutantWatcher(paths.mutationManifest, onEvent),
		},
	];
}
