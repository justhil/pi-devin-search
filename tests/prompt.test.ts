import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

type ToolDefinition = {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
};

test("devin_search independently describes broad web source discovery", () => {
	let tool: ToolDefinition | undefined;
	const pi = {
		registerTool(definition: ToolDefinition) { tool = definition; },
		registerCommand() {},
		registerMessageRenderer() {},
	} as unknown as ExtensionAPI;

	extension(pi);
	assert.ok(tool);
	assert.equal(tool.name, "devin_search");
	assert.equal(tool.label, "Web Source Search");
	const prompt = [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join("\n");
	assert.match(prompt, /whenever current external sources or direct source URLs can support the task/i);
	assert.match(prompt, /official pages, documentation, repositories, issues, release notes, product pages/i);
	assert.match(prompt, /source records rather than a synthesized multi-source report/i);
	assert.match(prompt, /focused, self-contained query/i);
	assert.match(prompt, /summaries as previews/i);
	assert.doesNotMatch(prompt, /\b(?:search|docs_search|web_fetch|gr0k_web_search)\b/);
	assert.doesNotMatch(prompt, /\b(?:quick|quickly|fast|faster|cheap|cost|free|seconds?|latency)\b/i);
	assert.doesNotMatch(prompt, /Grok|chat-completions|GetWebSearchResults|OpenAI-compatible/i);
});
