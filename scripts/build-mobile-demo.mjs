#!/usr/bin/env node
/**
 * Bundle the coding-agent mobile demo entry for the embedded Node.js runtime
 * (nodejs-mobile / Capawesome capacitor-nodejs, Node 18.20.4).
 *
 * Output: examples/mobile-demo/www/nodejs/pi-bundle.js (CJS, node18 target).
 *
 * The mobile runtime has no child_process (process spawning is blocked by the
 * OS) and no practical worker/clipboard/jiti usage in this demo, so those
 * modules are replaced with throwing stubs. Run from the repository root:
 *
 *   node scripts/build-mobile-demo.mjs
 */
import { build } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const entry = join(repoRoot, "packages", "coding-agent", "src", "mobile-demo-entry.ts");
const outDir = join(repoRoot, "examples", "mobile-demo", "www", "nodejs");

const throwingStub = (extra = "") => `
const notAvailable = (name) => () => {
	throw new Error(\`pi mobile demo: \${name} is not available on the embedded mobile runtime\`);
};
${extra}
`;

const stubSources = {
	"child_process-stub": throwingStub(`
export const spawn = notAvailable("child_process.spawn");
export const spawnSync = notAvailable("child_process.spawnSync");
export const exec = notAvailable("child_process.exec");
export const execSync = notAvailable("child_process.execSync");
export const execFile = notAvailable("child_process.execFile");
export const execFileSync = notAvailable("child_process.execFileSync");
export const fork = notAvailable("child_process.fork");
export const defaultMaxBuffer = 1024 * 1024;
export const ChildProcess = class {};
`),
	"worker-threads-stub": throwingStub(`
export const Worker = notAvailable("worker_threads.Worker");
export const parentPort = null;
export const isMainThread = true;
export const threadId = 0;
export const workerData = null;
`),
	"clipboard-stub": `
export async function copyToClipboard() {
	throw new Error("pi mobile demo: clipboard is not available on the embedded mobile runtime");
}
`,
	"jiti-stub": `
export function createJiti() {
	throw new Error("pi mobile demo: jiti/TS extensions are not available on the embedded mobile runtime");
}
export default { createJiti };
`,
};

const stubsPlugin = {
	name: "mobile-stubs",
	setup(build) {
		build.onResolve({ filter: /^(node:)?child_process$/ }, () => ({ path: "child_process-stub", namespace: "stub" }));
		build.onResolve({ filter: /^node:worker_threads$/ }, () => ({ path: "worker-threads-stub", namespace: "stub" }));
		build.onResolve({ filter: /^@mariozechner\/clipboard$/ }, () => ({ path: "clipboard-stub", namespace: "stub" }));
		build.onResolve({ filter: /^(jiti|jiti\/static)$/ }, () => ({ path: "jiti-stub", namespace: "stub" }));
		build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
			contents: stubSources[args.path],
			loader: "js",
		}));
		// The embedded nodejs-mobile V8 build compiles every regex in the CJS
		// bundle eagerly and has unicode property escapes (\p{...}) disabled
		// entirely (no Intl/PropList tables), so no \p property may appear in
		// the output — and regex literals compile even in dead code branches.
		// Rewrite every property escape to explicit ranges/sets, chosen by
		// whether the escape sits inside a character class. The substitutions
		// are ASCII/Unicode-range approximations: affected checks are width and
		// identifier classification, not security.
		const PROP_REPLACEMENTS = {
			L: "A-Za-z",
			Alphabetic: "A-Za-z",
			Ll: "a-z",
			Lu: "A-Z",
			N: "0-9",
			Nd: "0-9",
			Nl: "0-9",
			P: "!-/:-@\\[-`{-~",
			Pc: "_",
			S: "$+<=>^`|~",
			M: "\\u0300-\\u036F",
			Mark: "\\u0300-\\u036F",
			Mn: "\\u0300-\\u036F",
			Mc: "\\u0903",
			Me: "\\u0489",
			Spacing_Mark: "\\u0903",
			C: "\\u0000-\\u001F\\u007F",
			Cc: "\\u0000-\\u001F\\u007F",
			Control: "\\u0000-\\u001F\\u007F",
			Cf: "\\u00AD\\u200B-\\u200F\\u2060\\uFEFF",
			Format: "\\u00AD\\u200B-\\u200F\\u2060\\uFEFF",
			Default_Ignorable_Code_Point: "\\u00AD\\u200B-\\u200F\\u2060\\uFEFF",
			Cs: "\\u0000",
			Surrogate: "\\u0000",
			Z: "\\u0020\\u00A0\\u3000",
			Zs: "\\u0020\\u00A0\\u3000",
			ID_Start: "A-Za-z",
			ID_Continue: "A-Za-z0-9$",
			Extended_Pictographic: "\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}",
			RGI_Emoji: "\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}",
			"Script=Han": "\\u4E00-\\u9FFF\\u3400-\\u4DBF",
			"Script_Extensions=Han": "\\u4E00-\\u9FFF\\u3400-\\u4DBF",
			"Script=Greek": "\\u0370-\\u03FF\\u1F00-\\u1FFF",
			"Script=Hebrew": "\\u0590-\\u05FF\\uFB1D-\\uFB4F",
			"Script=Hiragana": "\\u3041-\\u309F",
			"Script_Extensions=Hiragana": "\\u3041-\\u309F\\u30A0-\\u30FF",
			"Script=Katakana": "\\u30A0-\\u30FF\\u31F0-\\u31FF",
			"Script_Extensions=Katakana": "\\u30A0-\\u30FF\\u31F0-\\u31FF",
			"Script_Extensions=Hangul": "\\uAC00-\\uD7AF\\u1100-\\u11FF\\u3130-\\u318F",
			"Script_Extensions=Bopomofo": "\\u3105-\\u312F\\u31A0-\\u31BF",
		};
		function rewriteUnicodePropertyEscapes(source) {
			if (!source.includes("p{")) return source;
			let out = "";
			let inClass = false;
			let escaped = false;
			for (let i = 0; i < source.length; i++) {
				const ch = source[i];
				if (escaped) {
					out += ch;
					escaped = false;
					continue;
				}
				if (ch === "\\") {
					// String form: "\\p{X}" inside a regex pattern string. Keep the
					// double-backslash escaping (replacement backslashes doubled).
					if (source[i + 1] === "\\" && source[i + 2] === "p" && source[i + 3] === "{") {
						const end = source.indexOf("}", i + 4);
						if (end !== -1) {
							const name = source.slice(i + 4, end);
							const replacement = PROP_REPLACEMENTS[name];
							if (replacement !== undefined) {
								// Inside a string literal the replacement needs escaped
								// backslashes so the regex engine sees \uXXXX.
								const body = replacement.replace(/\\/g, "\\\\");
								out += inClass ? body : `[${body}]`;
								i = end;
								continue;
							}
						}
					}
					// Literal form: /\p{X}/.
					if (source[i + 1] === "p" && source[i + 2] === "{") {
						const end = source.indexOf("}", i + 3);
						if (end !== -1) {
							const name = source.slice(i + 3, end);
							const replacement = PROP_REPLACEMENTS[name];
							if (replacement !== undefined) {
								out += inClass ? replacement : `[${replacement}]`;
								i = end;
								continue;
							}
						}
					}
					out += ch;
					escaped = true;
					continue;
				}
				if (inClass) {
					if (ch === "]") inClass = false;
				} else if (ch === "[") {
					inClass = true;
				}
				out += ch;
			}
			return out;
		}
		build.onLoad({ filter: /\.(js|ts|mjs|mts)$/ }, async (args) => {
			if (args.namespace !== "file") return undefined;
			const raw = await import("node:fs").then((fs) => fs.promises.readFile(args.path, "utf8"));
			let contents = raw;
			// Dependencies construct Intl.Segmenter at module top level, which
			// crashes on Intl-less builds (nodejs-mobile). Route every
			// construction through a banner-defined lazy shim with a fallback.
			if (contents.includes("new Intl.Segmenter(")) {
				contents = contents.replaceAll(
					"new Intl.Segmenter(",
					"new (__piIntlSegmenter ??= (typeof Intl !== \"undefined\" && typeof Intl.Segmenter === \"function\" ? Intl.Segmenter : function (_locale, _opts) { return { segment(text) { let __i = 0; return Array.from(String(text)).map((segment) => { const d = { segment, index: __i }; __i += segment.length; return d; }); } }; }))(",
				);
			}
			const patched = rewriteUnicodePropertyEscapes(contents);
			if (patched === raw) return undefined;
			const loader = /\.mts?$|\.ts$/.test(args.path) ? "ts" : "js";
			return { contents: patched, loader };
		});
	},
};

mkdirSync(outDir, { recursive: true });
const result = await build({
	entryPoints: [entry],
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node18",
	outfile: join(outDir, "pi-bundle.js"),
	external: ["bridge"],
	plugins: [stubsPlugin],
	banner: { js: "var __piIntlSegmenter;" },
	// esbuild's CJS import.meta shim is an empty object; several pi modules
	// read import.meta.url at module top level. Provide a stable synthetic URL.
	define: {
		"import.meta.url": JSON.stringify("file:///pi-mobile-demo/pi-bundle.js"),
		// Fold pi-tui's RegExp v-flag branch out (device V8 has no v flag and
		// compiles regex literals eagerly, even in dead code).
		PI_MOBILE_REGEXP_BASELINE: "true",
	},
	minify: false,
	sourcemap: false,
	logLevel: "info",
});

if (result.errors.length > 0) {
	process.exit(1);
}

writeFileSync(
	join(outDir, "package.json"),
	JSON.stringify({ name: "pi-mobile-demo-node", private: true, main: "pi-bundle.js" }, null, "\t") + "\n",
);
console.log("mobile demo bundle written to examples/mobile-demo/www/nodejs/pi-bundle.js");
