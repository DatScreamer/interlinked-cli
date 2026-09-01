import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createAsyncAnalysisManager } from "../async-analysis.js";
import { AsyncFindingQueue } from "../async-finding-queue.js";
import {
	type AutoCoordinationState,
	DEFAULT_AUTO_COORDINATION_CONFIG,
} from "../auto-coordinate.js";
import { CohortManager, setActiveCohort } from "../cohort.js";
import { compileAllowlist } from "../content-scanner/allowlist.js";
import { createScanner } from "../content-scanner/registry.js";
import type { ContentScanner } from "../content-scanner/types.js";
import { ErrorHistory } from "../error-history.js";
import { createLearnedRulesStore } from "../learned-rules.js";
import { createMutationFindingSessionDelivery } from "../mutation/mutation-cloud-v3-session-delivery.js";
import type { ClassifierSessionState } from "../policy-classifier.js";
import { ProjectWideSweepState } from "../quality-checks.js";
import { ReservationManager } from "../reservations.js";
import { RouteMap } from "../route-map.js";
import { createServerBridge, type ServerBridge } from "../server-bridge.js";
import { SessionTracker } from "../session-state.js";
import type { GuardRulesConfig, PreEditBaseline } from "../types.js";
import { formatScannerStatusLine, type ProtocolStatusFile } from "./protocol-status.js";
import type { ServerCliConfig } from "./server-cli-bootstrap.js";
import { createProtocolStatus } from "./protocol-status.js";
import { createStatusWriters } from "./status-writers.js";

export interface DaemonState {
	cohort: CohortManager;
	sessions: SessionTracker;
	writeClassifierStatus: ReturnType<typeof createStatusWriters>["writeClassifierStatus"];
	writeScannerStatus: ReturnType<typeof createStatusWriters>["writeScannerStatus"];
	writeReviewPendingMarker: ReturnType<typeof createStatusWriters>["writeReviewPendingMarker"];
	asyncFindings: AsyncFindingQueue;
	deliverMutationFindingToSessions: ReturnType<typeof createMutationFindingSessionDelivery>;
	learnedRules: ReturnType<typeof createLearnedRulesStore>;
	asyncAnalysis: ReturnType<typeof createAsyncAnalysisManager>;
	classifierSessions: Map<string, ClassifierSessionState>;
	contentScanner: ContentScanner | undefined;
	compiledAllowlist: ReturnType<typeof compileAllowlist>;
	autoCoordStates: Map<string, AutoCoordinationState>;
	indexWarningSent: Set<string>;
	autoCoordConfig: typeof DEFAULT_AUTO_COORDINATION_CONFIG;
	preEditBaselines: Map<string, PreEditBaseline>;
	routeMap: RouteMap;
	errorHistory: ErrorHistory;
	projectWideSweepState: ProjectWideSweepState;
	serverBridge: ServerBridge | null;
	reservations: ReservationManager;
	protocolStatusPath: string;
	protocolStatus: ProtocolStatusFile;
}

interface CreateDaemonStateOptions {
	cli: ServerCliConfig;
	rules: GuardRulesConfig;
	log: (message: string) => void;
	logAlways: (message: string) => void;
}

function initializeContentScanner(
	rules: GuardRulesConfig,
	writeScannerStatus: ReturnType<typeof createStatusWriters>["writeScannerStatus"],
	logAlways: (message: string) => void,
): ContentScanner | undefined {
	const scanner = rules.content_scanner ? createScanner(rules.content_scanner) : undefined;
	if (!scanner) {
		writeScannerStatus("disabled");
		return undefined;
	}
	logAlways(`Content scanner: enabled (${scanner.name} / ${scanner.runtime})`);
	if (scanner.onStatusChange) {
		scanner.onStatusChange((status) => {
			writeScannerStatus(formatScannerStatusLine(status));
		});
	} else {
		writeScannerStatus(`ready:${scanner.runtime}`);
	}
	return scanner;
}

function createReservations(
	cwd: string,
	serverBridge: ServerBridge | null,
): ReservationManager {
	const reservationEventsPath = join(cwd, ".interlinked", "reservation-events.jsonl");
	return new ReservationManager(serverBridge || undefined, undefined, (event) => {
		try {
			const dir = dirname(reservationEventsPath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			appendFileSync(reservationEventsPath, `${JSON.stringify(event)}\n`);
		} catch {
			// Reservation-event persistence is best-effort observability.
		}
	});
}

/** Construct the daemon-scoped state without starting sockets or watchers. */
export function createDaemonState(options: CreateDaemonStateOptions): DaemonState {
	const { cli, rules, log, logAlways } = options;
	const cohort = new CohortManager();
	setActiveCohort(cohort);
	const sessions = new SessionTracker();
	const statusWriters = createStatusWriters(cli.interlinkedDir);
	const asyncFindings = new AsyncFindingQueue();
	const contentScanner = initializeContentScanner(
		rules,
		statusWriters.writeScannerStatus,
		logAlways,
	);
	const serverBridge = createServerBridge(cli.cwd);
	log(serverBridge ? "Server bridge connected" : "No server configured — running in local-only mode");

	return {
		cohort,
		sessions,
		...statusWriters,
		asyncFindings,
		deliverMutationFindingToSessions: createMutationFindingSessionDelivery({
			sessions,
			queue: asyncFindings,
		}),
		learnedRules: createLearnedRulesStore(cli.interlinkedDir),
		asyncAnalysis: createAsyncAnalysisManager(cli.interlinkedDir),
		classifierSessions: new Map<string, ClassifierSessionState>(),
		contentScanner,
		compiledAllowlist: compileAllowlist(rules.content_scanner?.allowlist),
		autoCoordStates: new Map<string, AutoCoordinationState>(),
		indexWarningSent: new Set<string>(),
		autoCoordConfig: {
			...DEFAULT_AUTO_COORDINATION_CONFIG,
			...rules.auto_coordination,
		},
		preEditBaselines: new Map<string, PreEditBaseline>(),
		routeMap: new RouteMap(cli.cwd),
		errorHistory: new ErrorHistory(cli.interlinkedDir, rules.error_memory),
		projectWideSweepState: new ProjectWideSweepState(),
		serverBridge,
		reservations: createReservations(cli.cwd, serverBridge),
		protocolStatusPath: join(cli.interlinkedDir, "harness-protocol.json"),
		protocolStatus: createProtocolStatus({
			protocol: cli.protocolMode,
			rawSocketPath: cli.runRawSocket ? cli.socketPath : null,
			framedSocketPath: cli.runFramedSocket ? cli.framedPaths.socket : null,
			framedSessionId: cli.runFramedSocket ? cli.framedSessionId : null,
		}),
	};
}
