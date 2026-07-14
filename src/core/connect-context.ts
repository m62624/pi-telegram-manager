/**
 * The context the model reads in personal mode (and in mixed mode's coding
 * polarity): the session's own messages, with the bridge's system block in front.
 *
 * Nothing is appended. That is the whole point of this module, and it is worth
 * saying why, because the code that came before it did append something.
 *
 * `pi.on("context")` fires before EVERY call to the model — not once per turn, but
 * once per step of a tool loop. A message appended there is therefore re-appended
 * on every step, and a message is a TURN: the model reads a trailing `user`
 * message as somebody speaking to it, right now, after the tool result it was in
 * the middle of reading. We used to append the clock that way. The model answered
 * it — "a background tick, I am not replying, carrying on" — and did so on eleven
 * separate steps of a single session. Those answers were real assistant messages:
 * they went into the history, and they went out to Telegram as messages from the
 * bot. Worse, they were ORPHANS. The clock message itself was never persisted (it
 * only ever existed inside the request), so on the next step the model read its own
 * "I am not replying to the tick" with nothing above it to explain what tick — and
 * carried on producing more of them.
 *
 * So: the clock now travels inside the message it belongs to (`TurnInput.receivedAt`),
 * written once, never rewritten. The system block stays here, because it is not a
 * turn — it is the standing instruction the model needs on every call, and it is
 * kept byte-identical so the provider's prompt cache holds across the session.
 *
 * Pure and SDK-free: `index.ts` hands it the raw `event.messages` and returns the
 * result.
 */
import { SYSTEM_INSTRUCTIONS_HEADER } from "../instructions/builtin";

/**
 * The bridge's standing instructions as the head message of the context.
 *
 * `timestamp: 0` puts it before everything: it is not part of the conversation, so
 * it must not be sorted into it. It is rebuilt on every call rather than written to
 * the session, which is also what makes it survive a compaction — a summary can
 * rewrite the conversation, but it cannot touch a block that is not in it.
 */
export interface SystemBlockMessage {
	role: "user";
	content: string;
	timestamp: 0;
}

/** The head message carrying `block`, marked as system instructions. */
export function systemBlockMessage(block: string): SystemBlockMessage {
	return {
		role: "user",
		content: `${SYSTEM_INSTRUCTIONS_HEADER}\n\n${block}`,
		timestamp: 0,
	};
}

/**
 * Put the bridge's system block in front of the session's messages — and change
 * nothing else. A null/blank block (the bridge is not running) returns the
 * messages untouched.
 */
export function withSystemBlock<T>(
	messages: readonly T[],
	block: string | null | undefined,
): Array<T | SystemBlockMessage> {
	if (!block?.trim()) return [...messages];
	return [systemBlockMessage(block), ...messages];
}
