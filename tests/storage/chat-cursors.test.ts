import { describe, expect, it } from "vitest";
import { createChatCursorStore } from "../../src/storage/chat-cursors";
import { createTelegramPaths } from "../../src/storage/paths";
import { FakeFs } from "../helpers/fake-fs";

const paths = createTelegramPaths("/agent");

function store() {
	return createChatCursorStore(new FakeFs(), paths.chatCursorsPath);
}

describe("chat cursors", () => {
	it("knows nothing about a chat it has never seen", async () => {
		expect(await store().get("42")).toBeNull();
	});

	it("keeps the two marks apart", async () => {
		// Answered and remembered are different questions about the same chat, and a
		// chat is routinely one without the other: the bot replies for days before an
		// idle moment lets it consolidate anything.
		const cursors = store();
		await cursors.markHandled("42", 500);
		await cursors.markConsolidated("42", 300);
		expect(await cursors.get("42")).toEqual({
			chatId: "42",
			handledThrough: 500,
			consolidatedThrough: 300,
		});
	});

	it("never moves a mark backwards", async () => {
		// "Already handled" cannot become false. A late write with an older timestamp —
		// a pass over a stale window, a turn that settled on a message we had long since
		// dealt with — must not re-open work that is finished, or the restart loop this
		// store exists to end would simply come back.
		const cursors = store();
		await cursors.markHandled("42", 900);
		await cursors.markHandled("42", 100);
		expect((await cursors.get("42"))?.handledThrough).toBe(900);

		await cursors.markConsolidated("42", 900);
		await cursors.markConsolidated("42", 100);
		expect((await cursors.get("42"))?.consolidatedThrough).toBe(900);
	});

	it("reads every chat's marks in one go, for the catch-up scan", async () => {
		const cursors = store();
		await cursors.markHandled("1", 10);
		await cursors.markHandled("2", 20);
		const all = await cursors.all();
		expect(all.get("1")?.handledThrough).toBe(10);
		expect(all.get("2")?.handledThrough).toBe(20);
		expect(all.size).toBe(2);
	});

	it("forgets a chat on request, and shrugs at one it does not know", async () => {
		const cursors = store();
		await cursors.markHandled("42", 10);
		await cursors.remove("42");
		expect(await cursors.get("42")).toBeNull();
		await expect(cursors.remove("nobody")).resolves.toBeUndefined();
	});
});
