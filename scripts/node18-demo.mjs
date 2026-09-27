#!/usr/bin/env node
/**
 * Node 18 compatibility demo (feat-mobile branch).
 *
 * Exercises the layers that must work on embedded/mobile Node runtimes
 * (nodejs-mobile / Capawesome Capacitor NodeJS plugin currently ship Node 18.20):
 *
 *   1. @earendil-works/pi-ai loads and the AbortSignal.any polyfill is active
 *   2. Full stream pipeline via the in-memory faux provider (no network)
 *   3. Real fetch + SSE streaming against a local OpenAI-compatible mock server
 *   4. The coding-agent RPC bundle boots under this Node version and answers commands
 *
 * Usage:
 *   node scripts/node18-demo.mjs
 *   # explicitly against a locally installed Node 18:
 *   ~/.local/jaide-node/node-v18.20.8-darwin-arm64/bin/node scripts/node18-demo.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const bundleCli = join(scriptDir, "..", "packages", "coding-agent", "dist", "bundle", "cli.js");

console.log(`node18-demo: Node ${process.version} (${process.platform}-${process.arch})`);

// ── 1. pi-ai loads on this runtime ──────────────────────────────────────────
const piAi = await import("@earendil-works/pi-ai");
if (typeof AbortSignal.any !== "function") {
	throw new Error("AbortSignal.any missing — polyfill not applied");
}
console.log(`[1] pi-ai loaded; AbortSignal.any available: ${typeof AbortSignal.any === "function"}`);

// ── 2. faux provider stream (in-memory, no network) ─────────────────────────
const faux = piAi.fauxProvider({ tokensPerSecond: 500 });
const models = piAi.createModels();
models.setProvider(faux.provider);
const fauxModel = faux.getModel();
const fauxContext = {
	messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
};
faux.setResponses([
	piAi.fauxAssistantMessage([piAi.fauxText(`Hello from faux provider on ${process.version}`)]),
]);
const fauxStream = models.stream(fauxModel, fauxContext);
let fauxTextOut = "";
for await (const event of fauxStream) {
	if (event.type === "text_delta") fauxTextOut += event.delta;
}
const fauxResult = await fauxStream.result();
console.log(`[2] faux stream ok: "${fauxTextOut}" (stopReason: ${fauxResult.stopReason})`);

// ── 3. real fetch + SSE against a local OpenAI-compatible mock ──────────────
const received = { authorization: "<none>" };
const server = createServer((req, res) => {
	received.authorization = req.headers.authorization ?? "<none>";
	let body = "";
	req.on("data", (chunk) => {
		body += chunk;
	});
	req.on("end", () => {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		const chunks = ["Hello", " from", " the", " mock", " server"];
		let i = 0;
		const sendChunk = (payload) => {
			res.write(`data: ${JSON.stringify(payload)}\n\n`);
		};
		const timer = setInterval(() => {
			if (i < chunks.length) {
				sendChunk({
					id: "chatcmpl-demo",
					object: "chat.completion.chunk",
					created: 0,
					model: "mock-18b",
					choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }],
				});
				i++;
				return;
			}
			clearInterval(timer);
			sendChunk({
				id: "chatcmpl-demo",
				object: "chat.completion.chunk",
				created: 0,
				model: "mock-18b",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			});
			res.write("data: [DONE]\n\n");
			res.end();
		}, 10);
		req.on("error", () => {
			clearInterval(timer);
			res.end();
		});
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const { openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy");
const mockProvider = piAi.createProvider({
	id: "mock",
	name: "Mock",
	baseUrl: `http://127.0.0.1:${port}/v1`,
	auth: { apiKey: { name: "Mock", resolve: async () => ({ auth: {} }) } },
	models: [
		{
			id: "mock-18b",
			name: "Mock 18B (local)",
			api: "openai-completions",
			provider: "mock",
			baseUrl: `http://127.0.0.1:${port}/v1`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 32000,
		},
	],
	api: openAICompletionsApi(),
});
models.setProvider(mockProvider);
const mockModel = models.getModel("mock", "mock-18b");
const mockContext = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
const mockStream = models.stream(mockModel, mockContext, { apiKey: "mock-key" });
let mockText = "";
for await (const event of mockStream) {
	if (event.type === "text_delta") mockText += event.delta;
	if (event.type === "error") console.log("[3] stream error event:", JSON.stringify(event.error).slice(0, 400));
}
const mockResult = await mockStream.result();
console.log(`[3] mock HTTP stream ok: "${mockText}" (stopReason: ${mockResult.stopReason})`);
server.close();

// ── 4. coding-agent RPC bundle boots and answers commands ───────────────────
const scratch = mkdtempSync(join(tmpdir(), "pi-node18-demo-"));
const child = spawn(process.execPath, [bundleCli, "--mode", "rpc"], {
	cwd: scratch,
	env: { ...process.env, HOME: scratch },
	stdio: ["pipe", "pipe", "pipe"],
});
let rpcBuffer = "";
const stderrTail = [];
const pending = new Map();
let rpcExit = null;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	rpcBuffer += chunk;
	let index;
	while ((index = rpcBuffer.indexOf("\n")) !== -1) {
		const line = rpcBuffer.slice(0, index).trim();
		rpcBuffer = rpcBuffer.slice(index + 1);
		if (!line) continue;
		let frame;
		try {
			frame = JSON.parse(line);
		} catch {
			continue;
		}
		if (frame?.type === "response" && pending.has(frame.id)) {
			pending.get(frame.id)(frame);
			pending.delete(frame.id);
		}
	}
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
	stderrTail.push(chunk);
	if (stderrTail.length > 20) stderrTail.shift();
});
child.on("exit", (code) => {
	rpcExit = code;
});

function rpcRequest(frame, timeoutMs = 30_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(frame.id);
			reject(new Error(`RPC timeout waiting for ${frame.type}`));
		}, timeoutMs);
		pending.set(frame.id, (response) => {
			clearTimeout(timer);
			resolve(response);
		});
		child.stdin.write(`${JSON.stringify(frame)}\n`);
	});
}

try {
	await new Promise((resolve, reject) => {
		const bootTimer = setTimeout(() => reject(new Error("RPC process did not stay alive")), 15_000);
		child.on("spawn", () => {
			clearTimeout(bootTimer);
			resolve();
		});
		child.on("exit", (code) => reject(new Error(`RPC process exited early (code ${code})`)));
	});
	const stateResponse = await rpcRequest({ id: "1", type: "get_state" });
	console.log(`[4] RPC get_state ok (success: ${stateResponse.success})`);
	const modelsResponse = await rpcRequest({ id: "2", type: "get_available_models" });
	const modelCount = Array.isArray(modelsResponse.data) ? modelsResponse.data.length : JSON.stringify(modelsResponse.data)?.slice(0, 120);
	console.log(`[4] RPC get_available_models ok (success: ${modelsResponse.success}, models: ${modelCount})`);
} finally {
	if (rpcExit === null) child.kill("SIGTERM");
	await new Promise((resolve) => setTimeout(resolve, 200));
	rmSync(scratch, { recursive: true, force: true });
}
if (stderrTail.length > 0) {
	console.log(`[4] RPC stderr tail: ${stderrTail.join("").trim().split("\n").slice(-3).join(" | ")}`);
}

console.log(`node18-demo: ALL OK on ${process.version}`);
