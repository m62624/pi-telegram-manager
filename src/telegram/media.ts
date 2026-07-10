/**
 * Inbound media: describe the attachments on a Telegram message, then download
 * them with a size cap.
 *
 * The description half is pure — it reads the `photo`/`document`/… fields off a
 * `Message` into a small `AttachmentRef` (picking the largest photo size) — so
 * it is fully unit-testable. The download half reaches Telegram through two
 * injected ports (`getFile` and a `fetchBytes` function) plus the file base URL
 * (`https://api.telegram.org/file/bot<token>`), so no network is needed in
 * tests. The `files.maxBytes` cap is enforced three times: against the declared
 * size, against `getFile`'s reported size, and against the bytes actually
 * fetched.
 */
import type { File, Message, PhotoSize } from "@grammyjs/types";

export type AttachmentKind =
	| "photo"
	| "document"
	| "voice"
	| "audio"
	| "video"
	| "animation";

/** A downloadable reference extracted from a message, independent of grammY. */
export interface AttachmentRef {
	kind: AttachmentKind;
	fileId: string;
	fileSize?: number;
	mimeType?: string;
	fileName?: string;
}

/** Raised when an attachment exceeds the configured byte cap. */
export class MediaTooLargeError extends Error {
	constructor(
		readonly limit: number,
		readonly actual: number,
	) {
		super(`attachment of ${actual} bytes exceeds the ${limit}-byte limit`);
		this.name = "MediaTooLargeError";
	}
}

/** Raised when Telegram returns no downloadable path for a file. */
export class MediaUnavailableError extends Error {
	constructor(readonly fileId: string) {
		super(`Telegram returned no file_path for ${fileId}`);
		this.name = "MediaUnavailableError";
	}
}

/**
 * Pick the highest-resolution photo size within `maxBytes`. If every size
 * exceeds the cap, fall back to the smallest one — it has the best chance of
 * downloading under the real limit (a photo's `file_size` is only an estimate).
 */
export function pickPhotoSize(
	photos: readonly PhotoSize[],
	maxBytes = Number.POSITIVE_INFINITY,
): PhotoSize | undefined {
	if (photos.length === 0) return undefined;
	const area = (p: PhotoSize): number => p.width * p.height;
	const bytes = (p: PhotoSize): number => p.file_size ?? area(p);
	const withinLimit = photos.filter((p) => (p.file_size ?? 0) <= maxBytes);
	if (withinLimit.length > 0) {
		return withinLimit.reduce((best, p) => (bytes(p) > bytes(best) ? p : best));
	}
	return photos.reduce((best, p) => (bytes(p) < bytes(best) ? p : best));
}

/** Extract downloadable attachment references from a message (largest photo size only). */
export function describeAttachments(
	message: Message,
	maxBytes?: number,
): AttachmentRef[] {
	const refs: AttachmentRef[] = [];
	if (message.photo && message.photo.length > 0) {
		const size = pickPhotoSize(message.photo, maxBytes);
		if (size)
			refs.push({
				kind: "photo",
				fileId: size.file_id,
				fileSize: size.file_size,
			});
	}
	if (message.document) {
		refs.push({
			kind: "document",
			fileId: message.document.file_id,
			fileSize: message.document.file_size,
			mimeType: message.document.mime_type,
			fileName: message.document.file_name,
		});
	}
	if (message.video) {
		refs.push({
			kind: "video",
			fileId: message.video.file_id,
			fileSize: message.video.file_size,
			mimeType: message.video.mime_type,
			fileName: message.video.file_name,
		});
	}
	if (message.animation) {
		refs.push({
			kind: "animation",
			fileId: message.animation.file_id,
			fileSize: message.animation.file_size,
			mimeType: message.animation.mime_type,
			fileName: message.animation.file_name,
		});
	}
	if (message.audio) {
		refs.push({
			kind: "audio",
			fileId: message.audio.file_id,
			fileSize: message.audio.file_size,
			mimeType: message.audio.mime_type,
			fileName: message.audio.file_name,
		});
	}
	if (message.voice) {
		refs.push({
			kind: "voice",
			fileId: message.voice.file_id,
			fileSize: message.voice.file_size,
			mimeType: message.voice.mime_type,
		});
	}
	return refs;
}

/** True for attachments the model can consume as an inline image. */
export function isImage(ref: AttachmentRef): boolean {
	return ref.kind === "photo" || (ref.mimeType?.startsWith("image/") ?? false);
}

/** Base64-encode raw bytes (for feeding an image to the model). */
export function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

/** The single grammY api call the downloader needs. */
export interface FileApi {
	getFile(args: { file_id: string }): Promise<File>;
}

/** Fetch a URL into raw bytes (wraps `fetch(...).arrayBuffer()` in production). */
export type FetchBytes = (url: string) => Promise<Uint8Array>;

export interface MediaDownloaderDeps {
	api: FileApi;
	fetchBytes: FetchBytes;
	/** e.g. `https://api.telegram.org/file/bot<token>` (no trailing slash). */
	fileBaseUrl: string;
	maxBytes: number;
}

export interface DownloadedFile {
	ref: AttachmentRef;
	bytes: Uint8Array;
	/** The remote Telegram `file_path`. */
	filePath: string;
}

export class MediaDownloader {
	constructor(private readonly deps: MediaDownloaderDeps) {}

	/** Download an attachment, enforcing the byte cap at every stage. */
	async download(ref: AttachmentRef): Promise<DownloadedFile> {
		const { api, fetchBytes, fileBaseUrl, maxBytes } = this.deps;
		if (ref.fileSize !== undefined && ref.fileSize > maxBytes) {
			throw new MediaTooLargeError(maxBytes, ref.fileSize);
		}
		const file = await api.getFile({ file_id: ref.fileId });
		if (file.file_size !== undefined && file.file_size > maxBytes) {
			throw new MediaTooLargeError(maxBytes, file.file_size);
		}
		if (!file.file_path) {
			throw new MediaUnavailableError(ref.fileId);
		}
		const bytes = await fetchBytes(`${fileBaseUrl}/${file.file_path}`);
		if (bytes.length > maxBytes) {
			throw new MediaTooLargeError(maxBytes, bytes.length);
		}
		return { ref, bytes, filePath: file.file_path };
	}
}
