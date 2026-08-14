import test from "node:test";
import assert from "node:assert/strict";
import { buildRequestBody, normalizePayload, searchDevin } from "../src/client.ts";

test("buildRequestBody trims the query and clamps limit", () => {
	const body = buildRequestBody(" token ", "  hello world  ", { limit: 99, domain: " github.com " });
	assert.equal(body.query, "hello world");
	assert.equal(body.limit, 10);
	assert.equal(body.domain, "github.com");
	assert.equal((body.metadata as { apiKey: string }).apiKey, "token");
	assert.equal("thirdPartyConfig" in body, false);
});

test("normalizePayload accepts upstream field variants and filters invalid results", () => {
	const payload = normalizePayload({
		results: [
			{ title: "One", url: "https://one.test", summary: " first   result " },
			{ name: "Two", sourceUrl: "https://two.test", text: "second" },
			{ title: "Missing URL" },
		],
		summary: "overall",
		webSearchUrl: "https://search.test/query",
	});
	assert.deepEqual(payload, {
		results: [
			{ title: "One", url: "https://one.test", summary: "first result" },
			{ title: "Two", url: "https://two.test", summary: "second" },
		],
		summary: "overall",
		webSearchUrl: "https://search.test/query",
	});
});

test("searchDevin retries the fallback host", async () => {
	const calls: string[] = [];
	const fetchImpl = async (input: string | URL | Request) => {
		const url = String(input);
		calls.push(url);
		if (url.includes("first.test")) return new Response("boom", { status: 500 });
		return new Response(JSON.stringify({ results: [{ title: "OK", url: "https://ok.test" }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};

	const result = await searchDevin("token", "query", {
		hosts: ["first.test", "second.test"],
		fetchImpl: fetchImpl as typeof fetch,
	});

	assert.equal(result.host, "second.test");
	assert.equal(result.results[0]?.title, "OK");
	assert.equal(calls.length, 2);
});

test("searchDevin reports all host failures", async () => {
	const fetchImpl = async () => new Response("no", { status: 503 });
	await assert.rejects(
		searchDevin("token", "query", {
			hosts: ["a.test", "b.test"],
			fetchImpl: fetchImpl as typeof fetch,
		}),
		/a\.test returned HTTP 503[\s\S]*b\.test returned HTTP 503/,
	);
});
