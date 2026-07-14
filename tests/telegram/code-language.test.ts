import { describe, expect, it } from "vitest";
import {
	languageForPath,
	normalizeCodeFences,
	normalizeLanguage,
	TELEGRAM_CODE_LANGUAGES,
} from "../../src/telegram/code-language";

describe("the language set is Telegram's own", () => {
	it("knows the names libprisma documents, and only those", () => {
		// Spot-checks against the README's table: these are real ids/aliases.
		for (const known of [
			"rust",
			"cpp",
			"typescript",
			"ts",
			"python",
			"py",
			"javascript",
			"js",
			"bash",
			"sh",
			"shell",
			"yaml",
			"yml",
			"markdown",
			"md",
			"ruby",
			"rb",
			"csharp",
			"cs",
			"go",
			"json",
			"toml",
			"docker",
			"dockerfile",
			"diff",
			"tsx",
			"jsx",
		]) {
			expect(TELEGRAM_CODE_LANGUAGES.has(known)).toBe(true);
		}
	});

	it("does NOT invent the aliases everyone assumes exist", () => {
		// The whole reason this file exists. Telegram highlights nothing for these.
		for (const missing of [
			"rs",
			"c++",
			"golang",
			"py3",
			"node",
			"text",
			"plain",
		]) {
			expect(TELEGRAM_CODE_LANGUAGES.has(missing)).toBe(false);
		}
	});
});

describe("languageForPath", () => {
	it("names the language of the files we actually work in", () => {
		expect(languageForPath("src/index.ts")).toBe("typescript");
		expect(languageForPath("src/App.tsx")).toBe("tsx");
		expect(languageForPath("main.rs")).toBe("rust");
		expect(languageForPath("script.py")).toBe("python");
		expect(languageForPath("run.sh")).toBe("bash");
		expect(languageForPath("Cargo.toml")).toBe("toml");
		expect(languageForPath("package.json")).toBe("json");
		expect(languageForPath("ci.yml")).toBe("yaml");
		expect(languageForPath("main.cpp")).toBe("cpp");
		expect(languageForPath("lib.hpp")).toBe("cpp");
	});

	it("maps a file to a language Telegram will actually accept", () => {
		// Every mapping must land inside the set, or the tag is decoration.
		for (const path of [
			"a.ts",
			"a.rs",
			"a.py",
			"a.go",
			"a.rb",
			"a.kt",
			"a.swift",
			"a.sql",
			"a.scss",
			"a.ex",
			"a.jl",
			"a.zig",
			"a.sol",
			"a.diff",
			"Dockerfile",
			"Makefile",
			"go.mod",
		]) {
			const language = languageForPath(path);
			expect(language).toBeDefined();
			expect(TELEGRAM_CODE_LANGUAGES.has(language as string)).toBe(true);
		}
	});

	it("reads the file NAME, not the directory around it", () => {
		expect(languageForPath("/home/rs/notes.py")).toBe("python");
		expect(languageForPath("C:\\src\\py\\main.rs")).toBe("rust");
		expect(languageForPath("/a.b.c/deep/main.go")).toBe("go");
	});

	it("knows the files whose NAME is the language", () => {
		expect(languageForPath("/app/Dockerfile")).toBe("docker");
		expect(languageForPath("Makefile")).toBe("makefile");
		expect(languageForPath("CMakeLists.txt")).toBe("cmake");
		expect(languageForPath(".gitignore")).toBe("ignore");
	});

	it("stays quiet when it does not know — a wrong tag is worse than none", () => {
		// This is the false-positive guard: better plain text than code highlighted as
		// the wrong language.
		expect(languageForPath("notes.txt")).toBeUndefined();
		expect(languageForPath("data.bin")).toBeUndefined();
		expect(languageForPath("archive.tar.gz")).toBeUndefined();
		expect(languageForPath("README")).toBeUndefined();
		expect(languageForPath("no-extension")).toBeUndefined();
		expect(languageForPath("trailing.")).toBeUndefined();
		expect(languageForPath("")).toBeUndefined();
		expect(languageForPath(undefined)).toBeUndefined();
	});
});

describe("normalizeLanguage", () => {
	it("passes a name Telegram knows straight through", () => {
		expect(normalizeLanguage("rust")).toBe("rust");
		expect(normalizeLanguage("py")).toBe("py");
		expect(normalizeLanguage("YAML")).toBe("yaml");
		expect(normalizeLanguage("  ts  ")).toBe("ts");
	});

	it("corrects the names it does not — to a real one, never an invented one", () => {
		expect(normalizeLanguage("rs")).toBe("rust");
		expect(normalizeLanguage("c++")).toBe("cpp");
		expect(normalizeLanguage("golang")).toBe("go");
		expect(normalizeLanguage("nodejs")).toBe("javascript");
		expect(normalizeLanguage("terraform")).toBe("hcl");
		for (const name of ["rs", "c++", "golang", "nodejs", "terraform", "zsh"]) {
			expect(
				TELEGRAM_CODE_LANGUAGES.has(normalizeLanguage(name) as string),
			).toBe(true);
		}
	});

	it("drops a name nobody can highlight", () => {
		expect(normalizeLanguage("gibberish")).toBeUndefined();
		expect(normalizeLanguage("text")).toBeUndefined();
		expect(normalizeLanguage("")).toBeUndefined();
		expect(normalizeLanguage(undefined)).toBeUndefined();
	});
});

describe("normalizeCodeFences", () => {
	it("fixes the tag the model habitually gets wrong", () => {
		expect(normalizeCodeFences("```rs\nfn main() {}\n```")).toBe(
			"```rust\nfn main() {}\n```",
		);
		expect(normalizeCodeFences("```c++\nint x;\n```")).toBe(
			"```cpp\nint x;\n```",
		);
	});

	it("leaves a tag Telegram already understands alone", () => {
		const good = "```bash\necho hi\n```";
		expect(normalizeCodeFences(good)).toBe(good);
		const python = "```py\nx = 1\n```";
		expect(normalizeCodeFences(python)).toBe(python);
	});

	it("drops a tag that would highlight nothing", () => {
		expect(normalizeCodeFences("```gibberish\nx\n```")).toBe("```\nx\n```");
	});

	it("never touches a byte of the code inside", () => {
		// The false-positive that would matter most: rewriting the user's code because a
		// line inside it looks like a fence tag.
		const source = [
			"```python",
			"s = '```rs'",
			"# ```c++ is not a fence",
			"```",
		].join("\n");
		expect(normalizeCodeFences(source)).toBe(source);
	});

	it("does not tag a closing fence, and survives an unbalanced one", () => {
		expect(normalizeCodeFences("```\ncode\n```")).toBe("```\ncode\n```");
		expect(normalizeCodeFences("```rs\ncode")).toBe("```rust\ncode");
		expect(normalizeCodeFences("no code at all")).toBe("no code at all");
	});

	it("handles several blocks, and the prose between them", () => {
		const input = [
			"Try this:",
			"```rs",
			"fn a() {}",
			"```",
			"and then:",
			"```ts",
			"const a = 1;",
			"```",
		].join("\n");
		expect(normalizeCodeFences(input)).toBe(input.replace("```rs", "```rust"));
	});

	it("is idempotent — running it twice changes nothing more", () => {
		const once = normalizeCodeFences("```rs\nfn main() {}\n```");
		expect(normalizeCodeFences(once)).toBe(once);
	});
});
