import { describe, expect, it } from "vitest";
import { formatBytes, resolveSaveName } from "../../src/telegram/file-store";
import type { AttachmentRef } from "../../src/telegram/media";

function docRef(over: Partial<AttachmentRef> = {}): AttachmentRef {
	return { kind: "document", fileId: "AAAA1234BCDE", ...over };
}

describe("resolveSaveName", () => {
	it("uses the message's own filename when present", () => {
		expect(resolveSaveName(docRef({ fileName: "report.pdf" }), new Set())).toBe(
			"report.pdf",
		);
	});

	it("derives a stable default name from kind + mime when unnamed", () => {
		const name = resolveSaveName(
			docRef({ mimeType: "application/pdf" }),
			new Set(),
		);
		// fileId "AAAA1234BCDE" → last 8 chars "1234BCDE".
		expect(name).toBe("telegram-document-1234BCDE.pdf");
	});

	it("disambiguates a duplicate name with a numeric suffix", () => {
		const used = new Set<string>();
		expect(resolveSaveName(docRef({ fileName: "a.txt" }), used)).toBe("a.txt");
		expect(resolveSaveName(docRef({ fileName: "a.txt" }), used)).toBe(
			"a-1.txt",
		);
		expect(resolveSaveName(docRef({ fileName: "a.txt" }), used)).toBe(
			"a-2.txt",
		);
	});

	it("strips path separators so a name cannot escape the target dir", () => {
		// Separators are what enable traversal; with none, join() stays in the dir.
		const name = resolveSaveName(
			docRef({ fileName: "../../etc/passwd" }),
			new Set(),
		);
		expect(name).not.toContain("/");
		expect(name).not.toContain("\\");
	});
});

describe("formatBytes", () => {
	it("formats across units", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2.0 KB");
		expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
		expect(formatBytes(52_428_800)).toBe("50 MB");
	});
});
