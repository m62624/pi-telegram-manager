import { describe, expect, it } from "vitest";
import {
	byteLength,
	fullOutputPath,
	planAttachment,
	resolveToolOutputDir,
	toolOutputFileName,
	wasTruncated,
} from "../../src/core/tool-output-file";

const MB = 1_048_576;
const CARD = 2500;

/** A tool that truncated its own output and saved the whole thing. */
const toolTruncated = {
	fullOutputPath: "/tmp/pi-bash-1.log",
	truncation: { truncated: true, truncatedBy: "lines", totalLines: 900 },
};

describe("planAttachment", () => {
	it("sends the tool's own file when the TOOL truncated", () => {
		expect(
			planAttachment({
				details: toolTruncated,
				text: "cut down for the model",
				shownChars: CARD,
				maxBytes: 25 * MB,
				toolFileBytes: 2 * MB,
			}),
		).toEqual({ attach: "file", path: "/tmp/pi-bash-1.log" });
	});

	it("saves the output ITSELF when only the card truncated", () => {
		// The `find … | head -100` case: a hundred lines is nothing to the tool's
		// limits, so it saved no file — but the card still cut it at 2500 chars and
		// used to offer nothing to open.
		const text = "x".repeat(CARD + 1);
		expect(
			planAttachment({
				details: undefined,
				text,
				shownChars: CARD,
				maxBytes: 25 * MB,
			}),
		).toEqual({ attach: "text", text });
	});

	it("attaches nothing when the card shows the whole result", () => {
		expect(
			planAttachment({
				details: undefined,
				text: "short",
				shownChars: CARD,
				maxBytes: 25 * MB,
			}),
		).toEqual({ attach: false, reason: "not_truncated" });
	});

	it("respects the byte cap for either source", () => {
		expect(
			planAttachment({
				details: toolTruncated,
				text: "cut",
				shownChars: CARD,
				maxBytes: 1 * MB,
				toolFileBytes: 40 * MB,
			}),
		).toEqual({ attach: false, reason: "too_large" });

		expect(
			planAttachment({
				details: undefined,
				text: "x".repeat(3000),
				shownChars: CARD,
				maxBytes: 1000,
			}),
		).toEqual({ attach: false, reason: "too_large" });
	});

	it("measures the cap in BYTES, not characters", () => {
		// 2000 Cyrillic characters are ~4000 bytes: a character count would have let
		// this through a 3000-byte cap.
		const text = "я".repeat(3000);
		expect(byteLength(text)).toBe(6000);
		expect(
			planAttachment({
				details: undefined,
				text,
				shownChars: CARD,
				maxBytes: 5000,
			}),
		).toEqual({ attach: false, reason: "too_large" });
	});

	it("never attaches when the cap is zero", () => {
		expect(
			planAttachment({
				details: toolTruncated,
				text: "x".repeat(9000),
				shownChars: CARD,
				maxBytes: 0,
				toolFileBytes: 10,
			}),
		).toEqual({ attach: false, reason: "disabled" });
	});

	it("falls back to what we hold when the tool's file cannot be measured", () => {
		// The path was reported but the file is gone: still better to send the copy we
		// have than to send nothing.
		const text = "x".repeat(CARD + 1);
		expect(
			planAttachment({
				details: toolTruncated,
				text,
				shownChars: CARD,
				maxBytes: 25 * MB,
				toolFileBytes: undefined,
			}),
		).toEqual({ attach: "text", text });
	});
});

describe("resolveToolOutputDir", () => {
	const FALLBACK = "/agent/extensions/pi-telegram-manager/tool-output";

	it("defaults to the extension's own directory", () => {
		expect(resolveToolOutputDir(undefined, FALLBACK, "/home/u")).toBe(FALLBACK);
		expect(resolveToolOutputDir("   ", FALLBACK, "/home/u")).toBe(FALLBACK);
	});

	it("takes a POSIX path as written", () => {
		expect(resolveToolOutputDir("/var/log/pi", FALLBACK, "/home/u")).toBe(
			"/var/log/pi",
		);
		expect(resolveToolOutputDir("./logs", FALLBACK, "/home/u")).toBe("./logs");
	});

	it("takes a Windows path as written — drive, forward slashes, and UNC", () => {
		// The same settings.json may travel between machines; none of these may be
		// mangled on the way through.
		expect(resolveToolOutputDir("C:\\logs\\pi", FALLBACK, "C:\\Users\\u")).toBe(
			"C:\\logs\\pi",
		);
		expect(resolveToolOutputDir("D:/logs", FALLBACK, "C:\\Users\\u")).toBe(
			"D:/logs",
		);
		expect(
			resolveToolOutputDir("\\\\server\\share\\pi", FALLBACK, "C:\\Users\\u"),
		).toBe("\\\\server\\share\\pi");
	});

	it("expands ~ on both platforms, with either slash", () => {
		expect(resolveToolOutputDir("~", FALLBACK, "/home/u")).toBe("/home/u");
		expect(resolveToolOutputDir("~/logs", FALLBACK, "/home/u")).toBe(
			"/home/u/logs",
		);
		// A Windows user types the backslash out of habit; the home dir is Windows too.
		expect(resolveToolOutputDir("~\\logs", FALLBACK, "C:\\Users\\u")).toBe(
			"C:\\Users\\u\\logs",
		);
		expect(resolveToolOutputDir("~/logs", FALLBACK, "C:\\Users\\u")).toBe(
			"C:\\Users\\u\\logs",
		);
	});

	it("does not double a separator the home dir already ends with", () => {
		expect(resolveToolOutputDir("~/logs", FALLBACK, "/home/u/")).toBe(
			"/home/u/logs",
		);
		expect(resolveToolOutputDir("~\\logs", FALLBACK, "C:\\Users\\u\\")).toBe(
			"C:\\Users\\u\\logs",
		);
	});
});

describe("toolOutputFileName", () => {
	it("never smuggles a character Windows forbids into a filename", () => {
		const name = toolOutputFileName("bash", 1_700_000_000_000);
		expect(name).toBe("bash-1700000000000.log");
		for (const forbidden of ["\\", "/", ":", "*", "?", '"', "<", ">", "|"]) {
			expect(name).not.toContain(forbidden);
		}
	});

	it("sanitizes a hostile tool name into a name, not a path", () => {
		// Dots survive (harmless inside a filename); separators and colons do not, so
		// the result cannot climb out of the directory it is written to.
		const name = toolOutputFileName("../../etc/pa:sswd", 1);
		expect(name).toBe("..-..-etc-pa-sswd-1.log");
		expect(name).not.toContain("/");
		expect(name).not.toContain("\\");
		expect(name).not.toContain(":");
	});
});

describe("wasTruncated / fullOutputPath", () => {
	it("reads the tool's own claim, and treats no claim as no", () => {
		expect(wasTruncated(toolTruncated)).toBe(true);
		expect(wasTruncated({ truncation: { truncated: false } })).toBe(false);
		expect(wasTruncated({})).toBe(false);
		expect(wasTruncated(undefined)).toBe(false);
	});

	it("reads the path only when it is a real one", () => {
		expect(fullOutputPath(toolTruncated)).toBe("/tmp/pi-bash-1.log");
		expect(fullOutputPath({ fullOutputPath: "   " })).toBeUndefined();
		expect(fullOutputPath({ fullOutputPath: 42 })).toBeUndefined();
		expect(fullOutputPath(undefined)).toBeUndefined();
	});
});
