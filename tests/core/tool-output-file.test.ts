import { describe, expect, it } from "vitest";
import {
	decideAttachment,
	fullOutputPath,
	wasTruncated,
} from "../../src/core/tool-output-file";

const MB = 1_048_576;
const truncated = {
	fullOutputPath: "/tmp/pi-bash-1.log",
	truncation: { truncated: true, truncatedBy: "lines", totalLines: 900 },
};

describe("decideAttachment", () => {
	it("attaches a truncated log that fits the cap", () => {
		expect(
			decideAttachment({
				details: truncated,
				maxBytes: 25 * MB,
				sizeBytes: 2 * MB,
			}),
		).toEqual({ attach: true, path: "/tmp/pi-bash-1.log" });
	});

	it("does not attach a complete result", () => {
		// The whole thing is already in the card; the file would be a duplicate.
		expect(
			decideAttachment({
				details: {
					fullOutputPath: "/tmp/pi-bash-2.log",
					truncation: { truncated: false },
				},
				maxBytes: 25 * MB,
				sizeBytes: 10,
			}),
		).toEqual({ attach: false, reason: "not_truncated" });
	});

	it("refuses a log past the owner's byte cap", () => {
		// Someone on mobile data set this; a 40 MB build log is exactly what they meant.
		expect(
			decideAttachment({
				details: truncated,
				maxBytes: 25 * MB,
				sizeBytes: 40 * MB,
			}),
		).toEqual({ attach: false, reason: "too_large" });
	});

	it("attaches a log exactly at the cap", () => {
		expect(
			decideAttachment({
				details: truncated,
				maxBytes: 25 * MB,
				sizeBytes: 25 * MB,
			}).attach,
		).toBe(true);
	});

	it("never attaches when the cap is zero", () => {
		expect(
			decideAttachment({ details: truncated, maxBytes: 0, sizeBytes: 10 }),
		).toEqual({ attach: false, reason: "disabled" });
	});

	it("skips a tool that saved no file, and a file that cannot be measured", () => {
		expect(
			decideAttachment({
				details: { truncation: { truncated: true } },
				maxBytes: 25 * MB,
				sizeBytes: 10,
			}),
		).toEqual({ attach: false, reason: "no_file" });
		// The path was reported but the file is gone: a skip, not a crash.
		expect(
			decideAttachment({
				details: truncated,
				maxBytes: 25 * MB,
				sizeBytes: undefined,
			}),
		).toEqual({ attach: false, reason: "no_file" });
	});

	it("skips a tool that reports no details at all", () => {
		expect(
			decideAttachment({
				details: undefined,
				maxBytes: 25 * MB,
				sizeBytes: 10,
			}).attach,
		).toBe(false);
	});
});

describe("wasTruncated / fullOutputPath", () => {
	it("reads the tool's own claim, and treats no claim as no", () => {
		expect(wasTruncated(truncated)).toBe(true);
		expect(wasTruncated({ truncation: { truncated: false } })).toBe(false);
		expect(wasTruncated({})).toBe(false);
		expect(wasTruncated(undefined)).toBe(false);
	});

	it("reads the path only when it is a real one", () => {
		expect(fullOutputPath(truncated)).toBe("/tmp/pi-bash-1.log");
		expect(fullOutputPath({ fullOutputPath: "   " })).toBeUndefined();
		expect(fullOutputPath({ fullOutputPath: 42 })).toBeUndefined();
		expect(fullOutputPath(undefined)).toBeUndefined();
	});
});
