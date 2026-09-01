export type CheckStatus = "pass" | "fail" | "warn";

export interface CheckResult {
	name: string;
	status: CheckStatus;
	message: string;
	fixable?: boolean;
	fixAction?: string;
}
