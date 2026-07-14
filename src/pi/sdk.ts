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
	CompactionResult,
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SlashCommandInfo,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
/**
 * `compact` is Pi's own compaction — the same function its automatic path runs, exported
 * from the package for exactly this. We call it from `session_before_compact` and hand
 * the result back, because that path passes `undefined` for `customInstructions` and the
 * summary it writes without them keeps the tool output and loses the person. See
 * `core/compaction-run.ts`.
 */
export {
	compact,
	defineTool,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
