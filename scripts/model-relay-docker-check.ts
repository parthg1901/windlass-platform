/**
 * The Docker model relay with real containers (docs/model-relay.md): the program a paired machine's relay runs for
 * Settings-key leases the platform forwards, opened here on the layer's relay as a runner opens it (`--hosted-keys`:
 * hosted Docker's forwarders, which carry no machine proof). In a hardened session container, where commands run
 * directly as the user Windlass runs as:
 *
 *   1. what a command can read: /dev/shm, Windlass's data directory, /tmp, the workspace, every /proc/<pid>/environ
 *      and cmdline. The platform's forwarded placeholder is in none of them, only the turn's local one.
 *   2. another turn's placeholder on this turn's forwarder; a route no wire has; the relay's caps; its logs.
 *   3. after the turn, the forwarder and the lease file are gone; a suspended sandbox takes its lease with it.
 *   4. the end of a turn stops its request still streaming; a session process that holds 127.0.0.1:17893 before
 *      the forwarder fails the turn; what a server that died left (a forwarder, a lease file) is removed when the
 *      next one prepares the relay.
 *   5. a machine's plan relay (`openPlan`): the token only on its standard input, replaced with `hand`.
 *   6. 64 streams at once, with 1 MiB request bodies and 2 MiB answers, through a relay container of
 *      the hosted relay's memory (RELAY_MEMORY): every stream completes, and the relay is not killed.
 *
 * The relay sends to a recording upstream on a network of the check's own instead of the platform's route.
 *
 *   cd server && npx tsx ../scripts/model-relay-docker-check.ts
 *
 * Needs Docker and the base image (sandbox/build.sh).
 */

import "./check-secret.js";
import assert from "node:assert/strict";
import { config } from "../server/src/config.js";
import { randomBytes } from "node:crypto";
import { docker } from "../server/src/sandbox/docker.js";
import { createSandboxLayer } from "../server/src/sandbox/index.js";
import type { DockerSandboxHandle } from "../server/src/sandbox/sandboxes.js";
import { openModelKeyRelay } from "../server/src/sandbox/token-file.js";
import { DATA_DIR, type ForwardedKeyLease } from "../server/src/sandbox/provider.js";
import { DockerModelRelay, RELAY_MEMORY } from "../server/src/sandbox/model-relay.js";
import { imageId } from "./check-image.js";
import { sleep } from "./check-wait.js";

let failed = 0;
function expect(what: string, ok: boolean, detail = ""): void {
	if (!ok) failed += 1;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}${!ok && detail ? `\n      ${detail.slice(0, 2000)}` : ""}`);
}

const run = randomBytes(4).toString("hex");
const network = `wlp-mr-check-${run}`;
const upstreamName = `wlp-mr-upstream-${run}`;
const scope = `check${run}`;
/** A Settings-key lease as the platform forwards it to a machine: its placeholder is what the upstream sees. */
const forwardOf = (): ForwardedKeyLease => ({
	provider: "openai",
	host: "relay.example.com",
	placeholder: `wlpm1.${randomBytes(24).toString("hex")}`,
	proofKey: randomBytes(32).toString("base64url"),
	expiresAt: Date.now() + 3_600_000,
});

/** The recorder: Windlass's two routes, a slow one for the caps, and what it saw. */
const UPSTREAM = `
const http = require("node:http");
const seen = [];
const event = (type, data) => "event: " + type + "\\ndata: " + JSON.stringify({ type, ...data }) + "\\n\\n";
http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		if (req.url === "/__seen") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(seen)); }
		seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null });
		if (body.includes("private-relay-check")) { res.writeHead(403); return res.end("refused"); }
		if (req.url.endsWith("/v1/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ models: [{ slug: "relay-model", display_name: "Relay model", visibility: "list" }] }));
		}
		const stream = /"stream":(\\d+)/.exec(body);
		if (stream) {
			// A long answer in 64 parts, 40 ms apart: what a streaming Responses call looks like to the relay.
			res.writeHead(200, { "content-type": "text/event-stream" });
			const part = "x".repeat(Math.floor(Number(stream[1]) * 1024 / 64));
			let n = 0;
			const next = () => {
				if (n++ === 64) return res.end(event("response.completed", { response: { output: [] } }));
				res.write(event("response.output_text.delta", { item_id: "i", output_index: 0, content_index: 0, delta: part }));
				setTimeout(next, 40);
			};
			return next();
		}
		const hold = /"hold":(\\d+)/.exec(body);
		setTimeout(() => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(event("response.created", { response: {} })
				+ event("response.output_item.done", { output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "From the relay." }] } })
				+ event("response.completed", { response: { output: [] } }));
		}, hold ? Number(hold[1]) : 0);
	});
}).listen(8080);`;

/**
 * A request from inside the session, as a command could make one: node's fetch to the forwarder. No cookie: the
 * OpenAI key wire refuses a header it does not know (sandbox/relay/wires.cjs).
 */
const CLIENT = `
const [bearer, path, body, count] = process.argv.slice(1);
const one = () => fetch("http://127.0.0.1:17893" + path, { method: body ? "POST" : "GET", body: body || undefined,
	headers: { authorization: "Bearer " + bearer, "content-type": "application/json" } })
	.then(async (r) => ({ status: r.status, text: (await r.text()).slice(0, 300) }), (e) => ({ status: 0, text: String(e.cause?.code ?? e) }));
Promise.all(Array.from({ length: Number(count || 1) }, (_, i) => new Promise((ok) => setTimeout(ok, i * 50)).then(one))).then((r) => console.log(JSON.stringify(r)));`;

/** Many streams at once from inside the session, each with a body of `pad` bytes: how many completed, and the bytes each got. */
const LOAD = `
const [bearer, count, pad, kb] = process.argv.slice(1);
const body = JSON.stringify({ stream: Number(kb), pad: "p".repeat(Number(pad)) });
async function one() {
	let status = 0, bytes = 0, tail = "";
	try {
		const r = await fetch("http://127.0.0.1:17893/v1/responses", { method: "POST", body, headers: { authorization: "Bearer " + bearer, "content-type": "application/json" } });
		status = r.status;
		for await (const chunk of r.body) {
			bytes += chunk.length;
			tail = (tail + Buffer.from(chunk).toString("latin1")).slice(-400);
		}
		return { status, bytes, done: tail.includes("response.completed") };
	} catch (e) {
		return { status, bytes, done: false, error: String(e.cause?.code ?? e) };
	}
}
Promise.all(Array.from({ length: Number(count) }, one)).then((r) => console.log(JSON.stringify(r)));`;

async function seen(): Promise<{ method: string; url: string; authorization: string | null; cookie: string | null }[]> {
	const out = await docker(
		[
			"exec",
			upstreamName,
			"node",
			"-e",
			"fetch('http://127.0.0.1:8080/__seen').then(r=>r.text()).then(t=>process.stdout.write(t))",
		],
		{ timeoutMs: 20_000 },
	);
	try {
		return JSON.parse(out.stdout);
	} catch {
		return [];
	}
}
async function request(
	box: DockerSandboxHandle,
	bearer: string,
	path: string,
	body = "",
	count = 1,
): Promise<{ status: number; text: string }[]> {
	const said = await box.ask(["node", "-e", CLIENT, bearer, path, body, String(count)], { timeoutMs: 60_000 });
	try {
		return JSON.parse(said?.stdout ?? "");
	} catch {
		return [{ status: -1, text: `${said?.stdout ?? ""} ${said?.stderr ?? ""}` }];
	}
}

const image = await imageId();
const cleanup: (() => Promise<unknown>)[] = [];
async function check() {
	const keyOnly = process.argv.includes("--hosted-keys");
	if (keyOnly) {
		config.modelRelay.url = { host: "relay.example.com", origin: "https://relay.example.com" };
		process.env.WLP_CODEX_IMAGE ??= image; // The stand-in below drives the CLI's relay from this container.
	}
	await docker(["network", "create", network], { check: true });
	cleanup.push(() => docker(["network", "rm", network]));
	await docker(
		["run", "-d", "--name", upstreamName, "--network", network, "--user", "agent", image, "node", "-e", UPSTREAM],
		{ check: true },
	);
	cleanup.push(() => docker(["rm", "-f", upstreamName]));
	const layer = createSandboxLayer({
		image,
		signIns: "memory",
		tokenNetwork: "none",
		modelRelay: {
			machine: keyOnly ? "" : scope,
			nameScope: scope,
			network,
			upstream: `http://${upstreamName}:8080`,
			limits: { sessionRequests: 2, sessionWaiting: 1, waitMs: 1500 },
		},
	});
	const relayName = `wlp-model-relay-${scope}`;
	cleanup.push(() => docker(["volume", "rm", "-f", `wlp-model-socket-${scope}`]));
	cleanup.push(() => docker(["rm", "-f", relayName]));
	const uid = `mrcheck${run}`;
	cleanup.push(() => docker(["volume", "rm", "-f", `wlp-user-${uid}`]));
	const make = async (session: string) => {
		const id = await layer.sandboxes.create({
			uid,
			sessionId: session,
			profile: "docker-hardened",
			...(keyOnly && { harness: "codex" }),
		});
		cleanup.push(() => layer.sandboxes.destroy(id));
		const box = (await layer.sandboxes.connect(id)) as DockerSandboxHandle | undefined;
		if (!box) throw new Error("the sandbox could not be connected");
		return box;
	};
	/** A forwarded Settings-key lease as a runner opens one for a machine's turn (runner/src/session.ts), on this layer's relay. */
	const lease = (box: DockerSandboxHandle, forward = forwardOf()) =>
		layer.modelRelay!.open(box.container, box.id, box.uid, forward).then(opened => ({ ...opened, forward }));
	const a = await make("s-relay-a");
	const b = await make("s-relay-b");
	expect("the hosted sandbox offers its key relay", typeof a.modelKeyRelay === "function");
	const foreignSession = await openModelKeyRelay(a, "s-relay-b", {
		provider: "google",
		generation: "test",
		harness: "opencode",
	}).catch(error => error);
	expect(
		"a Docker key relay refuses another sandbox's session",
		foreignSession instanceof Error && /another session/.test(foreignSession.message),
	);

	if (keyOnly) {
		const key = { provider: "openai", generation: "fixture", harness: "codex" } as const;
		const own = await openModelKeyRelay(a, "s-relay-a", key);
		cleanup.push(own.close);
		const other = await openModelKeyRelay(b, "s-relay-b", key);
		cleanup.push(other.close);
		const status = async (box: DockerSandboxHandle, bearer: string) => {
			const reply = await box.ask([
				"node",
				"-e",
				"fetch(process.argv[1] + '/models', {headers:{authorization:'Bearer ' + process.argv[2]}}).then(r=>console.log(r.status))",
				own.env.WINDLASS_MODEL_BASE_URL!,
				bearer,
			]);
			return Number(reply?.stdout.trim());
		};
		assert.equal(await status(a, own.placeholder), 200);
		assert.equal(await status(b, own.placeholder), 401);
		assert.equal(await status(b, other.placeholder), 200);
		assert.equal((await seen()).length, 2);
		expect("each hosted Docker forwarder accepts only its own container’s Settings-key lease", true);
		return;
	}

	const leaseA = await lease(a);
	const leaseB = await lease(b);
	const placeholderA = leaseA.placeholder;
	const placeholderB = leaseB.placeholder;
	expect(
		"each turn gets a local placeholder of its own, not the platform's forwarded one",
		/^wlp-model\.[a-f0-9]{32}$/.test(placeholderA) && placeholderA !== placeholderB,
		placeholderA,
	);
	const named = await docker(
		["exec", relayName, "sh", "-c", `grep -l '"user":"${uid}"' /run/wlp-model/tokens/*.json | wc -l`],
		{ timeoutMs: 20_000 },
	);
	expect(
		"each turn's file in the relay names its user, which the relay's ceiling per user counts by",
		named.stdout.trim() === "2",
		named.stdout + named.stderr,
	);

	// 1. What a command can read, as the user Windlass runs as: printed whole and searched here.
	const scan = await a.run(
		[
			`for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do cat "$f" 2>/dev/null; echo; done`,
			`find /dev/shm ${DATA_DIR} /tmp /workspace /home/agent /run /var/tmp -xdev -type f -readable -size -2M -exec cat {} + 2>/dev/null; true`,
		].join("\n"),
		{ timeoutMs: 60_000 },
	);
	expect(
		"no file, no process environment and no command line in the session holds the forwarded placeholder",
		scan.exitCode === 0 && scan.stdout.length < 4_000_000 && !scan.stdout.includes(leaseA.forward.placeholder),
		`${scan.stdout.length} bytes, exit ${scan.exitCode}`,
	);
	const [listed] = await request(a, placeholderA, "/v1/models");
	expect(
		"a request on the turn's placeholder reaches the platform's route with the forwarded placeholder",
		listed?.status === 200 &&
			(await seen()).at(-1)?.url === "/model-relay/v1/models" &&
			(await seen()).at(-1)?.authorization === `Bearer ${leaseA.forward.placeholder}`,
		JSON.stringify({ listed, seen: (await seen()).at(-1) }),
	);

	// 2a. Another turn's placeholder on this turn's forwarder, and the forwarded placeholder as a bearer.
	const foreign = await request(a, placeholderB, "/v1/models");
	const bare = await request(a, leaseA.forward.placeholder, "/v1/models");
	const own = await request(b, placeholderB, "/v1/models");
	expect(
		"another session's placeholder and the forwarded one itself are refused on this session's forwarder; the other session's works on its own",
		foreign[0]?.status === 401 &&
			bare[0]?.status === 401 &&
			own[0]?.status === 200 &&
			(await seen()).at(-1)?.authorization === `Bearer ${leaseB.forward.placeholder}`,
		JSON.stringify({ foreign, bare, own }),
	);
	const wrong = await request(a, placeholderA, "/v1/embeddings", "{}");
	expect("a route no wire has is refused", wrong[0]?.status === 403, JSON.stringify(wrong));

	// 2b. The caps (2 in flight per turn, 1 waiting, 1.5 s wait): of five slow requests two run, one waits, two are refused.
	const capped = await request(a, placeholderA, "/v1/responses", '{"hold":2500}', 5);
	const statuses = capped.map(r => r.status).sort();
	expect(
		"the relay's caps hold: past them a request waits, then is refused with the session's ceiling named",
		statuses.filter(s => s === 200).length === 2 &&
			statuses.filter(s => s === 503).length === 3 &&
			capped.some(r => /from this session/.test(r.text)),
		JSON.stringify(capped),
	);

	// 2c. Inspect a diagnostic from the scoped relay through Docker's actual log driver.
	await request(a, placeholderA, "/v1/responses", '{"input":"private-relay-check"}');
	const inspected = await docker(["inspect", relayName], { timeoutMs: 20_000 });
	const logging = JSON.parse(inspected.stdout)[0].HostConfig.LogConfig;
	const logs = await docker(["logs", relayName], { timeoutMs: 20_000 });
	const output = logs.stdout + logs.stderr;
	expect(
		"the scoped relay rotates two 4 MiB Docker logs",
		logging.Type === "json-file" && logging.Config["max-size"] === "4m" && logging.Config["max-file"] === "2",
	);
	expect("docker logs includes the refused request's status", logs.code === 0 && output.includes("upstream=403"));
	expect(
		"relay diagnostics and configuration omit the request body and credentials",
		[leaseA.forward.placeholder, leaseB.forward.placeholder, placeholderA, placeholderB, "private-relay-check"].every(
			value => !output.includes(value) && !inspected.stdout.includes(value),
		),
	);

	// 3. After the turn.
	await leaseA.close();
	const ended = await request(a, placeholderA, "/v1/models");
	const left = await docker(["exec", relayName, "sh", "-c", "ls /run/wlp-model/tokens | wc -l"], { timeoutMs: 20_000 });
	const forwarder = await docker(["container", "inspect", `wlp-model-fwd-${a.id}`], { timeoutMs: 20_000 });
	expect(
		"after the turn its forwarder is gone, and the relay holds only the other turn's lease",
		ended[0]?.status === 0 && forwarder.code !== 0 && left.stdout.trim() === "1",
		JSON.stringify({ ended, left: left.stdout, forwarder: forwarder.code }),
	);
	await leaseB.close();
	const none = await docker(["exec", relayName, "sh", "-c", "ls /run/wlp-model/tokens | wc -l"], { timeoutMs: 20_000 });
	expect("when the last turn ends the relay holds no lease", none.stdout.trim() === "0", none.stdout);
	// A sandbox that is stopped takes a forwarder left by a turn cut off with its server with it.
	const leaseC = await lease(b);
	await layer.sandboxes.suspend(b.id);
	const afterSuspend = await docker(["exec", relayName, "sh", "-c", "ls /run/wlp-model/tokens | wc -l"], {
		timeoutMs: 20_000,
	});
	expect(
		"suspending a sandbox removes its forwarder and its turn's file in the relay",
		(await docker(["container", "inspect", `wlp-model-fwd-${b.id}`])).code !== 0 && afterSuspend.stdout.trim() === "0",
		afterSuspend.stdout,
	);
	await leaseC.close();

	// 4a. The end of a turn stops its request still streaming, at once and not when it would have finished.
	const leaseD = await lease(a);
	const started = Date.now();
	const long = request(a, leaseD.placeholder, "/v1/responses", '{"hold":20000}');
	await sleep(1500);
	await leaseD.close();
	const cut = await long;
	expect(
		"ending a turn stops its request still running, long before the provider would have answered",
		cut[0]?.status !== 200 && Date.now() - started < 12_000,
		JSON.stringify({ cut, ms: Date.now() - started }),
	);

	// 4b. A process of the session that took 127.0.0.1:17893 first: the forwarder cannot listen, and the turn fails.
	// What listens on 17893 (0x45E5): said when the case fails.
	const listeners = async () =>
		(
			await a.ask(["sh", "-c", "grep -i ':45E5 ' /proc/net/tcp | awk '$4==\"0A\"{print $2, $10}'"], {
				timeoutMs: 15_000,
			})
		)?.stdout
			.trim()
			.replace(/\s+/g, " ") ?? "";
	const before = await listeners();
	// Started as the agent the way a process left from setup lives on: outside every command the platform runs.
	const SQUAT = `require("node:fs").writeFileSync("/tmp/.squat.pid", String(process.pid)); require("node:net").createServer((s) => s.end("HTTP/1.1 200 OK\\r\\ncontent-length: 2\\r\\n\\r\\nok")).listen(17893, "127.0.0.1"); setTimeout(() => process.exit(0), 60_000);`;
	await docker(["exec", "-d", "-u", "agent", a.container, "node", "-e", SQUAT], { timeoutMs: 20_000, check: true });
	let squatterUp = "";
	for (let i = 0; i < 40 && !squatterUp.includes("0100007F:45E5"); i++) {
		squatterUp = await listeners();
		if (!squatterUp.includes("0100007F:45E5")) await sleep(250);
	}
	expect(
		"a session process holds 127.0.0.1:17893 before the turn starts",
		squatterUp.includes("0100007F:45E5"),
		`before: ${before} | after: ${squatterUp}`,
	);
	const squatted = await lease(a).then(
		opened => opened.close().then(() => null),
		(e: unknown) => e,
	);
	const filesE = await docker(["exec", relayName, "sh", "-c", "ls /run/wlp-model/tokens | wc -l"], {
		timeoutMs: 20_000,
	});
	expect(
		"a session process holding the relay's port fails the turn with a clear message, and no lease is left",
		squatted instanceof Error &&
			/holding that port|could not take/.test(String(squatted)) &&
			(await docker(["container", "inspect", `wlp-model-fwd-${a.id}`])).code !== 0 &&
			filesE.stdout.trim() === "0",
		`${String(squatted)} | before: ${before} | squatter: ${squatterUp} | files: ${filesE.stdout.trim()}`,
	);
	await a.ask(["sh", "-c", 'kill "$(cat /tmp/.squat.pid)" 2>/dev/null; rm -f /tmp/.squat.pid; sleep 0.3'], {
		timeoutMs: 15_000,
	});

	// 4c. What a server that died left: a forwarder, and the turn's file in the relay. The next server's preparation removes both.
	const leaseF = await lease(a);
	const nextServer = createSandboxLayer({
		image,
		signIns: "memory",
		tokenNetwork: "none",
		modelRelay: {
			machine: keyOnly ? "" : scope,
			nameScope: scope,
			network,
			upstream: `http://${upstreamName}:8080`,
			limits: { sessionRequests: 2, sessionWaiting: 1, waitMs: 1500 },
		},
	});
	const prepared = await nextServer.sandboxes.prepareModelRelay!();
	const leftFiles = await docker(["exec", relayName, "sh", "-c", "ls /run/wlp-model/tokens | wc -l"], {
		timeoutMs: 20_000,
	});
	expect(
		"a server that starts removes the forwarders and lease files a server that died left",
		/removed 1 forwarder/.test(prepared) &&
			(await docker(["container", "inspect", `wlp-model-fwd-${a.id}`])).code !== 0 &&
			leftFiles.stdout.trim() === "0",
		prepared + " / " + leftFiles.stdout,
	);
	await leaseF.close();

	// 5. A machine's plan relay (`openPlan`): a container of its own for the turn, the token only on its
	// standard input, the session's forwarder on 127.0.0.1:17893 to its socket, and everything gone at close.
	const p = await make("s-plan");
	const PLAN_A = `REAL-PLAN-TOKEN-A-${randomBytes(16).toString("hex")}`;
	const PLAN_B = `REAL-PLAN-TOKEN-B-${randomBytes(16).toString("hex")}`;
	const planName = `wlp-plan-relay-${p.id}`;
	cleanup.push(() => docker(["rm", "-f", planName]));
	const plan = await layer.modelRelay!.openPlan(p.container, p.id, PLAN_A, {
		wire: "chatgpt-plan",
		harness: "windlass",
		expiresAt: Date.now() + 5 * 60_000,
		requestLimit: 300,
	});
	cleanup.push(() => plan.close());
	const [planned] = await request(p, plan.placeholder, "/v1/models");
	expect(
		"a plan turn's request on a machine leaves from its relay with the plan's token",
		planned?.status === 200 && (await seen()).at(-1)?.authorization === `Bearer ${PLAN_A}`,
		JSON.stringify(planned),
	);
	expect("the plan relay refuses another bearer", (await request(p, PLAN_A, "/v1/models"))[0]?.status === 401);
	const planInspected = await docker(["container", "inspect", planName], { timeoutMs: 20_000 });
	const onDisk = await docker(
		[
			"exec",
			planName,
			"sh",
			"-c",
			'grep -rlsF -- "$1" /workspace /tmp /proc/1/environ /proc/1/cmdline; true',
			"sh",
			PLAN_A,
		],
		{ timeoutMs: 20_000 },
	);
	const inSession = await p.ask(
		["sh", "-c", 'grep -rlsF -- "$1" /dev/shm /workspace /tmp /proc/*/environ; true', "sh", PLAN_A],
		{ timeoutMs: 30_000 },
	);
	expect(
		"the plan's token is in no file, argument or environment of the relay container, nor anywhere in the session",
		planInspected.code === 0 &&
			!planInspected.stdout.includes(PLAN_A) &&
			onDisk.code === 0 &&
			onDisk.stdout.trim() === "" &&
			inSession?.code === 0 &&
			inSession.stdout.trim() === "",
		`inspect ${planInspected.code}, relay: ${onDisk.stdout}, session: ${inSession?.stdout}`,
	);
	await plan.hand(PLAN_B);
	await request(p, plan.placeholder, "/v1/models");
	expect("a token handed later is the next request's", (await seen()).at(-1)?.authorization === `Bearer ${PLAN_B}`);
	await plan.close();
	const afterClose = await request(p, plan.placeholder, "/v1/models");
	expect(
		"closing the plan relay removes its container and forwarder, and the session reaches nothing on 17893",
		(await docker(["container", "inspect", planName])).code !== 0 &&
			(await docker(["container", "inspect", `wlp-model-fwd-${p.id}`])).code !== 0 &&
			afterClose[0]?.status === 0,
		JSON.stringify(afterClose),
	);

	// 6. 64 streams at once through a relay of the hosted relay's memory, one session's forwarder carrying all of them.
	const loadScope = `${scope}l`;
	const load = new DockerModelRelay({
		machine: loadScope,
		image,
		network,
		upstream: `http://${upstreamName}:8080`,
		requests: 64,
		limits: { sessionRequests: 64, sessionConnections: 80, sessionWaiting: 64, waitMs: 60_000 },
	});
	cleanup.push(() => docker(["volume", "rm", "-f", `wlp-model-socket-${loadScope}`]));
	cleanup.push(() => docker(["rm", "-f", `wlp-model-relay-${loadScope}`]));
	const leaseL = await load.open(a.container, a.id, uid, forwardOf());
	cleanup.push(() => leaseL.close());
	const loadRelay = `wlp-model-relay-${loadScope}`;
	const loadStart = Date.now();
	const said = await a.ask(["node", "-e", LOAD, leaseL.placeholder, "64", String(1024 * 1024), "2048"], {
		timeoutMs: 300_000,
	});
	let results: { status: number; bytes: number; done: boolean; error?: string }[] = [];
	try {
		results = JSON.parse(said?.stdout ?? "[]");
	} catch {
		/* reported below */
	}
	const peak = await docker(
		[
			"exec",
			loadRelay,
			"sh",
			"-c",
			"cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes",
		],
		{ timeoutMs: 20_000 },
	);
	const state = await docker(
		["inspect", "--format", "{{.State.Running}}|{{.State.OOMKilled}}|{{.HostConfig.Memory}}", loadRelay],
		{ timeoutMs: 20_000 },
	);
	const peakMiB = Math.round(Number(peak.stdout.trim()) / 2 ** 20);
	const limitMiB = Math.round(Number(state.stdout.trim().split("|")[2]) / 2 ** 20);
	console.log(
		`      64 streams: ${Date.now() - loadStart} ms, relay memory peak ${peakMiB} MiB of ${limitMiB} MiB (${RELAY_MEMORY})`,
	);
	const incomplete = results.filter(r => r.status !== 200 || !r.done || r.bytes <= 2 * 1024 * 1024);
	const passed =
		said?.code === 0 &&
		results.length === 64 &&
		incomplete.length === 0 &&
		state.stdout.trim().startsWith("true|false|") &&
		peakMiB > 0 &&
		peakMiB < limitMiB;
	let details = "";
	if (!passed) {
		const forwarder = await docker(
			[
				"inspect",
				"--format",
				"{{.State.Status}} OOMKilled={{.State.OOMKilled}} exit={{.State.ExitCode}}",
				load.forwarderName(a.id),
			],
			{ timeoutMs: 20_000 },
		);
		details = JSON.stringify({
			results: results.length,
			incomplete: incomplete.length,
			firstFailure: incomplete[0],
			peakMiB,
			limitMiB,
			relay: state.stdout.trim(),
			forwarder: (forwarder.stdout || forwarder.stderr).trim(),
			clientExit: said?.code,
			stderr: said?.stderr.slice(-1000),
		});
	}
	expect(
		"64 streams at once with 1 MiB bodies and 2 MiB answers all complete through a relay of the hosted relay's memory, which is not killed",
		passed,
		details,
	);
}
try {
	await check();
} catch (error) {
	failed += 1;
	console.log(`FAIL  the check could not run: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
	// Last made, first removed: a container goes before the network and volumes it uses.
	for (const step of cleanup.reverse()) await step().catch(() => undefined);
}
console.log(failed === 0 ? "\nall model relay Docker checks passed" : `\n${failed} model relay Docker check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
