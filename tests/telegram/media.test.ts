import type { File, Message, PhotoSize } from "@grammyjs/types";
import { describe, expect, it } from "vitest";
import {
	describeAttachments,
	isImage,
	loadInlineImages,
	MediaDownloader,
	MediaTooLargeError,
	MediaUnavailableError,
	pickPhotoSize,
	toBase64,
} from "../../src/telegram/media";

function message(overrides: Partial<Message>): Message {
	return {
		message_id: 1,
		date: 0,
		chat: { id: 1, type: "private", first_name: "A" },
		...overrides,
	} as Message;
}

const photos: PhotoSize[] = [
	{
		file_id: "s",
		file_unique_id: "s",
		width: 90,
		height: 90,
		file_size: 1_000,
	},
	{
		file_id: "m",
		file_unique_id: "m",
		width: 320,
		height: 320,
		file_size: 8_000,
	},
	{
		file_id: "l",
		file_unique_id: "l",
		width: 1280,
		height: 1280,
		file_size: 90_000,
	},
];

describe("pickPhotoSize", () => {
	it("picks the largest size when unconstrained", () => {
		expect(pickPhotoSize(photos)?.file_id).toBe("l");
	});

	it("picks the largest size that fits the limit", () => {
		expect(pickPhotoSize(photos, 10_000)?.file_id).toBe("m");
	});

	it("falls back to the smallest available when all exceed the limit", () => {
		expect(pickPhotoSize(photos, 100)?.file_id).toBe("s");
	});

	it("returns undefined for no photos", () => {
		expect(pickPhotoSize([])).toBeUndefined();
	});
});

describe("describeAttachments", () => {
	it("extracts only the chosen photo size", () => {
		const refs = describeAttachments(message({ photo: photos }), 10_000);
		expect(refs).toEqual([{ kind: "photo", fileId: "m", fileSize: 8_000 }]);
	});

	it("extracts a document with mime and name", () => {
		const refs = describeAttachments(
			message({
				document: {
					file_id: "d",
					file_unique_id: "d",
					mime_type: "application/pdf",
					file_name: "r.pdf",
					file_size: 20,
				},
			}),
		);
		expect(refs).toEqual([
			{
				kind: "document",
				fileId: "d",
				fileSize: 20,
				mimeType: "application/pdf",
				fileName: "r.pdf",
			},
		]);
	});

	it("extracts a voice note", () => {
		const refs = describeAttachments(
			message({
				voice: {
					file_id: "v",
					file_unique_id: "v",
					duration: 3,
					mime_type: "audio/ogg",
					file_size: 40,
				},
			}),
		);
		expect(refs).toEqual([
			{ kind: "voice", fileId: "v", fileSize: 40, mimeType: "audio/ogg" },
		]);
	});

	it("returns nothing for a plain text message", () => {
		expect(describeAttachments(message({ text: "hi" }))).toEqual([]);
	});
});

describe("isImage", () => {
	it("treats photos and image mime types as images", () => {
		expect(isImage({ kind: "photo", fileId: "x" })).toBe(true);
		expect(
			isImage({ kind: "document", fileId: "x", mimeType: "image/png" }),
		).toBe(true);
		expect(
			isImage({ kind: "document", fileId: "x", mimeType: "application/pdf" }),
		).toBe(false);
	});
});

describe("toBase64", () => {
	it("encodes bytes", () => {
		expect(toBase64(new Uint8Array([104, 105]))).toBe("aGk=");
	});
});

describe("MediaDownloader", () => {
	function downloader(overrides: {
		file?: File;
		bytes?: Uint8Array;
		maxBytes?: number;
	}) {
		const calls: string[] = [];
		const api: { getFile(a: { file_id: string }): Promise<File> } = {
			async getFile({ file_id }) {
				calls.push(file_id);
				return (
					overrides.file ?? {
						file_id,
						file_unique_id: file_id,
						file_path: "photos/f.jpg",
						file_size: 10,
					}
				);
			},
		};
		const fetched: string[] = [];
		const md = new MediaDownloader({
			api,
			fetchBytes: async (url) => {
				fetched.push(url);
				return overrides.bytes ?? new Uint8Array([1, 2, 3]);
			},
			fileBaseUrl: "https://api.telegram.org/file/botTOKEN",
			maxBytes: overrides.maxBytes ?? 1_000,
		});
		return { md, calls, fetched };
	}

	it("downloads and returns bytes with the remote path", async () => {
		const { md, fetched } = downloader({});
		const result = await md.download({ kind: "photo", fileId: "abc" });
		expect(result).toMatchObject({ filePath: "photos/f.jpg" });
		expect([...result.bytes]).toEqual([1, 2, 3]);
		expect(fetched).toEqual([
			"https://api.telegram.org/file/botTOKEN/photos/f.jpg",
		]);
	});

	it("rejects before any network call when the declared size exceeds the limit", async () => {
		const { md, calls } = downloader({ maxBytes: 50 });
		await expect(
			md.download({ kind: "photo", fileId: "abc", fileSize: 999 }),
		).rejects.toBeInstanceOf(MediaTooLargeError);
		expect(calls).toEqual([]);
	});

	it("rejects when getFile reports an over-limit size", async () => {
		const { md } = downloader({
			maxBytes: 50,
			file: {
				file_id: "abc",
				file_unique_id: "abc",
				file_path: "p.jpg",
				file_size: 999,
			},
		});
		await expect(
			md.download({ kind: "photo", fileId: "abc" }),
		).rejects.toBeInstanceOf(MediaTooLargeError);
	});

	it("rejects when Telegram returns no file_path", async () => {
		const { md } = downloader({
			file: { file_id: "abc", file_unique_id: "abc" },
		});
		await expect(
			md.download({ kind: "photo", fileId: "abc" }),
		).rejects.toBeInstanceOf(MediaUnavailableError);
	});

	it("rejects when the fetched bytes exceed the limit", async () => {
		const { md } = downloader({
			maxBytes: 2,
			bytes: new Uint8Array([1, 2, 3, 4]),
		});
		await expect(
			md.download({ kind: "photo", fileId: "abc" }),
		).rejects.toBeInstanceOf(MediaTooLargeError);
	});
});

describe("loadInlineImages", () => {
	function fakeDownloader(fail = false): MediaDownloader {
		return {
			download: async (ref: { fileId: string }) => {
				if (fail) throw new MediaUnavailableError(ref.fileId);
				return { ref, bytes: new Uint8Array([1, 2, 3]), filePath: "p.jpg" };
			},
		} as unknown as MediaDownloader;
	}

	it("returns a base64 image per inline image (default JPEG mime)", async () => {
		const images = await loadInlineImages(
			fakeDownloader(),
			message({ photo: photos }),
		);
		expect(images).toEqual([
			{ data: toBase64([1, 2, 3]), mimeType: "image/jpeg" },
		]);
	});

	it("skips non-image attachments", async () => {
		const images = await loadInlineImages(
			fakeDownloader(),
			message({
				document: {
					file_id: "d",
					file_unique_id: "d",
					mime_type: "application/pdf",
				},
			} as Partial<Message>),
		);
		expect(images).toEqual([]);
	});

	it("swallows a failed download so one bad image never sinks the turn", async () => {
		const images = await loadInlineImages(
			fakeDownloader(true),
			message({ photo: photos }),
		);
		expect(images).toEqual([]);
	});
});
