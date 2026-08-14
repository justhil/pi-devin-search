const WEB_SEARCH_PATH = "/exa.api_server_pb.ApiServerService/GetWebSearchResults";
const DEFAULT_HOSTS = ["server.codeium.com", "server.self-serve.windsurf.com"];
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const MAX_SUMMARY_CHARS = 8_000;

export type DevinSearchResult = {
	title: string;
	url: string;
	summary: string;
};

export type DevinSearchResponse = {
	results: DevinSearchResult[];
	summary?: string;
	webSearchUrl?: string;
	host: string;
};

export type DevinSearchOptions = {
	limit?: number;
	domain?: string;
	timeoutMs?: number;
	hosts?: string[];
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
};

type SearchPayload = {
	results?: unknown;
	summary?: unknown;
	webSearchUrl?: unknown;
};

function firstString(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function normalizeSummary(value: unknown): string {
	const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
	return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}…` : text;
}

export function buildRequestBody(apiKey: string, query: string, options: Pick<DevinSearchOptions, "limit" | "domain"> = {}) {
	const normalizedQuery = query.trim();
	if (!normalizedQuery) throw new Error("devin_search query cannot be empty");
	if (!apiKey.trim()) throw new Error("Devin credential cannot be empty");

	const requestedLimit = Number.isFinite(options.limit) ? Math.trunc(options.limit ?? DEFAULT_LIMIT) : DEFAULT_LIMIT;
	const body: Record<string, unknown> = {
		metadata: {
			apiKey: apiKey.trim(),
			ideName: "windsurf",
			ideVersion: "1.9600.41",
			extensionName: "windsurf",
			extensionVersion: "1.9600.41",
			locale: "en",
		},
		query: normalizedQuery,
		limit: Math.max(1, Math.min(MAX_LIMIT, requestedLimit)),
	};

	const domain = options.domain?.trim();
	if (domain) body.domain = domain;
	return body;
}

export function normalizeResult(raw: unknown): DevinSearchResult | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	const title = firstString(record.title, record.name, record.webTitle);
	const url = firstString(record.url, record.sourceUrl, record.webUrl, record.link);
	if (!title || !url) return undefined;
	return {
		title,
		url,
		summary: normalizeSummary(firstString(record.summary, record.snippet, record.text, record.content)),
	};
}

export function normalizePayload(payload: unknown): Omit<DevinSearchResponse, "host"> {
	const record = payload && typeof payload === "object" ? payload as SearchPayload : {};
	const rawResults = Array.isArray(record.results) ? record.results : [];
	const results = rawResults.map(normalizeResult).filter((item): item is DevinSearchResult => Boolean(item));
	const summary = normalizeSummary(record.summary);
	const webSearchUrl = firstString(record.webSearchUrl);
	return {
		results,
		...(summary ? { summary } : {}),
		...(webSearchUrl ? { webSearchUrl } : {}),
	};
}

function abortError(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason;
	const error = new Error("Devin search aborted");
	error.name = "AbortError";
	return error;
}

async function postSearch(
	host: string,
	body: Record<string, unknown>,
	fetchImpl: typeof fetch,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<unknown> {
	if (signal?.aborted) throw abortError(signal);

	const controller = new AbortController();
	let timedOut = false;
	const abort = () => controller.abort(signal?.reason);
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	signal?.addEventListener("abort", abort, { once: true });

	try {
		const response = await fetchImpl(`https://${host}${WEB_SEARCH_PATH}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Connect-Protocol-Version": "1",
				Accept: "application/json",
				"User-Agent": "windsurf/1.9600.41",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (response.status >= 400) {
			await response.body?.cancel();
			throw new Error(`${host} returned HTTP ${response.status}`);
		}
		return await response.json();
	} catch (error) {
		if (signal?.aborted) throw abortError(signal);
		if (timedOut) throw new Error(`${host} timed out after ${timeoutMs}ms`);
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

export async function searchDevin(apiKey: string, query: string, options: DevinSearchOptions = {}): Promise<DevinSearchResponse> {
	const body = buildRequestBody(apiKey, query, options);
	const hosts = options.hosts?.length ? options.hosts : DEFAULT_HOSTS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? fetch;
	const failures: string[] = [];

	for (const host of hosts) {
		try {
			const payload = await postSearch(host, body, fetchImpl, timeoutMs, options.signal);
			return { ...normalizePayload(payload), host };
		} catch (error) {
			if (options.signal?.aborted) throw error;
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}

	throw new Error(`Devin search failed on all hosts:\n- ${failures.join("\n- ")}`);
}
