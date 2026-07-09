import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		include: ["tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			// Mocks/fakes live only under tests/helpers and are excluded from coverage.
			exclude: ["tests/helpers/**"],
		},
	},
});
