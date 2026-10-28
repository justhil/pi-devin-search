import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { candidateDbPaths, describeCredential, maskCredential, readCredentialFromDb, resolveCredential, type ResolvedCredential } from "./auth.js";
import {
	deleteStoredConfig,
	getConfigFilePath,
	hasEnvCredential,
	loadConfig,
	persistCredential,
	readStoredConfig,
	writeStoredConfig,
	type ConfigScope,
} from "./config.js";
import { searchDevin, type DevinSearchResponse } from "./client.js";

const SEARCH_PARAMS = Type.Object({
	query: Type.String({ minLength: 1, description: "Focused, self-contained web search query." }),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum results to return. Defaults to 5; maximum 10." })),
	domain: Type.Optional(Type.String({ description: "Optional domain restriction, for example github.com." })),
});

type SearchParams = Static<typeof SEARCH_PARAMS>;
type SearchDetails = {
	query: string;
	resultCount: number;
	firstTitle?: string;
	host: string;
	credentialSource: ResolvedCredential["source"];
	startedAt: number;
};

type UiContext = ExtensionCommandContext & { hasUI?: boolean };

const MAX_OUTPUT_CHARS = 8_000;
const MAX_RESULT_SUMMARY_CHARS = 400;
const MAX_UPSTREAM_SUMMARY_CHARS = 600;
let statusSequence = 0;
let activeStatus = 0;

function firstLine(value: string, maxLength = 100): string {
	const line = value.trim().split(/\r?\n/, 1)[0] ?? "";
	return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1)}…`;
}

function elapsed(startedAt: number | undefined): string {
	if (!startedAt) return "";
	return `${Math.max(0, Math.round((Date.now() - startedAt) / 1000))}s`;
}

function beginStatus(ctx: { ui: { setStatus: (key: string, value: string | undefined) => void } }) {
	const owner = ++statusSequence;
	activeStatus = owner;
	ctx.ui.setStatus("devin-search", "devin-search: searching");
	return (final?: string) => {
		if (activeStatus !== owner) return;
		if (!final) {
			ctx.ui.setStatus("devin-search", undefined);
			activeStatus = 0;
			return;
		}
		ctx.ui.setStatus("devin-search", final);
		setTimeout(() => {
			if (activeStatus !== owner) return;
			ctx.ui.setStatus("devin-search", undefined);
			activeStatus = 0;
		}, 1400);
	};
}

function credentialError(credential: ResolvedCredential): Error {
	const paths = credential.attemptedPaths.length ? `\nChecked:\n- ${credential.attemptedPaths.join("\n- ")}` : "";
	const errors = credential.errors.length ? `\nErrors:\n- ${credential.errors.join("\n- ")}` : "";
	return new Error(
		`Devin credential not found. Run /devin-search-config import, log in to Devin/Windsurf, or set DEVIN_SEARCH_API_KEY / WINDSURF_API_KEY.${paths}${errors}`,
	);
}

function shortSummary(value: string, maxChars: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function formatSearchResponse(query: string, response: DevinSearchResponse): string {
	if (response.results.length === 0) return `No Devin search results for: ${query}`;
	const lines = [`Devin search results for: ${query}`, ""];
	for (const [index, result] of response.results.entries()) {
		lines.push(`${index + 1}. ${result.title}`, `   ${result.url}`);
		if (result.summary) lines.push(`   ${shortSummary(result.summary, MAX_RESULT_SUMMARY_CHARS)}`);
		lines.push("");
	}
	if (response.summary) lines.push("Upstream summary:", shortSummary(response.summary, MAX_UPSTREAM_SUMMARY_CHARS), "");
	if (response.webSearchUrl) lines.push(`Search URL: ${response.webSearchUrl}`);
	const text = lines.join("\n").trim();
	return text.length <= MAX_OUTPUT_CHARS
		? text
		: `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[devin_search output truncated at ${MAX_OUTPUT_CHARS} characters]`;
}

async function resolveConfiguredCredential(cwd: string): Promise<ResolvedCredential> {
	const config = loadConfig(cwd);
	return resolveCredential({ apiKey: config.apiKey, source: config.apiKeySource, dbPath: config.dbPath });
}

async function runSearch(cwd: string, params: SearchParams, signal?: AbortSignal) {
	const credential = await resolveConfiguredCredential(cwd);
	if (!credential.apiKey) throw credentialError(credential);
	const response = await searchDevin(credential.apiKey, params.query, {
		limit: params.limit,
		domain: params.domain,
		signal,
	});
	return { credential, response };
}

function configStatus(cwd: string, credential: ResolvedCredential): string {
	return [
		"pi-devin-search status",
		"",
		`credential: ${credential.apiKey ? "ready" : "missing"}`,
		`source: ${credential.source}`,
		`format: ${describeCredential(credential.apiKey)}`,
		`masked: ${maskCredential(credential.apiKey)}`,
		`database: ${credential.dbPath ?? "not selected"}`,
		"",
		"Resolution order:",
		"1. DEVIN_SEARCH_API_KEY / WINDSURF_API_KEY / WINDSURFAPI_CODEIUM_API_KEY",
		`2. project config: ${getConfigFilePath("project", cwd)}`,
		`3. global config: ${getConfigFilePath("global", cwd)}`,
		"4. Devin state.vscdb",
		"5. Windsurf state.vscdb",
		"",
		"Configure: /devin-search-config",
		"Import: /devin-search-config import",
		"Connectivity test: /devin-search-config test [query]",
		...(credential.errors.length ? ["", "Database errors:", ...credential.errors.map((error) => `- ${error}`)] : []),
	].join("\n");
}

function scopeName(scope: ConfigScope): string {
	return scope === "global" ? "全局" : "项目";
}

function parseScopeArg(args: string): ConfigScope | undefined {
	const words = args.toLowerCase().split(/\s+/);
	if (words.includes("global")) return "global";
	if (words.includes("project")) return "project";
	return undefined;
}

async function chooseImportScope(ctx: UiContext): Promise<ConfigScope | undefined> {
	const choice = await ctx.ui.select("保存自动发现的 Devin/Windsurf 凭证", [
		"保存到全局配置（推荐）",
		"保存到项目配置（高级 / 有风险）",
		"取消",
	]);
	if (!choice || choice === "取消") return undefined;
	return choice.startsWith("保存到项目") ? "project" : "global";
}

async function discoverDbCredential(cwd: string): Promise<ResolvedCredential> {
	const config = loadConfig(cwd);
	const candidates = candidateDbPaths(process.env, undefined, undefined, config.dbPath);
	return resolveCredential({ env: {}, candidates });
}

async function importCredentialFlow(ctx: UiContext, requestedScope?: ConfigScope): Promise<void> {
	const discovered = await discoverDbCredential(ctx.cwd);
	if (!discovered.apiKey) {
		ctx.ui.notify([
			"未能从 Devin/Windsurf state.vscdb 自动获取凭证。",
			...(discovered.attemptedPaths.length ? ["Checked:", ...discovered.attemptedPaths.map((item) => `- ${item}`)] : []),
			...(discovered.errors.length ? ["Errors:", ...discovered.errors.map((item) => `- ${item}`)] : []),
			"",
			"请先登录 Devin/Windsurf 桌面端，或手动设置环境变量。",
		].join("\n"), "warning");
		return;
	}

	const scope = requestedScope ?? await chooseImportScope(ctx);
	if (!scope) return;
	if (scope === "project") {
		const ok = await ctx.ui.confirm(
			"确认保存到项目配置？",
			"凭证会写入 .pi/devin-search.json。请确认 .pi/ 不会提交到 Git；推荐优先保存到全局配置。是否继续？",
		);
		if (!ok) return;
	}
	const stored = readStoredConfig(scope, ctx.cwd);
	if (stored.apiKey && stored.apiKey !== discovered.apiKey) {
		const ok = await ctx.ui.confirm(
			"覆盖已有凭证？",
			`${scopeName(scope)}配置已有凭证：${maskCredential(stored.apiKey)}\n新发现凭证：${maskCredential(discovered.apiKey)}\n\n是否覆盖？`,
		);
		if (!ok) return;
	}
	const filePath = persistCredential(scope, ctx.cwd, discovered.apiKey);
	ctx.ui.notify([
		"已保存 Devin/Windsurf 凭证。",
		`scope: ${scopeName(scope)}`,
		`file: ${filePath}`,
		`credential: ${maskCredential(discovered.apiKey)}`,
		`source db: ${discovered.dbPath ?? "auto"}`,
		...(hasEnvCredential() ? ["", "注意：环境变量仍拥有最高优先级。"] : []),
	].join("\n"), "info");
}

async function editScopeFlow(ctx: UiContext, scope: ConfigScope): Promise<void> {
	while (true) {
		const stored = readStoredConfig(scope, ctx.cwd);
		const choice = await ctx.ui.select(`${scopeName(scope)} devin-search 配置`, [
			`自动导入 Devin/Windsurf 凭证`,
			`手动设置凭证 = ${maskCredential(stored.apiKey)}`,
			`设置数据库路径 = ${stored.dbPath ?? "auto"}`,
			"返回",
		]);
		if (!choice || choice === "返回") return;
		if (choice.startsWith("自动导入")) {
			await importCredentialFlow(ctx, scope);
			continue;
		}
		if (choice.startsWith("手动设置")) {
			const value = await ctx.ui.input("设置 Devin/Windsurf 凭证", "留空 = 保持不变，输入 '-' = 清除。注意：输入内容会明文显示。");
			if (value === undefined || !value.trim()) continue;
			if (scope === "project" && value.trim() !== "-") {
				const ok = await ctx.ui.confirm("确认保存到项目配置？", "凭证会写入 .pi/devin-search.json。请确认该目录不会提交到 Git。是否继续？");
				if (!ok) continue;
			}
			const next = { ...stored };
			if (value.trim() === "-") delete next.apiKey;
			else next.apiKey = value.trim();
			writeStoredConfig(scope, ctx.cwd, next);
			ctx.ui.notify(`已保存${scopeName(scope)}配置。${hasEnvCredential() ? "\n注意：环境变量仍拥有最高优先级。" : ""}`, "info");
			continue;
		}
		const value = await ctx.ui.input("设置 state.vscdb 路径", `当前值：${stored.dbPath ?? "auto"}。留空 = 保持不变，输入 '-' = 清除。`);
		if (value === undefined || !value.trim()) continue;
		const next = { ...stored };
		if (value.trim() === "-") delete next.dbPath;
		else next.dbPath = value.trim();
		writeStoredConfig(scope, ctx.cwd, next);
		ctx.ui.notify(`已保存${scopeName(scope)}配置。`, "info");
	}
}

async function clearConfigFlow(ctx: UiContext, args: string): Promise<void> {
	let scope = parseScopeArg(args);
	if (!scope) {
		const choice = await ctx.ui.select("要清除哪一份 devin-search 配置？", ["全局配置", "项目配置", "取消"]);
		if (!choice || choice === "取消") return;
		scope = choice === "全局配置" ? "global" : "project";
	}
	const filePath = getConfigFilePath(scope, ctx.cwd);
	const ok = await ctx.ui.confirm("清除 devin-search 配置？", `删除 ${filePath}？`);
	if (!ok) return;
	deleteStoredConfig(scope, ctx.cwd);
	ctx.ui.notify(`已删除${scopeName(scope)}配置：\n${filePath}`, "info");
}

async function testConnection(ctx: UiContext, args: string): Promise<void> {
	const credential = await resolveConfiguredCredential(ctx.cwd);
	if (!credential.apiKey) {
		ctx.ui.notify(configStatus(ctx.cwd, credential), "warning");
		return;
	}
	const query = args.replace(/^test\b/i, "").trim() || "pi coding agent extension";
	const finishStatus = beginStatus(ctx);
	try {
		const response = await searchDevin(credential.apiKey, query, { limit: 1 });
		finishStatus("devin-search: connection ok");
		ctx.ui.notify(
			`Connection OK via ${response.host}. Returned ${response.results.length} result(s).${response.results[0] ? `\n${response.results[0].title}\n${response.results[0].url}` : ""}`,
			"info",
		);
	} catch (error) {
		finishStatus();
		ctx.ui.notify(`Connection test failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function runConfigWizard(args: string, ctx: UiContext): Promise<void> {
	const trimmed = args.trim();
	const lower = trimmed.toLowerCase();
	if (lower.startsWith("status")) {
		const credential = await resolveConfiguredCredential(ctx.cwd);
		ctx.ui.notify(configStatus(ctx.cwd, credential), credential.apiKey ? "info" : "warning");
		return;
	}
	if (lower.startsWith("test")) {
		await testConnection(ctx, trimmed);
		return;
	}
	if (ctx.hasUI === false) {
		throw new Error("/devin-search-config 需要交互式 UI。非交互模式请使用 status/test，或设置 DEVIN_SEARCH_API_KEY / WINDSURF_API_KEY。");
	}
	if (lower.includes("clear") || lower.includes("delete") || lower.includes("reset")) {
		await clearConfigFlow(ctx, trimmed);
		return;
	}
	if (lower.includes("import") || lower.includes("auto") || lower.includes("key")) {
		await importCredentialFlow(ctx, parseScopeArg(trimmed));
		return;
	}
	const directScope = parseScopeArg(trimmed);
	if (directScope) {
		await editScopeFlow(ctx, directScope);
		return;
	}
	const choice = await ctx.ui.select("devin-search 配置", [
		"自动导入 Devin/Windsurf 凭证（推荐）",
		"编辑全局配置 (~/.pi/agent/devin-search.json)",
		"编辑项目配置 (.pi/devin-search.json)",
		"查看状态",
		"测试连接",
		"清除配置",
		"退出",
	]);
	if (!choice || choice === "退出") return;
	if (choice.startsWith("自动导入")) await importCredentialFlow(ctx);
	else if (choice.startsWith("编辑全局")) await editScopeFlow(ctx, "global");
	else if (choice.startsWith("编辑项目")) await editScopeFlow(ctx, "project");
	else if (choice === "查看状态") {
		const credential = await resolveConfiguredCredential(ctx.cwd);
		ctx.ui.notify(configStatus(ctx.cwd, credential), credential.apiKey ? "info" : "warning");
	} else if (choice === "测试连接") await testConnection(ctx, "test");
	else if (choice === "清除配置") await clearConfigFlow(ctx, "");
}

export default function piDevinSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "devin_search",
		label: "Web Source Search",
		description: "Search the web for a focused query and return up to 10 results with titles, URLs, and available summaries. Use it whenever current external sources or direct source URLs can support the task, including official pages, documentation, repositories, issues, release notes, product pages, and other web resources. Results are source records rather than a synthesized multi-source report.",
		promptSnippet: "Find web sources for a focused query and return titles, URLs, and available summaries.",
		promptGuidelines: [
			"Use devin_search whenever current external sources or direct source URLs can support the task.",
			"Write a focused, self-contained query; set domain when the target website is known.",
			"Treat result summaries as previews and inspect the returned URL before relying on detailed page claims.",
		],
		...{ outputSchema: Type.Object({
			query: Type.String(),
			results: Type.Array(Type.Object({ title: Type.String(), url: Type.String(), summary: Type.String() })),
			summary: Type.Optional(Type.String()),
			webSearchUrl: Type.Optional(Type.String()),
		}) },
		parameters: SEARCH_PARAMS,
		async execute(_toolCallId, params: SearchParams, signal, onUpdate, ctx) {
			const startedAt = Date.now();
			const finishStatus = beginStatus(ctx);
			onUpdate?.({ content: [{ type: "text", text: "Searching through Devin/Windsurf..." }], details: { query: params.query, startedAt } });
			try {
				const { credential, response } = await runSearch(ctx.cwd, params, signal);
				finishStatus(`devin-search: ${response.results.length} result(s)`);
				return {
					content: [{ type: "text", text: formatSearchResponse(params.query, response) }],
					structuredContent: {
						query: params.query,
						results: response.results.map((result) => ({ ...result, summary: shortSummary(result.summary, MAX_RESULT_SUMMARY_CHARS) })),
						...(response.summary ? { summary: shortSummary(response.summary, MAX_UPSTREAM_SUMMARY_CHARS) } : {}),
						...(response.webSearchUrl ? { webSearchUrl: response.webSearchUrl } : {}),
					},
					details: {
						query: params.query,
						resultCount: response.results.length,
						firstTitle: response.results[0]?.title,
						host: response.host,
						credentialSource: credential.source,
						startedAt,
					},
				};
			} catch (error) {
				finishStatus();
				throw error;
			}
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("devin_search"));
			text += ` ${theme.fg("accent", `\"${firstLine(args.query)}\"`)}`;
			if (args.domain) text += ` ${theme.fg("dim", args.domain)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("accent", "Searching Devin/Windsurf..."), 0, 0);
			const details = result.details as SearchDetails | undefined;
			let text = theme.fg("success", `✓ ${details?.resultCount ?? 0} result(s)`);
			if (details?.host) text += ` ${theme.fg("muted", details.host)}`;
			const duration = elapsed(details?.startedAt);
			if (duration) text += ` ${theme.fg("dim", duration)}`;
			if (details?.firstTitle) text += `\n${theme.fg("muted", firstLine(details.firstTitle, 120))}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("devin-search", {
		description: "Search with Devin/Windsurf native web search. Usage: /devin-search <query>",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /devin-search <query>", "warning");
				return;
			}
			const finishStatus = beginStatus(ctx);
			try {
				const { credential, response } = await runSearch(ctx.cwd, { query });
				finishStatus(`devin-search: ${response.results.length} result(s)`);
				pi.sendMessage({
					customType: "devin-search",
					content: formatSearchResponse(query, response),
					display: true,
					details: { resultCount: response.results.length, host: response.host, credentialSource: credential.source },
				});
			} catch (error) {
				finishStatus();
				ctx.ui.notify(`Devin search failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("devin-search-status", {
		description: "Show Devin search credential source and configuration paths",
		handler: async (_args, ctx) => {
			const credential = await resolveConfiguredCredential(ctx.cwd);
			ctx.ui.notify(configStatus(ctx.cwd, credential), credential.apiKey ? "info" : "warning");
		},
	});

	pi.registerCommand("devin-search-config", {
		description: "Configure pi-devin-search interactively. Usage: /devin-search-config [project|global|clear|import|status|test]",
		handler: async (args, ctx) => runConfigWizard(args, ctx as UiContext),
	});

	pi.registerCommand("devin-search-import-key", {
		description: "Import Devin/Windsurf credential from local state.vscdb and persist it after confirmation",
		handler: async (args, ctx) => {
			if ((ctx as UiContext).hasUI === false) throw new Error("/devin-search-import-key 需要交互式 UI。");
			await importCredentialFlow(ctx as UiContext, parseScopeArg(args));
		},
	});

	pi.registerMessageRenderer("devin-search", (message, _options, theme) => {
		const content = typeof message.content === "string"
			? message.content
			: message.content
				.filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
				.map((item) => item.text)
				.join("\n");
		return new Text(theme.fg("muted", content), 0, 0);
	});
}
