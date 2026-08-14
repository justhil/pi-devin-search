import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	deleteStoredConfig,
	getConfigFilePath,
	loadConfig,
	readStoredConfig,
	writeStoredConfig,
} from "../src/config.ts";

async function workspace() {
	const root = await mkdtemp(path.join(tmpdir(), "pi-devin-config-"));
	const cwd = path.join(root, "project");
	const home = path.join(root, "home");
	await mkdir(cwd, { recursive: true });
	return { root, cwd, home };
}

test("loadConfig resolves env > project > global and merges db path", async () => {
	const { root, cwd, home } = await workspace();
	try {
		writeStoredConfig("global", cwd, { apiKey: "global-key", dbPath: "global.db" }, home);
		writeStoredConfig("project", cwd, { apiKey: "project-key" }, home);
		assert.deepEqual(loadConfig(cwd, {}, home), {
			apiKey: "project-key",
			apiKeySource: "project",
			dbPath: "global.db",
		});
		assert.deepEqual(loadConfig(cwd, { DEVIN_SEARCH_API_KEY: "env-key", DEVIN_SEARCH_DB_PATH: "env.db" }, home), {
			apiKey: "env-key",
			apiKeySource: "env:DEVIN_SEARCH_API_KEY",
			dbPath: "env.db",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("writeStoredConfig preserves fields and writes valid JSON", async () => {
	const { root, cwd, home } = await workspace();
	try {
		const filePath = writeStoredConfig("global", cwd, { apiKey: " secret ", dbPath: " database " }, home);
		assert.equal(filePath, getConfigFilePath("global", cwd, home));
		assert.deepEqual(readStoredConfig("global", cwd, home), { apiKey: "secret", dbPath: "database" });
		assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { apiKey: "secret", dbPath: "database" });
		deleteStoredConfig("global", cwd, home);
		assert.deepEqual(readStoredConfig("global", cwd, home), {});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
