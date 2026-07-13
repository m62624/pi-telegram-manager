import { describe, expect, it } from "vitest";
import { expandHomePath, resolveUserDir } from "../../src/core/user-path";

const POSIX_HOME = "/home/u";
const WINDOWS_HOME = "C:\\Users\\u";
const FALLBACK = "/agent/extensions/pi-telegram-manager/tool-output";

describe("expandHomePath", () => {
	it("expands a bare ~", () => {
		expect(expandHomePath("~", POSIX_HOME)).toBe("/home/u");
		expect(expandHomePath("~", WINDOWS_HOME)).toBe("C:\\Users\\u");
	});

	it("expands ~/x with the home directory's own separator", () => {
		expect(expandHomePath("~/logs/pi", POSIX_HOME)).toBe("/home/u/logs/pi");
		// A Windows home gets Windows separators, whichever slash the user typed.
		expect(expandHomePath("~/logs", WINDOWS_HOME)).toBe("C:\\Users\\u\\logs");
		expect(expandHomePath("~\\logs", WINDOWS_HOME)).toBe("C:\\Users\\u\\logs");
	});

	it("expands ~\\x on POSIX too — a config file travels between machines", () => {
		expect(expandHomePath("~\\logs", POSIX_HOME)).toBe("/home/u/logs");
	});

	it("does not double a separator the home directory already ends with", () => {
		expect(expandHomePath("~/logs", "/home/u/")).toBe("/home/u/logs");
		expect(expandHomePath("~\\logs", "C:\\Users\\u\\")).toBe(
			"C:\\Users\\u\\logs",
		);
	});

	it("leaves every other path exactly as written", () => {
		// Absolute POSIX, relative, Windows drive (both slashes), and UNC.
		for (const path of [
			"/var/log/pi",
			"./out",
			"../out",
			"C:\\logs\\pi",
			"D:/logs",
			"\\\\server\\share\\pi",
			"logs",
		]) {
			expect(expandHomePath(path, POSIX_HOME)).toBe(path);
			expect(expandHomePath(path, WINDOWS_HOME)).toBe(path);
		}
	});

	it("does not touch a ~ that is not leading", () => {
		expect(expandHomePath("/tmp/~backup", POSIX_HOME)).toBe("/tmp/~backup");
		expect(expandHomePath("~user/x", POSIX_HOME)).toBe("~user/x");
	});
});

describe("resolveUserDir", () => {
	it("falls back when unset or blank", () => {
		// "  " in a config file means "I did not set this", not "a directory named space".
		expect(resolveUserDir(undefined, FALLBACK, POSIX_HOME)).toBe(FALLBACK);
		expect(resolveUserDir("", FALLBACK, POSIX_HOME)).toBe(FALLBACK);
		expect(resolveUserDir("   ", FALLBACK, POSIX_HOME)).toBe(FALLBACK);
	});

	it("trims and expands what the owner did set", () => {
		expect(resolveUserDir("  ~/logs  ", FALLBACK, POSIX_HOME)).toBe(
			"/home/u/logs",
		);
		expect(resolveUserDir("C:\\logs", FALLBACK, WINDOWS_HOME)).toBe("C:\\logs");
	});
});
