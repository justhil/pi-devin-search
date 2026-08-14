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

test("devin_search prompt routes quick source discovery away from deep search", () => {
	let tool: ToolDefinition | undefined;
	const pi = {
		registerTool(definition: ToolDefinition) { tool = definition; },
		registerCommand() {},
		registerMessageRenderer() {},
	} as unknown as ExtensionAPI;

	extension(pi);
	assert.ok(tool);
	assert.equal(tool.name, "devin_search");
	assert.equal(tool.label, "Quick Source Search");
	const prompt = [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join("\n");
	assert.match(prompt, /quick lookups/i);
	assert.match(prompt, /precise source discovery/i);
	assert.match(prompt, /Use search instead.*synthesized answer/i);
	assert.match(prompt, /Use docs_search instead/i);
	assert.match(prompt, /Use web_fetch/i);
	assert.doesNotMatch(prompt, /Grok|chat-completions|GetWebSearchResults|OpenAI-compatible/i);
});
