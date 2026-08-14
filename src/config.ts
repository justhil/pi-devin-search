import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type ConfigScope = "project" | "global";
export type StoredConfig = {
	apiKey?: string;
	dbPath?: string;
};

export type LoadedConfig = {
	apiKey?: string;
	apiKeySource: "env:DEVIN_SEARCH_API_KEY" | "env:WINDSURF_API_KEY" | "env:WINDSURFAPI_CODEIUM_API_KEY" | "project" | "global" | "none";
	dbPath?: string;
};

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanConfig(config: StoredConfig): StoredConfig {
	const cleaned: StoredConfig = {};
	const apiKey = nonEmpty(config.apiKey);
	const dbPath = nonEmpty(config.dbPath);
	if (apiKey) cleaned.apiKey = apiKey;
	if (dbPath) cleaned.dbPath = dbPath;
	return cleaned;
}

export function getGlobalConfigPath(home = homedir()): string {
	return path.join(home, ".pi", "agent", "devin-search.json");
}

export function getProjectConfigPath(cwd: string): string {
	return path.join(path.resolve(cwd), ".pi", "devin-search.json");
}

export function getConfigFilePath(scope: ConfigScope, cwd: string, home = homedir()): string {
	return scope === "global" ? getGlobalConfigPath(home) : getProjectConfigPath(cwd);
}

export function readStoredConfig(scope: ConfigScope, cwd: string, home = homedir()): StoredConfig {
	try {
		return cleanConfig(JSON.parse(readFileSync(getConfigFilePath(scope, cwd, home), "utf8")) as StoredConfig);
	} catch {
		return {};
	}
}

export function writeStoredConfig(scope: ConfigScope, cwd: string, config: StoredConfig, home = homedir()): string {
	const filePath = getConfigFilePath(scope, cwd, home);
	mkdirSync(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tmpPath, `${JSON.stringify(cleanConfig(config), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		try {
			chmodSync(tmpPath, 0o600);
		} catch {}
		renameSync(tmpPath, filePath);
		try {
			chmodSync(filePath, 0o600);
		} catch {}
	} catch (error) {
		rmSync(tmpPath, { force: true });
		throw error;
	}
	return filePath;
}

export function deleteStoredConfig(scope: ConfigScope, cwd: string, home = homedir()): string {
	const filePath = getConfigFilePath(scope, cwd, home);
	rmSync(filePath, { force: true });
	return filePath;
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): LoadedConfig {
	const project = readStoredConfig("project", cwd, home);
	const global = readStoredConfig("global", cwd, home);
	const envKeys = [
		["env:DEVIN_SEARCH_API_KEY", env.DEVIN_SEARCH_API_KEY],
		["env:WINDSURF_API_KEY", env.WINDSURF_API_KEY],
		["env:WINDSURFAPI_CODEIUM_API_KEY", env.WINDSURFAPI_CODEIUM_API_KEY],
	] as const;
	for (const [source, value] of envKeys) {
		const apiKey = nonEmpty(value);
		if (apiKey) return { apiKey, apiKeySource: source, dbPath: nonEmpty(env.DEVIN_SEARCH_DB_PATH) ?? project.dbPath ?? global.dbPath };
	}
	if (project.apiKey) return { apiKey: project.apiKey, apiKeySource: "project", dbPath: nonEmpty(env.DEVIN_SEARCH_DB_PATH) ?? project.dbPath ?? global.dbPath };
	if (global.apiKey) return { apiKey: global.apiKey, apiKeySource: "global", dbPath: nonEmpty(env.DEVIN_SEARCH_DB_PATH) ?? project.dbPath ?? global.dbPath };
	return { apiKeySource: "none", dbPath: nonEmpty(env.DEVIN_SEARCH_DB_PATH) ?? project.dbPath ?? global.dbPath };
}

export function hasEnvCredential(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(nonEmpty(env.DEVIN_SEARCH_API_KEY) ?? nonEmpty(env.WINDSURF_API_KEY) ?? nonEmpty(env.WINDSURFAPI_CODEIUM_API_KEY));
}

export function persistCredential(scope: ConfigScope, cwd: string, apiKey: string): string {
	return writeStoredConfig(scope, cwd, { ...readStoredConfig(scope, cwd), apiKey });
}
