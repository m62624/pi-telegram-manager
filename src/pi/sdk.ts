/**
 * The single boundary to the Pi SDK.
 *
 * This is the ONLY module in `src/` allowed to import `@earendil-works/*`
 * (enforced by `tests/invariants.test.ts`). Everything else imports the SDK's
 * types and values from here, so the SDK surface we depend on is one small,
 * auditable list and the domains stay testable with fakes.
 */

export type {
	AgentEndEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
	SlashCommandInfo,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
export { defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
