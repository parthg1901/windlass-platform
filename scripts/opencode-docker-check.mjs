// Run from server with: pnpm exec tsx ../scripts/opencode-docker-check.mjs sha256:<local OpenCode image id>
import { build } from "../runner/node_modules/esbuild/lib/main.js";
import { checkIsolation } from "../fixtures/claude-relay/isolation.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpConnection, LineSplitter } from "../server/src/sandbox/acp.ts";

const image = process.argv[2];
assert.match(image ?? "", /^sha256:[a-f0-9]{64}$/);
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(root, ".f3-check-"));
const id = randomBytes(8).toString("hex"),
	prefix = "f3-check-" + id,
	machineId = "m_" + id;
const relayName = "wlp-opencode-relay-" + machineId;
const uplink = prefix + "-uplink",
	upstream = prefix + "-upstream",
	native = prefix + "-native";
const token = "oc-fixture-" + randomBytes(32).toString("hex");
const identity = { uid: "fixture", machineId };
const { privateKey } = generateKeyPairSync("ed25519");
Object.assign(process.env, {
	WLP_SECRET: randomBytes(32).toString("hex"),
	WLP_RUNNER_STATE_DIR: dir,
	F3_HARNESS: "opencode",
	F3_DIR: dir,
	F3_MACHINE: machineId,
	F3_PREFIX: prefix,
	PATH: dir + ":" + process.env.PATH,
});
Object.assign(globalThis, {
	SANDBOX_IMAGE: image,
	SHOTS_IMAGE_PIN: "",
	HARNESS_IMAGES: { opencode: image },
	OPENCODE_RELAY_SCRIPT: (
		await build({
			entryPoints: [join(root, "sandbox/relay/opencode.cjs")],
			bundle: true,
			platform: "node",
			format: "cjs",
			write: false,
		})
	).outputFiles[0].text,
	CLAUDE_RELAY_SCRIPT: await readFile(join(root, "sandbox/relay/server.cjs"), "utf8"),
});
const { docker } = await import("../server/src/sandbox/docker.ts");
const { Executor } = await import("../runner/src/docker-executor.ts");
const { storePair } = await import("../runner/src/state.ts");
const { beginProviderLogin, storeProvider } = await import("../runner/src/opencode-login.ts");
const { probeHarnessOptions } = await import("../runner/src/harness-options.ts");
const { channelTurn } = await import("../fixtures/opencode/channel.mjs");
const { containerName } = await import("../server/src/sandbox/sandboxes.ts");
const cmd = async (args, opts) => (await docker(args, { check: true, timeoutMs: 45_000, ...opts })).stdout.trim();
const ok = message => console.log("PASS  " + message);
const executor = mode => new Executor(identity, {}, false, false, ["docker-hardened"], { mode, allow: [] }, true);
const owner = executor("restricted");
const profile = "docker-hardened";
const saved = new Map();
async function create(session, machine = owner) {
	const id = await machine.create(session, profile, false, "opencode");
	const name = containerName("opencode-" + id.slice(-12));
	const [box] = JSON.parse(await cmd(["container", "inspect", name]));
	assert.equal(box.Mounts.length, 0);
	const { env } = await machine.turnCredentials("opencode-" + id.slice(-12), "opencode", {});
	const placeholder = JSON.parse(env.OPENCODE_AUTH_CONTENT).openai;
	saved.set(name, { id, machine, placeholder, flags: Object.entries(env).flatMap(([k, v]) => ["-e", k + "=" + v]) });
	return name;
}
let adapter;
async function startAdapter(name, proxyEnv = []) {
	const box = saved.get(name);
	const credentials = box && (await box.machine.turnCredentials("opencode-" + box.id.slice(-12), "opencode", {}));
	const flags = Object.entries(credentials?.env ?? {}).flatMap(([k, v]) => ["-e", k + "=" + v]);
	const child = (adapter = spawn(
		"docker",
		["exec", "-i", ...flags, ...proxyEnv, name, ...(name === native ? ["opencode", "acp"] : ["wlp-opencode-acp"])],
		{ stdio: ["pipe", "pipe", "pipe"] },
	));
	child.once("close", () => {
		void credentials?.close?.();
	});
	return child;
}
async function turn(first, proxyEnv, scan, model) {
	const child = await startAdapter(first, proxyEnv);
	child.stderr.resume();
	let reply = "";
	const rpc = new AcpConnection(
		line => child.stdin.write(line + "\n"),
		{
			async request() {
				throw Error("No client tools in fixture");
			},
			notification(method, params) {
				if (method === "session/update" && params.update.sessionUpdate === "agent_message_chunk")
					reply += params.update.content.text;
			},
		},
		"",
	);
	const lines = new LineSplitter(line => rpc.receive(line));
	child.stdout.setEncoding("utf8").on("data", s => lines.push(s));
	child.on("close", () => rpc.end("Adapter closed"));
	const call = (method, params) => rpc.request(method, params, { timeoutMs: 45000 });
	const initialized = await call("initialize", {
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
	});
	assert.equal(initialized.agentInfo.version, "1.19.6");
	const opened = await call("session/new", { cwd: "/workspace", mcpServers: [] });
	assert.equal(opened.modes, undefined);
	assert.deepEqual(
		opened.configOptions.find(o => o.category === "mode").options.map(o => o.value),
		["build", "plan"],
	);
	const options = await call("session/set_config_option", {
		sessionId: opened.sessionId,
		configId: "mode",
		value: "plan",
	});
	assert.equal(options.configOptions.find(o => o.category === "mode").currentValue, "plan");
	if (model) await call("session/set_config_option", { sessionId: opened.sessionId, configId: "model", value: model });
	const result = await call("session/prompt", {
		sessionId: opened.sessionId,
		prompt: [{ type: "text", text: "Say relay proof." }],
	});
	assert.equal(result.stopReason, "end_turn");
	assert.equal(reply, "relay proof");
	if (scan) await checkIsolation(first, cmd, token, "opencode", "/run/wlp-harness/opencode/login.json");
	child.stdin.end();
}
// A builder's turn with the platform's tools over MCP (platform-tools.ts), through the image's wlp-acp-mcp: the platform's
// handlers answer, and a process of the sandbox without the bridge's token is refused.
async function toolsTurn(name, model) {
	const { PLATFORM_MCP_SERVER, PlatformMcpServer, platformToolDeclarations } = await import(
		"../server/src/platform-tools.ts"
	);
	const { askPerson, ASK_TAKEN, REPORT_TAKEN } = await import("../server/src/agent-publish.ts");
	const { fileReport } = await import("../server/src/factory/review.ts");
	const { NO_REDACTION } = await import("../server/src/repo-secrets.ts");
	const filed = [],
		asked = [],
		probes = [];
	let running = false;
	const handlers = new Map([
		[
			"report",
			request =>
				fileReport(request.arguments, NO_REDACTION, report => {
					filed.push(report);
				}),
		],
		[
			"ask_person",
			async request => {
				probes.push(
					await cmd([
						"exec",
						name,
						"node",
						"-e",
						`const lines=require('fs').readFileSync('/proc/net/tcp','utf8').split('\\n').slice(1);
				const ports=lines.map(l=>l.trim().split(/\\s+/)).filter(f=>f[1]&&f[1].startsWith('0100007F:')&&f[3]==='0A').map(f=>parseInt(f[1].split(':')[1],16)).filter(p=>p!==17891&&p!==17892);
				Promise.all(ports.map(p=>fetch('http://127.0.0.1:'+p+'/mcp-d2luZGxhc3MtcGxhdGZvcm0',{method:'POST',headers:{'content-type':'application/json'},body:'{"jsonrpc":"2.0","id":1,"method":"tools/list"}'}).then(async r=>[p,r.status,/ask_person/.test(await r.text())],()=>[p,0,false]))).then(s=>console.log(JSON.stringify(s)))`,
					]),
				);
				const taken = askPerson(request.arguments, { already: asked.length > 0, left: 3 }, NO_REDACTION);
				if (taken.asked) asked.push(taken.asked);
				return taken.told;
			},
		],
	]);
	const server = new PlatformMcpServer(
		handlers,
		platformToolDeclarations(handlers, { screenshots: false }),
		() => running,
	);
	const child = await startAdapter(name);
	child.stderr.resume();
	let reply = "";
	const rpc = new AcpConnection(
		line => child.stdin.write(line + "\n"),
		{
			async request(method, params, withdrawn) {
				if (method === "mcp/message") return server.handle(params, withdrawn);
				if (method === "session/request_permission")
					return {
						outcome: { outcome: "selected", optionId: params.options.find(o => o.kind === "allow_once").optionId },
					};
				throw Error("No other client requests in fixture: " + method);
			},
			notification(method, params) {
				if (method === "session/update" && params.update.sessionUpdate === "agent_message_chunk")
					reply += params.update.content.text;
			},
		},
		"",
	);
	const lines = new LineSplitter(line => rpc.receive(line));
	child.stdout.setEncoding("utf8").on("data", s => lines.push(s));
	child.on("close", () => rpc.end("Adapter closed"));
	const call = (method, params) => rpc.request(method, params, { timeoutMs: 45000 });
	const initialized = await call("initialize", {
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
	});
	assert.equal(
		initialized.agentCapabilities.mcpCapabilities.acp,
		true,
		"wlp-acp-mcp did not say the agent takes acp servers",
	);
	const opened = await call("session/new", { cwd: "/workspace", mcpServers: [PLATFORM_MCP_SERVER] });
	await call("session/set_config_option", { sessionId: opened.sessionId, configId: "mode", value: "build" });
	await call("session/set_config_option", { sessionId: opened.sessionId, configId: "model", value: model });
	running = true;
	const result = await call("session/prompt", {
		sessionId: opened.sessionId,
		prompt: [{ type: "text", text: "Platform tool check." }],
	});
	running = false;
	child.stdin.end();
	await new Promise(done => child.once("close", done));
	assert.equal(result.stopReason, "end_turn");
	assert.equal(reply, "platform tools passed");
	assert.deepEqual(filed, [
		{ screenshots: [], title: "Relay tool report", description: "Checked the tools.", lookAt: "", concerns: "" },
	]);
	assert.deepEqual(asked, [{ text: "Which store?", options: ["SQLite", "Postgres"] }]);
	const answered = JSON.parse(probes[0] ?? "[]");
	// The adapter's endpoint answers 401 without the token; no listener of the sandbox hands out the platform's tools.
	const endpoint = answered.filter(([port, status]) => port !== 17894 && status === 401).map(([port]) => port);
	assert.ok(
		endpoint.length === 1 && !answered.some(([, , tools]) => tools),
		"a process without the token reached the tools: " + probes[0],
	);
	assert.ok(
		(await cmd(["logs", upstream])).includes(
			"platform tools results=2 told=" + JSON.stringify(REPORT_TAKEN + " | " + ASK_TAKEN),
		),
		"the model was not told what the handlers said",
	);
	const port = endpoint[0].toString(16).toUpperCase().padStart(4, "0");
	assert.equal(
		await cmd(["exec", name, "sh", "-c", `grep -c '0100007F:${port} .* 0A ' /proc/net/tcp || true`]),
		"0",
		"the endpoint outlived its adapter",
	);
}
// A person's turn with push, fetch_base and publish over MCP through wlp-acp-mcp, in Build: OpenCode does not ask about the
// platform's tools, each call reaches the handlers as one over MCP, another branch is refused, and a publish that answers
// after 70 s (it waits for the person) reaches the model: OpenCode gives an MCP request 60 s unless its config says otherwise.
async function pushTurn(name, model) {
	const { PLATFORM_MCP_SERVER } = await import("../server/src/platform-tools.ts");
	const { pushTurnServer, PUSH_PROMPT, PUSH_REPLY } = await import("../fixtures/acp-agent/platform-push.mjs");
	const turn = await pushTurnServer({ publishWaitMs: 70_000 });
	const child = await startAdapter(name);
	child.stderr.resume();
	let reply = "";
	const rpc = new AcpConnection(
		line => child.stdin.write(line + "\n"),
		{
			async request(method, params, withdrawn) {
				if (method === "mcp/message") return turn.server.handle(params, withdrawn);
				if (method === "session/request_permission") return turn.permission(params);
				throw Error("No other client requests in fixture: " + method);
			},
			notification(method, params) {
				if (method === "session/update" && params.update.sessionUpdate === "agent_message_chunk")
					reply += params.update.content.text;
			},
		},
		"",
	);
	const lines = new LineSplitter(line => rpc.receive(line));
	child.stdout.setEncoding("utf8").on("data", s => lines.push(s));
	child.on("close", () => rpc.end("Adapter closed"));
	const call = (method, params, timeoutMs = 45000) => rpc.request(method, params, { timeoutMs });
	await call("initialize", {
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
	});
	const opened = await call("session/new", { cwd: "/workspace", mcpServers: [PLATFORM_MCP_SERVER] });
	await call("session/set_config_option", { sessionId: opened.sessionId, configId: "mode", value: "build" });
	await call("session/set_config_option", { sessionId: opened.sessionId, configId: "model", value: model });
	turn.running = true;
	const result = await call(
		"session/prompt",
		{ sessionId: opened.sessionId, prompt: [{ type: "text", text: PUSH_PROMPT }] },
		5 * 60_000,
	);
	turn.running = false;
	child.stdin.end();
	await new Promise(done => child.once("close", done));
	assert.equal(result.stopReason, "end_turn");
	assert.equal(reply, PUSH_REPLY);
	turn.check(await cmd(["logs", upstream]));
}
await symlink(join(root, "fixtures/claude-relay/docker.cjs"), join(dir, "docker"));
async function settingsKeyTurns() {
	const id = await owner.create("keys", profile, false, "opencode");
	const anth = "anthropic/claude-opus-4-6";
	await channelTurn(owner, "keys", id, "default", undefined, undefined, { providers: ["anthropic"] });
	// One turn can send more than one request (OpenCode also asks for a title), so compare counts rather than fix one.
	const keyRequests = async () =>
		(await cmd(["logs", upstream])).split("settings POST /model-relay/v1/messages").length - 1;
	const keyed = await keyRequests();
	assert.ok(keyed >= 1, "the Settings key did not pay without a machine login");
	await storeProvider(owner, { provider: "anthropic", key: token + "-key" });
	await storeProvider(owner, { provider: "openai", key: token + "-key" });
	await owner.loginChanged(true);
	const offered = owner.report().harnesses.find(entry => entry.id === "opencode");
	assert.equal(offered.signIn, "token");
	assert.deepEqual([...offered.machineProviders].sort(), ["anthropic", "openai"]);
	// The machine's own logins win for their providers; a key pays only for a provider it has no login for.
	await channelTurn(owner, "keys", id, anth, undefined, undefined, { providers: ["anthropic", "google"] });
	await channelTurn(owner, "keys", id, "openai/gpt-5.4", undefined, undefined, { providers: ["anthropic", "openai"] });
	await channelTurn(owner, "keys", id, anth);
	assert.equal(await keyRequests(), keyed, "a Settings key paid where the machine has its own login");
	const log = await cmd(["logs", upstream]);
	assert.match(log, /authorized api.openai.com \/v1\/responses/);
	ok("A Settings key pays without a machine login; the machine's own logins win once it has them.");
	const raw = "opencode-" + id.slice(-12),
		name = containerName(raw);
	const lease = await owner.openTurnKey(raw, "opencode", {
		host: "relay.fixture.test",
		provider: "anthropic",
		placeholder: "wlpm1.fixture",
		proofKey: randomBytes(32).toString("base64url"),
		expiresAt: Date.now() + 60000,
	});
	const post = (route, header, value) =>
		cmd([
			"exec",
			name,
			"node",
			"-e",
			"const [url,header,value]=process.argv.slice(1); fetch('http://127.0.0.1:'+url,{method:'POST',headers:{[header]:value,'content-type':'application/json'},body:'{}'}).then(r=>console.log(r.status))",
			route,
			header,
			value,
		]);
	try {
		const first = await owner.turnCredentials(raw, "opencode", { anthropic: lease.placeholder });
		const fallback = "Bearer " + JSON.parse(first.env.OPENCODE_AUTH_CONTENT).openai.key;
		assert.equal(await post("17892/anthropic/messages", "x-api-key", fallback.slice(7)), "401");
		await first.close();
		assert.equal(await post("17892/openai/responses", "authorization", fallback), "401");
		await storeProvider(owner);
		await storeProvider(owner, { provider: "anthropic", key: token + "-key" });
		const prior = await owner.turnCredentials(raw, "opencode", {});
		const oldKey = JSON.parse(prior.env.OPENCODE_AUTH_CONTENT).anthropic.key;
		await owner.turnCredentials(raw, "opencode", { anthropic: lease.placeholder });
		assert.equal(
			await post("17892/anthropic/messages", "x-api-key", oldKey),
			"401",
			"a replaced turn cannot retain the machine login",
		);
		await storeProvider(owner);
		assert.equal(await post("17894/anthropic/messages", "x-api-key", lease.placeholder), "200");
		ok("OpenCode scopes its machine fallback to this turn and keeps its Settings lease across logout.");
	} finally {
		await lease.close();
	}
	await owner.lifecycle("destroy", id, "keys");
}
async function check() {
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=api.anthropic.com",
			"-addext",
			"subjectAltName=DNS:relay.fixture.test,DNS:auth.openai.com,DNS:chatgpt.com,DNS:api.openai.com,DNS:api.anthropic.com,DNS:opencode.ai,DNS:api.z.ai",
			"-keyout",
			join(dir, "key.pem"),
			"-out",
			join(dir, "cert.pem"),
		],
		{ stdio: "ignore" },
	);
	await writeFile(join(dir, "expected"), token);
	await copyFile(join(root, "fixtures/opencode/upstream.cjs"), join(dir, "upstream.cjs"));
	await cmd(["network", "create", "--internal", uplink]);
	// Mount individual files; the recording origin has no access to the runner's pairing state.
	const mounts = ["key.pem", "cert.pem", "expected", "upstream.cjs"].flatMap(file => [
		"--mount",
		`type=bind,src=${dir}/${file},dst=/fixture/${file},readonly`,
	]);
	await cmd([
		"run",
		"-d",
		"--pull",
		"never",
		"--network",
		uplink,
		"--network-alias",
		"relay.fixture.test",
		"--network-alias",
		"auth.openai.com",
		"--network-alias",
		"chatgpt.com",
		"--network-alias",
		"api.openai.com",
		"--network-alias",
		"api.anthropic.com",
		"--network-alias",
		"opencode.ai",
		"--network-alias",
		"api.z.ai",
		"--name",
		upstream,
		"--user",
		String(process.getuid()),
		"--cap-drop",
		"ALL",
		...mounts,
		image,
		"node",
		"/fixture/upstream.cjs",
	]);
	storePair(identity, privateKey, "https://fixture.invalid");
	await settingsKeyTurns();
	if (process.argv.includes("--settings-keys")) return;
	const freeModel = "opencode/deepseek-v4.1-flash-free";
	await cmd([
		"run",
		"-d",
		"--pull",
		"never",
		"--network",
		uplink,
		"--name",
		native,
		"--cap-drop",
		"ALL",
		"--mount",
		`type=bind,src=${dir}/cert.pem,dst=/fixture-ca.pem,readonly`,
		"-e",
		"NODE_EXTRA_CA_CERTS=/fixture-ca.pem",
		"-e",
		"OPENCODE_DISABLE_MODELS_FETCH=true",
		"-e",
		"OPENCODE_DISABLE_AUTOUPDATE=true",
		"-e",
		"XDG_CONFIG_HOME=/tmp/native-config",
		image,
		"sleep",
		"infinity",
	]);
	await turn(native, [], false, freeModel);
	ok("Pinned native ACP completed a direct anonymous turn at the private TLS recorder.");
	await owner.loginChanged(false);
	const catalog = owner.report().harnesses[0].options;
	assert.ok(catalog.checkedAt > 0);
	assert.deepEqual(
		catalog.modes.map(m => m.id),
		["build", "plan"],
	);
	assert.ok(catalog.models.some(m => m.id === catalog.defaultModel));
	const multi = await probeHarnessOptions(owner, image, ["opencode-go", "openai", "openrouter"]);
	assert.ok(multi.models.length > 32);
	assert.deepEqual(multi.models.find(m => m.id === "openai/gpt-5.4")?.efforts, [
		"none",
		"low",
		"medium",
		"high",
		"xhigh",
		"default",
	]);
	assert.deepEqual(multi.models.find(m => m.id === "openrouter/moonshotai/kimi-k2.5")?.efforts, []);
	ok(
		"Offline inventory includes public models, both modes and model-specific efforts across " +
			multi.models.length +
			" configured provider models.",
	);
	process.env.F3_PAUSE_PROBE = "1";
	const probing = owner.loginChanged(true);
	try {
		const deadline = Date.now() + 15000;
		while (!existsSync(join(dir, "probing"))) {
			assert.ok(Date.now() < deadline, "The inventory probe did not start");
			await wait(50);
		}
		await storeProvider(owner, { provider: "openai", key: token + "-key" });
	} finally {
		await writeFile(join(dir, "continue-probe"), "");
		delete process.env.F3_PAUSE_PROBE;
		await probing;
	}
	assert.equal(owner.report().harnesses[0].options, undefined, "A superseded inventory reached the report");
	const bundle = join(dir, "runner.cjs");
	execFileSync(process.execPath, [join(root, "runner/bundle.mjs"), image, bundle, "opencode=" + image]);
	const cli = (...args) => execFileSync(process.execPath, [bundle, ...args], { encoding: "utf8" });
	const transcript = execFileSync(
		"script",
		["-qe", "-c", process.execPath + " " + bundle + " login opencode --provider chatgpt", "/dev/null"],
		{ encoding: "utf8", timeout: 90000, input: "" },
	);
	assert.match(transcript, /https:\/\/auth.openai.com\/codex\/device/);
	assert.match(transcript, /ABCD-EFGH/);
	assert.match(transcript, /signed in/i);
	assert.ok(!transcript.includes(token));
	await owner.loginChanged(true);
	assert.ok(owner.report().harnesses[0].options.models.some(m => m.id.startsWith("openai/")));
	ok("Native terminal device challenge, approval and private credential transfer against a TLS fixture.");
	const first = await create("first"),
		second = await create("second");
	assert.deepEqual(JSON.parse(await cmd(["inspect", "--format", "{{json .HostConfig.LogConfig}}", relayName])), {
		Type: "json-file",
		Config: { "max-size": "4m", "max-file": "2" },
	});
	assert.equal(await cmd(["exec", first, "ls", "/sys/class/net"]), "lo");
	assert.match(await cmd(["exec", first, "printenv", "HTTPS_PROXY"]), /127.0.0.1:17891/);
	await cmd([
		"exec",
		"-d",
		second,
		"node",
		"-e",
		"require('http').createServer((q,r)=>r.end('peer')).listen(19123,'0.0.0.0')",
	]);
	assert.equal(
		await cmd([
			"exec",
			second,
			"curl",
			"--retry",
			"8",
			"--retry-connrefused",
			"--noproxy",
			"*",
			"-fsS",
			"http://127.0.0.1:19123",
		]),
		"peer",
	);
	assert.notEqual(
		(await docker(["exec", first, "curl", "--max-time", "2", "--noproxy", "*", "-fsS", "http://127.0.0.1:19123"])).code,
		0,
	);
	const other = saved.get(second).placeholder.access;
	const status = await cmd([
		"exec",
		first,
		"node",
		"-e",
		`fetch('http://127.0.0.1:17892/openai/responses',{method:'POST',headers:{authorization:'Bearer '+process.argv[1]}}).then(r=>console.log(r.status))`,
		other,
	]);
	assert.equal(status, "401");
	await turn(first, [], true);
	await turn(first, ["-e", "HTTPS_PROXY=http://127.0.0.1:1", "-e", "NO_PROXY="], false);
	assert.equal((await cmd(["logs", upstream])).split("\n").filter(s => s === "refresh").length, 1);
	ok(
		"Restricted ACP streams through the relay after OAuth expiry. Process, file and Docker env scans pass. Peer bearer refused.",
	);
	const waiting = await beginProviderLogin(owner);
	cli("logout", "opencode");
	await owner.loginChanged(false);
	assert.deepEqual(owner.report().harnesses[0].options.models, catalog.models);
	await assert.rejects(storeProvider(owner, { provider: "openai", key: token + "-key" }, waiting), /superseded/);
	assert.equal(await owner.ownedVolume(false, owner.opencodeVolume), false);
	assert.notEqual((await docker(["container", "inspect", relayName])).code, 0);
	execFileSync(process.execPath, [bundle, "login", "opencode", "--provider", "openai"], { input: token + "-key\n" });
	const open = executor("open");
	const third = await create("third", open);
	const revoked = await cmd([
		"exec",
		...saved.get(first).flags,
		first,
		"node",
		"-e",
		`fetch('http://127.0.0.1:17892/openai/responses',{method:'POST',headers:{authorization:'Bearer '+JSON.parse(process.env.OPENCODE_AUTH_CONTENT).openai.access}}).then(r=>console.log(r.status))`,
	]);
	assert.equal(revoked, "401", "a placeholder from before full logout must stay revoked");
	await channelTurn(open, "third", saved.get(third).id);
	assert.match(await cmd(["logs", upstream]), /authorized api.openai.com \/v1\/responses/);
	ok("Open API-key turn and resumed plan turn through the server harness and runner channel.");
	await storeProvider(owner, { provider: "anthropic", key: token + "-key" });
	await open.lifecycle("connect", saved.get(third).id, "third");
	await channelTurn(open, "third", saved.get(third).id);
	ok("The existing OpenCode sandbox takes its next turn after a second provider signs in.");
	const anth = await create("anthropic", open);
	await channelTurn(open, "anthropic", saved.get(anth).id, "anthropic/claude-opus-4-6");
	ok("Anthropic API-key turn over the runner session channel.");
	await storeProvider(owner, { provider: "free" });
	const free = await create("free", owner);
	await channelTurn(owner, "free", saved.get(free).id, freeModel);
	ok("Restricted free turn matched the native TLS request headers and public authorization.");
	await channelTurn(owner, "free", saved.get(free).id, "opencode/big-pickle", {
		reason: "usage_limit",
		message: "The provider's usage or rate limit was reached.",
	});
	ok("The pinned ACP harness surfaced the fixed 429 message and the platform classified it as a usage limit.");
	await storeProvider(owner, { provider: "opencode-go", key: token + "-go" });
	await storeProvider(owner, { provider: "zai-coding-plan", key: token + "-glm" });
	const both = await create("both", owner);
	const blocked = await docker([
		"exec",
		both,
		"curl",
		"--max-time",
		"5",
		"-sS",
		"--noproxy",
		"",
		"-x",
		"http://127.0.0.1:17891",
		"-o",
		"/dev/null",
		"-w",
		"%{http_connect}",
		"https://api.z.ai/",
	]);
	assert.equal(blocked.stdout.trim(), "403");
	await channelTurn(owner, "both", saved.get(both).id, "opencode-go/kimi-k3");
	await channelTurn(owner, "both", saved.get(both).id, "zai-coding-plan/glm-5.3");
	const log = await cmd(["logs", upstream]);
	assert.match(log, /authorized opencode.ai \/inference\/go\/openai\/v1\/chat\/completions/);
	assert.match(log, /authorized api.z.ai \/api\/coding\/paas\/v4\/chat\/completions/);
	await turn(both, [], true, "opencode-go/kimi-k3");
	await toolsTurn(both, "opencode-go/kimi-k3");
	ok(
		"A builder turn through wlp-acp-mcp reached report and ask_person over MCP; a process without the token was refused.",
	);
	await pushTurn(both, "opencode-go/kimi-k3");
	ok(
		"A person's turn through wlp-acp-mcp reached push, fetch_base and publish over MCP without asking; another branch was refused, and a publish answered after 70 s reached the model.",
	);
	ok(
		"Two stored providers, native Go and GLM streaming in one restricted sandbox, blocked direct CONNECT, placeholder scans.",
	);
	await storeProvider(owner);
}
try {
	await check();
} catch (error) {
	const logs = await docker(["logs", upstream]);
	if (!logs.stderr.includes(token)) process.stderr.write(logs.stderr);
	throw error;
} finally {
	adapter?.stdin.end();
	const filters = Object.entries(owner.labels).flatMap(([key, value]) => ["--filter", "label=" + key + "=" + value]);
	for (const id of (await cmd(["ps", "-aq", ...filters])).split(/\s+/).filter(Boolean)) await cmd(["rm", "-fv", id]);
	for (const name of [relayName, upstream, native]) await docker(["rm", "-fv", name]);
	for (const vol of (await cmd(["volume", "ls", "-q", ...filters])).split(/\s+/).filter(Boolean))
		await cmd(["volume", "rm", vol]);
	for (const net of (await cmd(["network", "ls", "-q", ...filters])).split(/\s+/).filter(Boolean))
		await cmd(["network", "rm", net]);
	await cmd(["network", "rm", uplink]);
	await rm(dir, { recursive: true, force: true });
}
