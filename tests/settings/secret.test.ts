import { describe, expect, it } from "vitest";
import { isEnvReference, resolveSecret } from "../../src/settings/secret";

describe("resolveSecret", () => {
	it("returns a literal value unchanged", () => {
		expect(resolveSecret("123:ABC", {})).toBe("123:ABC");
	});

	it("dereferences an env: reference from the given environment", () => {
		expect(resolveSecret("env:TG_TOKEN", { TG_TOKEN: "secret" })).toBe(
			"secret",
		);
	});

	it("returns undefined for an unset or empty env reference", () => {
		expect(resolveSecret("env:MISSING", {})).toBeUndefined();
		expect(resolveSecret("env:EMPTY", { EMPTY: "" })).toBeUndefined();
		expect(resolveSecret("env:", { "": "x" })).toBeUndefined();
	});

	it("returns undefined for an absent value", () => {
		expect(resolveSecret(undefined, {})).toBeUndefined();
		expect(resolveSecret("", {})).toBeUndefined();
	});
});

describe("isEnvReference", () => {
	it("detects the env: prefix", () => {
		expect(isEnvReference("env:X")).toBe(true);
		expect(isEnvReference("literal")).toBe(false);
		expect(isEnvReference(undefined)).toBe(false);
	});
});
