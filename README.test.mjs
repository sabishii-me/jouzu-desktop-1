import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");

test("README describes the repository as standalone", () => {
	const line = readme.split(/\r?\n/)[2];
	assert.equal(line, "Standalone desktop product repository.");
});
