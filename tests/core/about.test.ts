import { describe, expect, it } from "vitest";
import {
	ABOUT_CALLS_PER_TURN,
	ABOUT_TOPICS,
	type AboutToolDeps,
	BUDGET_SPENT,
	COMMANDS_REFUSAL,
	createAboutTools,
	SETTINGS_REFUSAL,
} from "../../src/core/about";
import { FakeFs } from "../helpers/fake-fs";

const DOCS = "/docs";

async function setup(overrides: Partial<AboutToolDeps> = {}) {
	const fs = new FakeFs();
	await fs.writeText(
		`${DOCS}/project.md`,
		"# What this bot is\npi-telegram-manager",
	);
	await fs.writeText(`${DOCS}/modes.md`, "# The three modes");
	await fs.writeText(`${DOCS}/settings.md`, "# How this bot is configured");
	await fs.writeText(`${DOCS}/privacy.md`, "# What the bot sees");
	await fs.writeText(
		`${DOCS}/commands.md`,
		"# The commands the owner can use in the chat\n/compact",
	);
	await fs.writeText("/etc/secrets", "TOKEN=123");

	const deps: AboutToolDeps = {
		fs,
		docsDir: DOCS,
		isOwnerTurn: () => true,
		settingsReport: () => "# Configuration currently running (personal mode)",
		claimCall: () => true,
		...overrides,
	};
	const [about] = createAboutTools(deps);
	const call = (params: unknown) =>
		about.execute("call-1", params as never, undefined as never);
	return { about, call, fs };
}

function textOf(result: unknown): string {
	const content = (result as { content: { text: string }[] }).content;
	return content.map((part) => part.text).join("\n");
}

function isError(result: unknown): boolean {
	return (result as { isError?: boolean }).isError === true;
}

describe("about tool", () => {
	it("reads one bundled page per call", async () => {
		const { call } = await setup();
		expect(textOf(await call({ topic: "project" }))).toContain(
			"pi-telegram-manager",
		);
		expect(textOf(await call({ topic: "modes" }))).toContain("The three modes");
		expect(isError(await call({ topic: "privacy" }))).toBe(false);
	});

	it("takes a topic, never a path — nothing written to it can steer the read", async () => {
		// The whole injection surface: if the model could name a file, a stranger's
		// message could name one for it. It cannot.
		const { about, call } = await setup();
		const schema = about.parameters as {
			properties: { topic: { enum: string[] } };
			additionalProperties: boolean;
		};
		expect(schema.properties.topic.enum).toEqual([...ABOUT_TOPICS]);
		expect(schema.additionalProperties).toBe(false);
		expect(Object.keys(schema.properties)).toEqual(["topic"]);

		// And a topic that is not one of ours is refused rather than resolved.
		for (const hostile of [
			"../../etc/secrets",
			"/etc/secrets",
			"project.md",
			"..",
		]) {
			const result = await call({ topic: hostile });
			expect(isError(result)).toBe(true);
			expect(textOf(result)).toContain("Unknown topic");
			expect(textOf(result)).not.toContain("TOKEN=123");
		}
	});

	it("gives the owner the live configuration", async () => {
		const { call } = await setup({ isOwnerTurn: () => true });
		const result = await call({ topic: "current_settings" });
		expect(isError(result)).toBe(false);
		expect(textOf(result)).toContain("Configuration currently running");
	});

	it("refuses the live configuration on a manager turn", async () => {
		// The person on the other end is a stranger, whatever they claim to be.
		const { call } = await setup({ isOwnerTurn: () => false });
		const result = await call({ topic: "current_settings" });
		expect(isError(result)).toBe(true);
		expect(textOf(result)).toBe(SETTINGS_REFUSAL);
		expect(textOf(result)).not.toContain("Configuration currently running");
	});

	it("still explains what the bot IS to a stranger", async () => {
		// Refusing the configuration is not refusing to be honest about yourself.
		const { call } = await setup({ isOwnerTurn: () => false });
		for (const topic of ["project", "modes", "privacy", "settings"]) {
			expect(isError(await call({ topic }))).toBe(false);
		}
	});

	it("tells the owner how to drive the bot", async () => {
		const { call } = await setup({ isOwnerTurn: () => true });
		const result = await call({ topic: "commands" });
		expect(isError(result)).toBe(false);
		expect(textOf(result)).toContain("/compact");
	});

	it("refuses the commands to a stranger, and does not leak one in the refusal", async () => {
		// Every one of these is refused to them anyway, so reciting them teaches nothing
		// and only invites someone to try /stop and wonder why they were ignored.
		const { call } = await setup({ isOwnerTurn: () => false });
		const result = await call({ topic: "commands" });
		expect(isError(result)).toBe(true);
		expect(textOf(result)).toBe(COMMANDS_REFUSAL);
		expect(textOf(result)).not.toContain("/compact");
		expect(textOf(result)).not.toContain("/stop\n");
		// It still points at what a stranger MAY be told.
		expect(textOf(result)).toContain("'project'");
	});

	it("says so plainly when a page is missing from the installation", async () => {
		const fs = new FakeFs();
		const { call } = await setup({ fs });
		const result = await call({ topic: "project" });
		expect(isError(result)).toBe(true);
		expect(textOf(result)).toContain("could not be read");
	});

	it("reports nothing when no mode is running", async () => {
		const { call } = await setup({ settingsReport: () => null });
		const result = await call({ topic: "current_settings" });
		expect(isError(result)).toBe(true);
		expect(textOf(result)).toContain("No mode is running");
	});

	it("stops a turn that keeps reading instead of answering", async () => {
		// `telegram_bot_about` decides nothing, and a manager turn only ends when the model calls
		// reply/silent — so an unbudgeted `telegram_bot_about` is a way to spin forever.
		let spent = 0;
		const { call } = await setup({
			claimCall: () => ++spent <= ABOUT_CALLS_PER_TURN,
		});
		for (let i = 0; i < ABOUT_CALLS_PER_TURN; i++) {
			expect(isError(await call({ topic: "project" }))).toBe(false);
		}
		const blocked = await call({ topic: "modes" });
		expect(isError(blocked)).toBe(true);
		expect(textOf(blocked)).toBe(BUDGET_SPENT);
		// And it names the way out, so the model answers instead of retrying.
		expect(textOf(blocked)).toContain("answer the person now");
	});

	it("tells the model to call it — never to answer about the bot from memory", async () => {
		const { about } = await setup();
		const description = about.description as string;
		expect(description).toContain("never answer from memory");
		expect(description).toContain("Do NOT call it for ordinary conversation");
		// Live failure: the model reached for `planner_about` and described the wrong
		// software, because "about" is a name several extensions claim.
		expect(description).toContain("planner_about");
		expect(description).toMatch(/never substitute/i);
	});
});
