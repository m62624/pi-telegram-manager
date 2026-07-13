/**
 * The live trace of a turn, rendered into the streaming draft: the steps the agent
 * has finished, and the one it is on right now.
 *
 * This is what the terminal shows and Telegram did not. A single "Thinking…" line
 * says the agent is alive; it does not say that it already read three files and is
 * now four seconds into a test run. The finished steps render as ordinary lines and
 * the current one as `<tg-thinking>`, which Telegram animates — so exactly one
 * thing in the draft is moving, and it is the thing that is actually happening.
 *
 * The whole trace lives in an ephemeral draft: it animates in place and leaves
 * nothing behind in the chat. Nothing here is the model's reasoning — the SDK
 * exposes none. These are actions.
 */
import { inlineCode, italic, RichHtml, thinking } from "./rich-builder";

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

/** Steps kept visible; older ones collapse into a count, so a long turn stays readable. */
const MAX_VISIBLE_STEPS = 6;

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
	 * Render the trace as of `now`. Finished steps are plain lines with a tick (or a
	 * cross); the running one animates. With no steps yet, only the headline animates
	 * — the model is sampling and there is nothing else true to say.
	 */
	html(now: number): RichHtml {
		if (this.steps.length === 0) return thinking(this.headline);

		const parts: RichHtml[] = [];
		const hidden = Math.max(0, this.steps.length - MAX_VISIBLE_STEPS);
		if (hidden > 0) {
			parts.push(
				paragraph(
					italic(`… (${hidden} earlier step${hidden === 1 ? "" : "s"})`),
				),
			);
		}
		const visible = this.steps.slice(hidden);
		for (const step of visible) {
			const running = step.endedAt === undefined;
			const line = this.line(step, now);
			parts.push(running ? thinking(line) : paragraph(line));
		}
		return RichHtml.join(parts);
	}

	/** `✓ bash — npm test (4s)`; the running step keeps its own elapsed clock. */
	private line(step: ThinkingStep, now: number): RichHtml {
		const running = step.endedAt === undefined;
		const mark = running ? "▸ " : step.failed ? "✕ " : "✓ ";
		const parts: RichHtml[] = [RichHtml.text(mark), inlineCode(step.toolName)];
		if (step.hint) {
			parts.push(RichHtml.text(` — ${step.hint}`));
		}
		const elapsed = (step.endedAt ?? now) - step.startedAt;
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

/** A block-level line in the draft (the trace is a document, not one inline string). */
function paragraph(content: RichHtml): RichHtml {
	return RichHtml.raw(`<p>${content.html}</p>`);
}
