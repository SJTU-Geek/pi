/**
 * Node-side demo entry for the embedded Node.js runtime
 * (Capawesome capacitor-nodejs plugin, Node 18.20.4).
 *
 * The `bridge` builtin only exists on-device; when absent (local smoke test
 * with plain Node) messages fall back to console.log.
 *
 * pi-ai is bundled in via esbuild (see package.json `build:node`). The faux
 * provider proves the full streaming pipeline without any network access;
 * swap in a real provider factory for actual model calls.
 */
let channel = null;
try {
	channel = require("bridge").channel;
} catch {
	// Not running inside the Capacitor plugin (local smoke test).
}

const post = (eventName, ...args) => {
	if (channel) {
		channel.post(eventName, ...args);
	} else {
		console.log(`[bridge:${eventName}]`, ...args);
	}
};

async function handlePrompt(text) {
	post("log", `prompt received: ${text}`);
	const piAi = require("@earendil-works/pi-ai");
	const faux = piAi.fauxProvider({ tokensPerSecond: 120 });
	const models = piAi.createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		piAi.fauxAssistantMessage([piAi.fauxText(`Echo from embedded ${process.version}: ${text}`)]),
	]);
	try {
		const stream = models.stream(faux.getModel(), {
			messages: [{ role: "user", content: String(text ?? "hi"), timestamp: Date.now() }],
		});
		for await (const event of stream) {
			if (event.type === "text_delta") post("delta", event.delta);
		}
		const result = await stream.result();
		post("done", result.stopReason);
	} catch (error) {
		post("error", String((error && error.message) || error));
	}
}

async function main() {
	if (channel) {
		channel.on("prompt", (text) => {
			handlePrompt(text);
		});
	} else {
		await handlePrompt("local smoke test");
	}
}

main().catch((error) => post("error", String((error && error.message) || error)));
