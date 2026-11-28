#!/usr/bin/env node
/**
 * The README's screenshots, taken from the web app's mock (no server, no account, mock data only).
 *
 *   node scripts/readme-shots.mjs                         # every shot, into docs/screenshots/
 *   node scripts/readme-shots.mjs --out /tmp/shots        # somewhere else
 *   node scripts/readme-shots.mjs --only session,diff     # some of them
 *   node scripts/readme-shots.mjs --url http://127.0.0.1:5173   # a mock already running (VITE_WLP_MOCK=1)
 *   node scripts/readme-shots.mjs --theme light --chrome /path/to/chrome
 *
 * Without --url it starts the web app's Vite server in mock mode on a free loopback port and stops it at
 * the end. It drives Chrome or Chromium over the DevTools protocol, with no dependency: --chrome, then
 * $CHROME_PATH, then the usual install paths and Playwright's cache. Shots are taken at device scale 2,
 * and pngquant and oxipng compress them when they are installed. Set CHROME_NO_SANDBOX=1 where Chrome
 * cannot start its sandbox (some containers and CI hosts). Each shot names the screen it shows and
 * waits for it; when a screen changes, a step that no longer finds what it waits for fails by name.
 */
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844, mobile: true };

/** The mock's ChatGPT user (web/src/api/mock.ts): seeded agents, work items and a GitHub connection. */
const MOCK_AUTH = {
	token: "mock:user:u_ada:ada@example.com",
	profile: { uid: "u_ada", email: "ada@example.com", demo: false },
};

// Helpers that run in the page. `text(s)`: the page shows s. `button(name)`: a button by its label.
const PAGE_HELPERS = `
	window.__shot = {
		text: (s) => document.body.innerText.includes(s),
		button: (name) => [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent.trim()) === name || b.textContent.trim() === name),
		scrollAllToTop: () => { for (const el of document.querySelectorAll("*")) if (el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTop = 0; window.scrollTo(0, 0); },
		settle: (ms = 400) => new Promise((ok) => setTimeout(ok, ms)),
		hide: (el) => el?.style.setProperty("visibility", "hidden"),
		/** An element's box, cut off below its last line of text (a dialog taller than what it holds). */
		boxToText: (selector, below = 28) => {
			const el = document.querySelector(selector);
			if (!el) return null;
			const r = el.getBoundingClientRect();
			let bottom = r.top;
			for (const leaf of el.querySelectorAll("*")) if (leaf.childElementCount === 0 && leaf.textContent.trim()) bottom = Math.max(bottom, leaf.getBoundingClientRect().bottom);
			return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, bottom - r.top + below) };
		},
	};`;

/**
 * Each shot: the screen, what shows it is ready, what to do before the capture (`before`, then `after` to
 * wait for), and `clip`, an expression for the box to keep (the whole viewport otherwise).
 */
const SHOTS = [
	{
		name: "home",
		alt: "Home: the composer and the agents that need you",
		path: "/",
		viewport: DESKTOP,
		ready: `__shot.text("Needs you") && !!document.querySelector("textarea")`,
	},
	{
		name: "session",
		alt: "A session: the agent's tool calls on the timeline, its answer, and the session panel",
		path: "/agents/add-test",
		viewport: DESKTOP,
		ready: `__shot.text("Fixing it.") && __shot.text("Changes") && !__shot.text("Reading the workspace")`,
		// From the first prompt; the "Jump to latest" button that scrolling up shows would cover a line.
		before: `(async () => { __shot.scrollAllToTop(); await __shot.settle(); __shot.hide(__shot.button("Jump to latest")); })()`,
	},
	{
		name: "question",
		alt: "The agent asks before a command gets network access",
		path: "/agents/headers",
		viewport: DESKTOP,
		ready: `__shot.text("Allow network access for this command?")`,
		before: `document.activeElement?.blur()`,
	},
	{
		name: "diff",
		alt: "The changes an agent made, before they are published",
		path: "/agents/add-test",
		viewport: DESKTOP,
		ready: `!!__shot.button("View the diff")`,
		before: `__shot.button("View the diff").click()`,
		after: `!!document.querySelector("dialog[open]") && __shot.text("src/add.ts")`,
		clip: `__shot.boxToText("dialog[open]")`,
	},
	{
		name: "factory",
		alt: "The Factory: work items, what each one needs, and the hosted slots in use",
		path: "/factory",
		viewport: DESKTOP,
		ready: `__shot.text("Migrate the docs search to the new index") && __shot.text("slots busy")`,
	},
	{
		name: "phone",
		alt: "Home on a phone",
		path: "/",
		viewport: PHONE,
		ready: `__shot.text("Needs you") && !!document.querySelector("textarea")`,
	},
];

function options() {
	const { values } = parseArgs({
		options: {
			out: { type: "string", default: join(root, "docs/screenshots") },
			only: { type: "string" },
			url: { type: "string" },
			chrome: { type: "string" },
			theme: { type: "string", default: "dark" },
			help: { type: "boolean" },
		},
	});
	if (values.help) {
		console.log(
			readFileSync(fileURLToPath(import.meta.url), "utf8")
				.match(/\/\*\*([\s\S]*?)\*\//)[1]
				.replace(/^\s*\* ?/gm, ""),
		);
		process.exit(0);
	}
	if (values.theme !== "dark" && values.theme !== "light") throw new Error("--theme needs dark or light");
	const names = values.only
		?.split(",")
		.map(s => s.trim())
		.filter(Boolean);
	for (const name of names ?? [])
		if (!SHOTS.some(s => s.name === name))
			throw new Error(`no shot named ${name}; there are ${SHOTS.map(s => s.name).join(", ")}`);
	return { ...values, out: resolve(values.out), shots: names ? SHOTS.filter(s => names.includes(s.name)) : SHOTS };
}

function findChrome(given) {
	const candidates = [given, process.env.CHROME_PATH];
	for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
		const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
		if (found) candidates.push(found);
	}
	candidates.push(
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	);
	const cache = join(
		homedir(),
		process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright",
	);
	if (existsSync(cache)) {
		for (const dir of readdirSync(cache)
			.filter(d => d.startsWith("chromium"))
			.sort()
			.reverse()) {
			for (const sub of [
				"chrome-linux/chrome",
				"chrome-linux64/chrome",
				"chrome-linux/headless_shell",
				"chrome-headless-shell-linux64/chrome-headless-shell",
			])
				candidates.push(join(cache, dir, sub));
		}
	}
	const chrome = candidates.find(c => c && existsSync(c));
	if (!chrome) throw new Error("no Chrome or Chromium found: pass --chrome <path> or set CHROME_PATH");
	return chrome;
}

async function freePort() {
	const server = createServer();
	await new Promise(ok => server.listen(0, "127.0.0.1", ok));
	const { port } = server.address();
	await new Promise(ok => server.close(ok));
	return port;
}

async function until(what, check, ms) {
	const end = Date.now() + ms;
	for (;;) {
		const value = await check().catch(() => undefined);
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await delay(200);
	}
}

/** The web app's Vite server in mock mode; resolves to its origin and a stop function. */
async function startMock() {
	const port = await freePort();
	const vite = join(root, "web/node_modules/.bin/vite");
	if (!existsSync(vite)) throw new Error("web/node_modules is missing: run pnpm install first");
	const child = spawn(vite, ["--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
		cwd: join(root, "web"),
		env: { ...process.env, VITE_WLP_MOCK: "1" },
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let log = "";
	child.stdout.on("data", d => (log += d));
	child.stderr.on("data", d => (log += d));
	const stop = () => {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {}
	};
	const origin = `http://127.0.0.1:${port}`;
	try {
		await until("the mock server", async () => child.exitCode === null && (await fetch(origin)).ok, 60_000);
	} catch (error) {
		stop();
		throw new Error(`${error.message}\n${log}`);
	}
	return { origin, stop };
}

/** Chrome with a DevTools connection to its first page. */
async function startChrome(path) {
	const profile = mkdtempSync(join(tmpdir(), "readme-shots-"));
	const child = spawn(
		path,
		[
			"--headless=new",
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--hide-scrollbars",
			"--force-color-profile=srgb",
			"--font-render-hinting=none",
			// A mouse, not a touch screen: headless shells otherwise report (hover: none).
			"--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
			...(process.getuid?.() === 0 || process.env.CHROME_NO_SANDBOX ? ["--no-sandbox"] : []),
			"about:blank",
		],
		{ stdio: "ignore" },
	);
	const stop = () => {
		child.kill("SIGTERM");
		rmSync(profile, { recursive: true, force: true });
	};
	try {
		const port = await until(
			"Chrome's DevTools port",
			async () => readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0],
			30_000,
		);
		const pages = await until(
			"Chrome's first page",
			async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === "page"),
			10_000,
		);
		const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
		await new Promise(
			(ok, fail) => ((ws.onopen = ok), (ws.onerror = () => fail(new Error("could not connect to Chrome")))),
		);
		let next = 0;
		const waiting = new Map();
		const listeners = new Set();
		ws.onmessage = ({ data }) => {
			const message = JSON.parse(data);
			if (message.id !== undefined) {
				const { ok, fail } = waiting.get(message.id);
				waiting.delete(message.id);
				if (message.error) fail(new Error(message.error.message));
				else ok(message.result);
			} else for (const listen of listeners) listen(message);
		};
		const send = (method, params = {}) =>
			new Promise((ok, fail) => {
				const id = ++next;
				waiting.set(id, { ok, fail });
				ws.send(JSON.stringify({ id, method, params }));
			});
		const once = method =>
			new Promise(ok =>
				listeners.add(function listen(m) {
					if (m.method === method) {
						listeners.delete(listen);
						ok(m.params);
					}
				}),
			);
		return { send, once, stop: () => (ws.close(), stop()) };
	} catch (error) {
		stop();
		throw error;
	}
}

async function evaluate(send, expression) {
	const { result, exceptionDetails } = await send("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
	});
	if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
	return result.value;
}

async function capture({ send, once }, origin, shot) {
	const { width, height, mobile = false } = shot.viewport;
	await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile });
	const loaded = once("Page.loadEventFired");
	await send("Page.navigate", { url: origin + shot.path });
	await loaded;
	const step = async (what, expression, ms = 30_000) => {
		try {
			await until(what, () => evaluate(send, expression), ms);
		} catch (error) {
			throw new Error(`${shot.name}: ${error.message} (${expression})`);
		}
	};
	await step("the screen to be ready", shot.ready);
	if (shot.before) await evaluate(send, shot.before);
	if (shot.after) await step("the screen after its step", shot.after, 10_000);
	// Fonts, a frame for the last layout, and transitions that have settled.
	await evaluate(send, `document.fonts.ready.then(() => new Promise((ok) => setTimeout(ok, 600)))`);
	let clip;
	if (shot.clip) {
		const box = await evaluate(send, shot.clip);
		if (!box) throw new Error(`${shot.name}: nothing to crop to (${shot.clip})`);
		const x = Math.max(0, Math.floor(box.x));
		const y = Math.max(0, Math.floor(box.y));
		clip = {
			x,
			y,
			width: Math.min(width - x, Math.ceil(box.width)),
			height: Math.min(height - y, Math.ceil(box.height)),
			scale: 1,
		};
	}
	const { data } = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
	return Buffer.from(data, "base64");
}

function compress(file) {
	const has = tool => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
	if (has("pngquant"))
		spawnSync("pngquant", ["--quality=75-92", "--speed=1", "--strip", "--force", "--output", file, file]);
	if (has("oxipng")) spawnSync("oxipng", ["-o", "4", "--strip", "safe", "-q", file]);
}

async function main() {
	const opts = options();
	const chromePath = findChrome(opts.chrome);
	const mock = opts.url ? { origin: new URL(opts.url).origin, stop: () => {} } : await startMock();
	let chrome;
	const cleanup = () => {
		chrome?.stop();
		mock.stop();
	};
	process.once("SIGINT", () => (cleanup(), process.exit(130)));
	try {
		chrome = await startChrome(chromePath);
		const { send } = chrome;
		await send("Page.enable");
		await send("Runtime.enable");
		await send("Emulation.setEmulatedMedia", {
			features: [
				{ name: "prefers-color-scheme", value: opts.theme },
				{ name: "prefers-reduced-motion", value: "reduce" },
			],
		});
		// Signed in as the mock's user, in the chosen theme, before the app's own scripts run on every page.
		await send("Page.addScriptToEvaluateOnNewDocument", {
			source: `try { localStorage.setItem("wlp.theme", ${JSON.stringify(opts.theme)}); localStorage.setItem("wlp.auth.mock", ${JSON.stringify(JSON.stringify(MOCK_AUTH))}); } catch {}
				${PAGE_HELPERS}
				addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = "*, *::before, *::after { caret-color: transparent !important; } .mock-flag { display: none !important; }"; document.head.append(s); });`,
		});
		// The first page load makes Vite optimize the dependencies, which can reload the page once.
		await capture(chrome, mock.origin, { ...SHOTS[0], name: "warm-up" }).catch(() => {});
		mkdirSync(opts.out, { recursive: true });
		for (const shot of opts.shots) {
			let png;
			for (let attempt = 1; ; attempt++) {
				try {
					png = await capture(chrome, mock.origin, shot);
					break;
				} catch (error) {
					if (attempt === 2) throw error;
					console.error(`retrying ${shot.name}: ${error.message}`);
				}
			}
			const file = join(opts.out, `${shot.name}.png`);
			writeFileSync(file, png);
			compress(file);
			console.log(`${file}  ${Math.round(statSync(file).size / 1024)} KB  ${shot.alt}`);
		}
	} finally {
		cleanup();
	}
}

main().catch(error => {
	console.error(error.message);
	process.exit(1);
});
