import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { getProjectConfigPath, readStoredConfig } from "../src/config.ts";

type RegisteredTool = {
	name: string;
	execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>;
};

type RegisteredCommand = {
	handler: (...args: unknown[]) => Promise<void>;
};

class FakePi {
	tools = new Map<string, RegisteredTool>();
	commands = new Map<string, RegisteredCommand>();
	messageRenderers = new Map<string, unknown>();
	messages: unknown[] = [];

	registerTool(tool: RegisteredTool) {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string, command: RegisteredCommand) {
		this.commands.set(name, command);
	}

	registerMessageRenderer(name: string, renderer: unknown) {
		this.messageRenderers.set(name, renderer);
	}

	sendMessage(message: unknown) {
		this.messages.push(message);
	}
}

function context() {
	return {
		ui: {
			setStatus() {},
			notify() {},
		},
	};
}

test("extension registers search, status, config, and import commands", () => {
	const pi = new FakePi();
	extension(pi as unknown as ExtensionAPI);
	assert.deepEqual([...pi.tools.keys()], ["devin_search"]);
	assert.deepEqual([...pi.commands.keys()], ["devin-search", "devin-search-status", "devin-search-config", "devin-search-import-key"]);
	assert.equal(pi.messageRenderers.has("devin-search"), true);
});

test("devin-search-config import persists a DB credential after TUI confirmation", async () => {
	const pi = new FakePi();
	extension(pi as unknown as ExtensionAPI);
	const root = await mkdtemp(path.join(tmpdir(), "pi-devin-tui-"));
	const dbPath = path.join(root, "state.vscdb");
	const SQL = await initSqlJs();
	const db = new SQL.Database();
	db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
	db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", ["windsurfAuthStatus", JSON.stringify({ apiKey: "devin-session-token$tui-test" })]);
	await import("node:fs/promises").then(({ writeFile }) => writeFile(dbPath, Buffer.from(db.export())));
	db.close();

	const originalDbPath = process.env.DEVIN_SEARCH_DB_PATH;
	process.env.DEVIN_SEARCH_DB_PATH = dbPath;
	const notifications: string[] = [];
	try {
		const command = pi.commands.get("devin-search-config");
		assert.ok(command);
		await command.handler("import project", {
			cwd: root,
			hasUI: true,
			ui: {
				select: async () => { throw new Error("explicit project scope should not open a scope selector"); },
				confirm: async () => true,
				notify: (message: string) => notifications.push(message),
				setStatus() {},
			},
		});
		assert.deepEqual(readStoredConfig("project", root), { apiKey: "devin-session-token$tui-test" });
		assert.equal(existsSync(getProjectConfigPath(root)), true);
		assert.match(notifications.at(-1) ?? "", /已保存 Devin\/Windsurf 凭证/);
	} finally {
		if (originalDbPath === undefined) delete process.env.DEVIN_SEARCH_DB_PATH;
		else process.env.DEVIN_SEARCH_DB_PATH = originalDbPath;
		await rm(root, { recursive: true, force: true });
	}
});

test("devin_search resolves env credential and formats upstream results", async () => {
	const pi = new FakePi();
	extension(pi as unknown as ExtensionAPI);
	const originalFetch = globalThis.fetch;
	const originalKey = process.env.DEVIN_SEARCH_API_KEY;
	process.env.DEVIN_SEARCH_API_KEY = "devin-session-token$test";
	globalThis.fetch = async () => new Response(JSON.stringify({
		results: [{ title: "Pi extensions", url: "https://example.test/extensions", summary: "Extension docs" }],
	}), { status: 200, headers: { "content-type": "application/json" } });

	try {
		const tool = pi.tools.get("devin_search");
		assert.ok(tool);
		const result = await tool.execute("call", { query: "pi extensions", limit: 1 }, undefined, undefined, context());
		assert.match(result.content[0]?.text ?? "", /Pi extensions/);
		assert.match(result.content[0]?.text ?? "", /https:\/\/example\.test\/extensions/);
		assert.equal(result.details?.resultCount, 1);
		assert.equal(result.details?.credentialSource, "env:DEVIN_SEARCH_API_KEY");
	} finally {
		globalThis.fetch = originalFetch;
		if (originalKey === undefined) delete process.env.DEVIN_SEARCH_API_KEY;
		else process.env.DEVIN_SEARCH_API_KEY = originalKey;
	}
});
