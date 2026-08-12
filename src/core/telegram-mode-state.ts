/** Runtime resources that may survive a partially completed mode start. */
export interface TelegramRuntimeState {
	manager: boolean;
	managerClient: boolean;
	connect: boolean;
	client: boolean;
	mixed: boolean;
}

export type ActiveTelegramMode = "manager" | "mixed" | "personal" | "stop";

/** Whether the manager side needs to be torn down. */
export function hasManagerRuntime(state: TelegramRuntimeState): boolean {
	return state.manager || state.managerClient || state.mixed;
}

/** Whether the personal side needs to be torn down. */
export function hasPersonalRuntime(state: TelegramRuntimeState): boolean {
	return state.connect || state.client;
}

/** Resolve the visible mode from controllers and their underlying clients. */
export function activeTelegramMode(
	state: TelegramRuntimeState,
): ActiveTelegramMode {
	if (state.manager || state.managerClient || state.mixed) {
		return state.mixed ? "mixed" : "manager";
	}
	if (state.connect || state.client) return "personal";
	return "stop";
}
