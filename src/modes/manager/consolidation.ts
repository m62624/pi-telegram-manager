/**
 * The idle memory pass: the model walking its own memory of one person, with the
 * bounds that keep it from walking forever.
 *
 * What this replaced, and why. Consolidation used to be a four-step interrogation
 * automaton — identify, review, propose candidates, verify each one — with the tool
 * for each step revealed in turn and a code-checked quote required before anything
 * could be stored or dropped. It was built that way because the memory was a flat
 * JSON list the model could not query: the only way to ask "what has gone stale" was
 * to paste the entire list into the prompt and have the model answer by line number,
 * and the only defence against a weak model inventing a reason to delete something
 * was to make it produce the sentence that justified it.
 *
 * A memory the model can query needs neither. It can look things up, so it does not
 * need the list read out to it. Conflicts arrive attached to the write that caused
 * them, so nothing has to be reviewed on spec. And `revise` closes a fact rather than
 * erasing it, so being wrong is recoverable in a way that made the evidence gate
 * worth its cost when it was not.
 *
 * What is left is a loop and its limits. The limits are the interesting part: with
 * the automaton gone, nothing in the shape of the conversation says when to stop, and
 * a rebuilt-identical context means a stuck model has no way to notice it is stuck.
 * So the runtime counts (see {@link MemoryLedger}) and tells it — which is the job the
 * automaton's step numbers used to do by accident.
 *
 * Pure: state and directives in, a verdict and a string out. The controller drives it.
 */
import { MEMORY_DONE_TOOL_NAME, type MemoryLedger } from "./memory-tools";

export interface ConsolidationLimits {
	/** Tool calls a pass may make before it is told to wrap up. */
	maxSteps: number;
	/** Turns with no tool call at all before the pass is abandoned. */
	maxNudges: number;
}

/** What `turn_end` should do with the run. */
export type ConsolidationVerdict = "continue" | "abort";

/**
 * The system block for a consolidation turn.
 *
 * Three things it has to establish, and the third is the one that was learned the
 * hard way: nobody is waiting, nothing said here reaches Telegram, and a question
 * left standing in the transcript is NOT addressed to the model right now. Without
 * that last sentence a model reading a transcript that ends in "so can you do it?"
 * concludes it is being asked — and starts answering somebody, during a background
 * memory pass, in a turn that cannot send anything.
 */
export const CONSOLIDATION_INSTRUCTIONS =
	"You are going back over a finished Telegram conversation to bring your private " +
	"long-term memory about this ONE person up to date. Nobody is waiting for you and " +
	"nothing you write reaches Telegram: there is no reply tool on this turn, and a " +
	"question left standing in the transcript below is one you have already answered " +
	"or one that is not yours to answer now. Work strictly about the interlocutor — " +
	"never the owner, never yourself. A durable fact does not have to be permanent or " +
	"true forever: save a personal interest, future intention, recurring activity, or " +
	"preference that would help in a later conversation, even when its subject is " +
	"time-bound. For example, 'wants to pursue a hobby without unwanted details' is a " +
	"useful preference about this person; 'the conversation was about a hobby' is only a topic " +
	"and is not a fact about them. Skip passing moods, today's location, and isolated " +
	"details with no likely future use. Before storing, manager_remember performs a " +
	"duplicate and similarity preflight; use manager_recall for a concrete inspection, " +
	"then store only what is genuinely new, revise what this conversation overturned, " +
	"and forget only what was wrong or never about this person. The runtime carries a " +
	"small pass state; after several recall checks without a memory action, stop " +
	"inspecting and decide. You have your memory tools and as many turns as " +
	"you need. Call exactly one tool per turn " +
	`and end the pass with ${MEMORY_DONE_TOOL_NAME} when the memory matches the ` +
	"conversation.";

/** The prompt that opens each sample of a pass; the real instruction is in the context. */
export const CONSOLIDATION_PROMPT =
	"Bring your long-term memory about this contact up to date, calling one memory tool.";

/**
 * The ordinary directive: what to do, and the one way out.
 *
 * It leads with the exit. A model that reads a list of capabilities and only then
 * learns how to stop is a model that explores until something stops it for it.
 */
function workDirective(ledger: MemoryLedger): string {
	const digest = ledger.digest();
	const soFar = digest ? `\n\nThis pass so far:\n${digest}` : "";
	return (
		"[Memory pass. Call ONE memory tool now, or " +
		`${MEMORY_DONE_TOOL_NAME} if the memory already matches the conversation.\n` +
		"  manager_recall — inspect one concrete unresolved point; do not loop;\n" +
		"  manager_remember — store something durable this conversation established;\n" +
		"  manager_revise — replace a fact this conversation overturned (its [fN] id);\n" +
		"  manager_forget — drop a fact that was wrong or was never about this person;\n" +
		`  ${MEMORY_DONE_TOOL_NAME} — finish.\n` +
		"Do not write plain text: it goes nowhere and ends nothing. Nothing here is " +
		`sent to anybody.${soFar}]`
	);
}

/**
 * The directive after a turn in which the model called nothing.
 *
 * This is the case the second queue exists for. On a reply turn, prose is recoverable
 * — it is almost certainly the answer, written the wrong way, and the draft gate
 * catches it. On a memory pass there is nothing to recover: prose here is a model
 * that has lost the thread of what it is doing. So it is handed back its own journal,
 * which is the one piece of information the rebuilt context cannot contain, and told
 * plainly that only a tool call moves anything.
 */
function nudgeDirective(
	ledger: MemoryLedger,
	limits: ConsolidationLimits,
): string {
	const digest = ledger.digest();
	const soFar = digest
		? `\n\nWhat you have already done in this pass:\n${digest}`
		: "\n\nYou have not done anything in this pass yet.";
	const last = ledger.nudges() >= limits.maxNudges;
	return (
		"[Memory pass — you answered without calling a tool, so nothing happened. " +
		"Plain text does not store, change or end anything here." +
		`${soFar}\n\n` +
		(last
			? `This is the last prompt: call a memory tool or ${MEMORY_DONE_TOOL_NAME} ` +
				"now, or the pass is abandoned and picked up another time."
			: `Call one memory tool now, or ${MEMORY_DONE_TOOL_NAME} to finish.`) +
		"]"
	);
}

/**
 * The directive after the model repeated a call exactly.
 *
 * The context is rebuilt identically for every sample of a pass, so a model that runs
 * the same recall twice will see precisely what it saw the first time and has every
 * reason to run it a third. Only the runtime knows it is a repeat, so only the
 * runtime can break the loop — by saying so.
 */
function repeatDirective(ledger: MemoryLedger): string {
	const steps = ledger.steps();
	const last = steps[steps.length - 1];
	return (
		`[Memory pass — you just made the same call twice: ${last.summary}. ` +
		"The answer has not changed and will not. Do something different — store, " +
		`revise or forget something — or call ${MEMORY_DONE_TOOL_NAME} to finish.\n\n` +
		`This pass so far:\n${ledger.digest()}]`
	);
}

/** The directive after several different recalls made no memory progress. */
function recallLimitDirective(ledger: MemoryLedger): string {
	return (
		"[Memory pass — inspection is complete for now. Do not call manager_recall " +
		"again with another wording. Decide from the conversation and the memory block: " +
		"call manager_remember, manager_revise, manager_forget, or manager_done.\n\n" +
		`This pass so far:\n${ledger.digest()}]`
	);
}

/** The directive once the pass has spent its step budget. */
function budgetDirective(ledger: MemoryLedger): string {
	return (
		"[Memory pass — you have used this pass's budget of tool calls. Finish now: " +
		`call ${MEMORY_DONE_TOOL_NAME}. Anything still worth doing will be picked up ` +
		"by the next pass over this conversation, and nothing you have already stored " +
		`is lost.\n\nThis pass so far:\n${ledger.digest()}]`
	);
}

/** The directive once the pass is over and the run has not stopped yet. */
export const CONSOLIDATION_DONE =
	"[The memory pass for this contact is finished: there is nothing left to do and " +
	"nothing to send. Do not call any more tools. Reply with a single word to end " +
	"the turn.]";

/**
 * The trailing directive for the next sample of a pass.
 *
 * Order is precedence, and it is chosen so the most specific correction wins: a model
 * that both went over budget AND repeated itself is told about the budget, because
 * that is the instruction that ends the pass.
 */
export function consolidationDirective(
	ledger: MemoryLedger,
	limits: ConsolidationLimits,
): string {
	if (ledger.isFinished()) return CONSOLIDATION_DONE;
	if (ledger.size() >= limits.maxSteps) return budgetDirective(ledger);
	if (ledger.needsNudge()) return nudgeDirective(ledger, limits);
	if (ledger.recallBlocked()) return recallLimitDirective(ledger);
	if (ledger.repeatedLast()) return repeatDirective(ledger);
	return workDirective(ledger);
}

/**
 * Whether the agent run should stop, read at `turn_end` from the ledger alone.
 *
 * Deliberately NOT from the reply machinery: a memory pass delivers nothing to
 * anybody, so "was something sent" — the question every other turn in this project is
 * settled by — has no answer here. This is the parallel accounting, and these four
 * lines are the whole of it.
 *
 * Note what abandoning a pass costs: nothing that was done. Every memory tool writes
 * on the spot, so a pass cut off at any point has already saved everything it decided
 * before that point, and the chat's consolidation cursor records how far it read.
 */
export function consolidationVerdict(
	ledger: MemoryLedger,
	limits: ConsolidationLimits,
): ConsolidationVerdict {
	if (ledger.isFinished()) return "abort";
	if (!ledger.actedThisTurn()) {
		return ledger.nudge() > limits.maxNudges ? "abort" : "continue";
	}
	// One sample past the budget: the warning has been shown and ignored.
	return ledger.size() > limits.maxSteps ? "abort" : "continue";
}
