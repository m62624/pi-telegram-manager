/**
 * What the agent is doing RIGHT NOW, rendered into the streaming draft.
 *
 * Between the prompt and the first token the chat was blank: a turn spent reading
 * files or running a build looked like nothing was happening. The current step goes
 * into `<tg-thinking>`, which Telegram animates, and carries its own elapsed clock —
 * so "it is alive" becomes "it is four seconds into npm test".
 *
 * It shows ONLY the running step. Finished calls already stand in the chat as tool
 * cards (real messages, each with its ✅), and listing them here printed the same
 * call twice, one under the other. The draft covers the gap the cards do not: the
 * call that has not returned yet.
 *
 * The draft is ephemeral — it animates in place and leaves nothing in the history.
 * Nothing here is the model's reasoning; the SDK exposes none. These are actions.
 */
import { inlineCode, RichHtml, thinking } from "./rich-builder";

export interface ThinkingStep {
	/** The tool call this step belongs to, so parallel calls do not overwrite each other. */
	callId: string;
	toolName: string;
	/** The salient argument, already shortened (`src/index.ts`, `npm test`). */
	hint?: string;
	startedAt: number;
	endedAt?: number;
	failed?: boolean;
}

/** Only show a duration once it is worth showing — every step is "0s" at first. */
const MIN_ELAPSED_MS = 1_000;

export class ThinkingLog {
	private readonly steps: ThinkingStep[] = [];
	/** What the placeholder says before any tool has been called. */
	private headline = "Thinking…";

	/** Reset for a new turn. */
	clear(): void {
		this.steps.length = 0;
		this.headline = "Thinking…";
	}

	isEmpty(): boolean {
		return this.steps.length === 0;
	}

	setHeadline(text: string): void {
		this.headline = text;
	}

	start(step: Omit<ThinkingStep, "endedAt" | "failed">): void {
		this.steps.push({ ...step });
	}

	/** Close the step for `callId`. An unknown id is ignored — it has no line to close. */
	finish(callId: string, endedAt: number, failed: boolean): void {
		const step = this.steps.find(
			(candidate) =>
				candidate.callId === callId && candidate.endedAt === undefined,
		);
		if (!step) return;
		step.endedAt = endedAt;
		step.failed = failed;
	}

	/**
	 * Render what is happening RIGHT NOW: the running step, with its own elapsed
	 * clock, or the headline while the model is merely sampling.
	 *
	 * Finished steps are deliberately NOT listed. The tool cards already stand in the
	 * chat as real messages, one per call, each with its own ✅ — repeating them in the
	 * draft printed the same call twice, right under itself, which reads as a bug
	 * rather than as history. The draft is for the thing that has no card yet.
	 *
	 * With several calls in flight (the model can fire them in parallel), the OLDEST
	 * unfinished one is shown: it is the one the turn is actually waiting on.
	 */
	html(now: number): RichHtml {
		const running = this.steps.find((step) => step.endedAt === undefined);
		if (!running) return thinking(this.headline);
		return thinking(this.line(running, now));
	}

	/** `▸ bash — npm test (4s)` — the running step keeps its own elapsed clock. */
	private line(step: ThinkingStep, now: number): RichHtml {
		const parts: RichHtml[] = [RichHtml.text("▸ "), inlineCode(step.toolName)];
		if (step.hint) {
			parts.push(RichHtml.text(` — ${step.hint}`));
		}
		const elapsed = now - step.startedAt;
		if (elapsed >= MIN_ELAPSED_MS) {
			parts.push(RichHtml.text(` (${formatElapsed(elapsed)})`));
		}
		return RichHtml.join(parts);
	}
}

/** `4s`, `1m 20s` — the terminal's own unit of patience. */
export function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}
