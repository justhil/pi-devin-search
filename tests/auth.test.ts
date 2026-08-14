import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import { candidateDbPaths, describeCredential, maskCredential, readCredentialFromDb, resolveCredential } from "../src/auth.ts";

test("candidateDbPaths prefers Devin before Windsurf on Windows", () => {
	const paths = candidateDbPaths({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32", "C:\\Users\\me");
	assert.equal(paths[0]?.source, "devin-db");
	assert.match(paths[0]?.path ?? "", /Devin[\\/]User[\\/]globalStorage[\\/]state\.vscdb$/);
	assert.equal(paths[1]?.source, "windsurf-db");
});

test("candidateDbPaths honors DEVIN_SEARCH_DB_PATH and keeps default fallbacks", () => {
	const paths = candidateDbPaths({ DEVIN_SEARCH_DB_PATH: "./custom.vscdb" }, "linux", "/home/me");
	assert.equal(paths.length, 3);
	assert.equal(paths[0]?.source, "custom-db");
	assert.match(paths[0]?.path ?? "", /custom\.vscdb$/);
	assert.equal(paths[1]?.source, "devin-db");
	assert.equal(paths[2]?.source, "windsurf-db");
});

test("readCredentialFromDb extracts windsurfAuthStatus.apiKey", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-devin-search-"));
	const dbPath = path.join(directory, "state.vscdb");
	const SQL = await initSqlJs();
	const db = new SQL.Database();
	try {
		db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
		db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [
			"windsurfAuthStatus",
			JSON.stringify({ apiKey: "devin-session-token$db-test" }),
		]);
		await writeFile(dbPath, Buffer.from(db.export()));
	} finally {
		db.close();
	}

	try {
		assert.equal(await readCredentialFromDb(dbPath), "devin-session-token$db-test");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("resolveCredential prefers explicit environment variables", async () => {
	const result = await resolveCredential({
		env: { DEVIN_SEARCH_API_KEY: " devin-session-token$test " },
		candidates: [],
	});
	assert.equal(result.apiKey, "devin-session-token$test");
	assert.equal(result.source, "env:DEVIN_SEARCH_API_KEY");
});

test("credential display helpers never reveal the full token", () => {
	const token = "devin-session-token$test-value";
	const masked = maskCredential(token);
	assert.notEqual(masked, token);
	assert.equal(masked.includes("test-value"), false);
	assert.equal(describeCredential(token), "devin session token");
});
