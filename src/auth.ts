import { readFileSync, existsSync } from "node:fs";
import { homedir, platform as currentPlatform } from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";

export type CredentialSource =
	| "env:DEVIN_SEARCH_API_KEY"
	| "env:WINDSURF_API_KEY"
	| "env:WINDSURFAPI_CODEIUM_API_KEY"
	| "project"
	| "global"
	| "devin-db"
	| "windsurf-db"
	| "custom-db"
	| "none";

export type DbCandidate = {
	path: string;
	source: "devin-db" | "windsurf-db" | "custom-db";
};

export type ResolvedCredential = {
	apiKey?: string;
	source: CredentialSource;
	dbPath?: string;
	attemptedPaths: string[];
	errors: string[];
};

type ResolveOptions = {
	env?: NodeJS.ProcessEnv;
	candidates?: DbCandidate[];
	dbPath?: string;
	apiKey?: string;
	source?: CredentialSource;
};

let sqlPromise: ReturnType<typeof initSqlJs> | undefined;

function getSql() {
	sqlPromise ??= initSqlJs();
	return sqlPromise;
}

function firstNonEmpty(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

export function candidateDbPaths(
	env: NodeJS.ProcessEnv = process.env,
	platform = currentPlatform(),
	home = homedir(),
	dbPath?: string,
): DbCandidate[] {
	const override = firstNonEmpty(dbPath, env.DEVIN_SEARCH_DB_PATH);
	const defaults = (() => {
		let base: string;
		if (platform === "win32") {
			base = firstNonEmpty(env.APPDATA) ?? path.join(home, "AppData", "Roaming");
		} else if (platform === "darwin") {
			base = path.join(home, "Library", "Application Support");
		} else {
			base = firstNonEmpty(env.XDG_CONFIG_HOME) ?? path.join(home, ".config");
		}
		return [
			{ path: path.join(base, "Devin", "User", "globalStorage", "state.vscdb"), source: "devin-db" as const },
			{ path: path.join(base, "Windsurf", "User", "globalStorage", "state.vscdb"), source: "windsurf-db" as const },
		];
	})();

	if (!override) return defaults;
	const custom = { path: path.resolve(override), source: "custom-db" as const };
	return [custom, ...defaults.filter((candidate) => candidate.path !== custom.path)];
}

export async function readCredentialFromDb(dbPath: string): Promise<string> {
	const SQL = await getSql();
	const db = new SQL.Database(readFileSync(dbPath));
	try {
		const statement = db.prepare("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'");
		try {
			if (!statement.step()) throw new Error("windsurfAuthStatus record not found");
			const row = statement.getAsObject();
			if (typeof row.value !== "string") throw new Error("windsurfAuthStatus value is not text");
			const parsed = JSON.parse(row.value) as { apiKey?: unknown };
			const apiKey = firstNonEmpty(parsed.apiKey);
			if (!apiKey) throw new Error("windsurfAuthStatus.apiKey is empty");
			return apiKey;
		} finally {
			statement.free();
		}
	} finally {
		db.close();
	}
}

export async function resolveCredential(options: ResolveOptions = {}): Promise<ResolvedCredential> {
	const env = options.env ?? process.env;
	const configuredKey = firstNonEmpty(options.apiKey);
	if (configuredKey) {
		return {
			apiKey: configuredKey,
			source: options.source ?? "none",
			attemptedPaths: [],
			errors: [],
		};
	}
	const envKeys = [
		["DEVIN_SEARCH_API_KEY", env.DEVIN_SEARCH_API_KEY],
		["WINDSURF_API_KEY", env.WINDSURF_API_KEY],
		["WINDSURFAPI_CODEIUM_API_KEY", env.WINDSURFAPI_CODEIUM_API_KEY],
	] as const;

	for (const [name, value] of envKeys) {
		const apiKey = firstNonEmpty(value);
		if (apiKey) {
			return {
				apiKey,
				source: `env:${name}` as CredentialSource,
				attemptedPaths: [],
				errors: [],
			};
		}
	}

	const candidates = options.candidates ?? candidateDbPaths(env, currentPlatform(), homedir(), options.dbPath);
	const attemptedPaths = candidates.map((candidate) => candidate.path);
	const errors: string[] = [];

	for (const candidate of candidates) {
		if (!existsSync(candidate.path)) continue;
		try {
			return {
				apiKey: await readCredentialFromDb(candidate.path),
				source: candidate.source,
				dbPath: candidate.path,
				attemptedPaths,
				errors,
			};
		} catch (error) {
			errors.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { source: "none", attemptedPaths, errors };
}

export function maskCredential(apiKey: string | undefined): string {
	if (!apiKey) return "not found";
	if (apiKey.length <= 12) return "********";
	return `${apiKey.slice(0, 12)}…${apiKey.slice(-6)}`;
}

export function describeCredential(apiKey: string | undefined): string {
	if (!apiKey) return "missing";
	if (apiKey.startsWith("devin-session-token$")) return "devin session token";
	if (apiKey.startsWith("sk-ws-")) return "legacy Windsurf API key";
	return "unknown token format";
}
