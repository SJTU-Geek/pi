/**
 * Mobile demo entry: an in-process coding-agent session for the embedded
 * Node.js runtime (Capawesome capacitor-nodejs, Node 18.20.4).
 *
 * Mirrors examples/sdk/03-custom-prompt.ts but self-contained for a phone:
 * - a local OpenAI-compatible SSE mock server replaces the network provider,
 *   scripting one tool-call turn and one text turn so the coding-agent's
 *   full tool loop (stream -> toolCall -> write tool -> toolResult -> text)
 *   runs on-device without any API key;
 * - the session streams text deltas and tool events over the plugin's
 *   event bridge to the WebView (falling back to console.log locally).
 *
 * Built by scripts/build-mobile-demo.mjs (CJS, node18 target, with
 * child_process/worker_threads/clipboard/jiti stubs for the mobile runtime).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "./index.ts";

// "bridge" only exists inside the Capacitor NodeJS plugin; esbuild keeps the
// require external. Local smoke tests fall back to console output.
declare const require: (id: string) => any;

let channel: any = null;
try {
	channel = require("bridge").channel;
} catch {
	// Not running inside the plugin.
}

const post = (eventName: string, ...args: unknown[]): void => {
	if (channel) {
		channel.post(eventName, ...args);
	} else {
		console.log(`[bridge:${eventName}]`, ...args);
	}
};

// Persistent per-app directory (bridge app.datadir()); local smoke tests use
// PI_DEMO_DIR so the demo never writes outside a scratch dir.
let dataDir = process.cwd();
try {
	const bridge = require("bridge");
	dataDir = bridge.app.datadir();
} catch {
	dataDir = process.env.PI_DEMO_DIR ?? process.cwd();
}
mkdirSync(dataDir, { recursive: true });
post("info", `data dir: ${dataDir}`);

// ── Local OpenAI-compatible mock server (scripted tool loop) ────────────────

let requestCount = 0;

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
	req.resume();
	req.on("end", () => {
		requestCount++;
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const send = (payload: unknown) => {
			res.write(`data: ${JSON.stringify(payload)}\n\n`);
		};
		const chunkOf = (delta: Record<string, unknown>, finish: string | null) => ({
			id: "chatcmpl-mobile-demo",
			object: "chat.completion.chunk",
			created: 0,
			model: "pi-mobile-demo",
			choices: [{ index: 0, delta, finish_reason: finish }],
		});

		if (requestCount % 2 === 1) {
			// First turn: ask the agent to write a file via the write tool.
			send(chunkOf({ role: "assistant", content: null }, null));
			send(
				chunkOf(
					{
						tool_calls: [
							{
								index: 0,
								id: "call_demo_write",
								type: "function",
								function: {
									name: "write",
									arguments: JSON.stringify({
										path: "hello-from-pi.txt",
										content:
											"This file was written by the pi coding-agent running inside embedded Node.js.\n",
									}),
								},
							},
						],
					},
					null,
				),
			);
			send(chunkOf({}, "tool_calls"));
		} else {
			// Second turn: confirm the tool result in text.
			for (const word of ["Write", " tool", " executed", " — hello-from-pi.txt", " is on disk."]) {
				send(chunkOf({ role: "assistant", content: word }, null));
			}
			send(chunkOf({}, "stop"));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
	req.on("error", () => res.end());
});

const portPromise = new Promise<number>((resolve) => {
	server.listen(0, "127.0.0.1", () => {
		resolve((server.address() as { port: number }).port);
	});
});

// ── Agent session (03-custom-prompt.ts style) ───────────────────────────────

let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

let lastText = "";

async function main(): Promise<void> {
	const port = await portPromise;

	const agentDir = join(dataDir, ".pi-agent");
	mkdirSync(agentDir, { recursive: true });
	// Custom provider in models.json (the standard pi customization point):
	// inline apiKey so the model runtime resolves auth without user setup.
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				mock: {
					name: "pi mobile demo (local mock)",
					baseUrl: `http://127.0.0.1:${port}/v1`,
					apiKey: "mock-key",
					api: "openai-completions",
					models: [
						{
							id: "pi-mobile-demo",
							name: "pi mobile demo (local mock)",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 32000,
						},
					],
				},
			},
		}),
	);

	const model: Model<"openai-completions"> = {
		id: "pi-mobile-demo",
		name: "pi mobile demo (local mock)",
		api: "openai-completions",
		provider: "mock",
		baseUrl: `http://127.0.0.1:${port}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32000,
	};

	const loader = new DefaultResourceLoader({
		cwd: dataDir,
		agentDir,
		systemPromptOverride: () => "You are pi, a coding agent running inside embedded Node.js on a phone. Be concise.",
		// Avoid DefaultResourceLoader appending APPEND_SYSTEM.md from the agent dir.
		appendSystemPromptOverride: () => [],
	});
	await loader.reload();

	const created = await createAgentSession({
		model,
		agentDir,
		cwd: dataDir,
		tools: ["read", "write"],
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(),
	});
	session = created.session;
	sessionSubscribe();

	if (channel) {
		channel.on("prompt", (text: string) => {
			handlePrompt(text).then(selfCheck);
		});
		post("ready", `embedded ${process.version}, mock server on 127.0.0.1:${port}`);
	} else {
		// Local smoke: run one scripted loop, verify, exit.
		post("info", `local smoke on ${process.version}, mock server on 127.0.0.1:${port}`);
		await handlePrompt("Create the demo file, then tell me it worked.");
		await selfCheck();
		server.close();
		setTimeout(() => process.exit(0), 100);
	}
}

main().catch((error) => post("error", String((error as Error)?.message ?? error)));

function sessionSubscribe(): void {
	session?.subscribe((event: any) => {
		if (event.type === "message_update") {
			const inner = event.assistantMessageEvent;
			if (inner?.type === "text_delta") {
				lastText += inner.delta;
				post("delta", inner.delta);
			}
		} else if (event.type === "tool_execution_start") {
			lastText = "";
			post("tool_start", JSON.stringify(event).slice(0, 300));
		} else if (event.type === "tool_execution_end") {
			post("tool_end", JSON.stringify(event).slice(0, 300));
		}
	});
}

let running = false;
async function handlePrompt(text: string): Promise<void> {
	if (running) {
		post("error", "prompt already running");
		return;
	}
	running = true;
	lastText = "";
	try {
		await session.prompt(String(text ?? "hi"));
		post("done", lastText);
	} catch (error) {
		post("error", String((error as Error)?.message ?? error));
	} finally {
		running = false;
	}
}

// Verify the write tool really touched the filesystem after the scripted turn.
async function selfCheck(): Promise<void> {
	try {
		const content = readFileSync(join(dataDir, "hello-from-pi.txt"), "utf8");
		post("verify", `hello-from-pi.txt exists (${content.length} bytes)`);
	} catch {
		post("verify", "hello-from-pi.txt NOT found");
	}
}
