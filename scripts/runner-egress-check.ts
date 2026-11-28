// Fast regressions, run from server with tsx ../scripts/runner-egress-check.ts.
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLONE_GIT_START, cloneScript } from "../server/src/github/git.js";
import { parseRunnerFrame } from "../server/src/runner/control.js";
import { machineProfiles } from "../server/src/machines/profiles.js";

const report = {
	kind: "report",
	docker: { ok: true },
	commandSandbox: { ok: true },
	freeDiskBytes: null,
	sandboxes: [],
} as const;
test("the wire accepts each egress mode and older reports", () => {
	for (const egress of [undefined, "open", "restricted", "none"])
		assert.ok(
			parseRunnerFrame(JSON.stringify({ ...report, egress, name: "Test machine", claudeRelay: true })),
			String(egress),
		);
	assert.ok(parseRunnerFrame(JSON.stringify(report)));
	assert.equal(parseRunnerFrame(JSON.stringify({ ...report, egress: "other" })), null);
});
test("machine profiles describe command networking separately from model networking", () => {
	for (const mode of ["restricted", "none", "open"] as const) {
		const [inner, hardened] = machineProfiles("fixture", { ...report, sandboxes: [], egress: mode });
		assert.equal(inner.commandNetwork, false);
		assert.equal(hardened.commandNetwork, mode !== "none");
		assert.match(
			hardened.commandNetworkText!,
			mode === "restricted" ? /public/ : mode === "none" ? /no network/ : /local network/,
		);
	}
});
test("new pairing, migration, persisted opt-in and invalid owner flags", async () => {
	const dir = mkdtempSync(join(tmpdir(), "egress-state-"));
	process.env.WLP_RUNNER_STATE_DIR = dir;
	try {
		const state = await import("../runner/src/state.js");
		const policy = await import("../runner/src/egress-policy.js");
		const identity = { machineId: "m_0000000000000001", uid: "u_test" };
		state.storePair(identity, generateKeyPairSync("ed25519").privateKey, "https://example.com");
		assert.equal(state.pairingEgress(identity.machineId).mode, "restricted");
		const legacy = "m_0000000000000002";
		assert.equal(state.pairingEgress(legacy).mode, "open");
		assert.match(state.egressNote(legacy), /--egress restricted/);
		const requested = policy.egressFlags("restricted", "Mirror.Example,git.example");
		assert.deepEqual(requested, { mode: "restricted", allow: ["git.example", "mirror.example"] });
		state.pairingEgress(legacy, requested);
		assert.deepEqual(state.pairingEgress(legacy), requested);
		assert.doesNotMatch(state.egressNote(legacy), /--egress restricted/);
		for (const [mode, hosts] of [
			["bad", undefined],
			["none", "host"],
			["restricted", "*.lan"],
			["restricted", "http://x/"],
		]) {
			assert.throws(() => policy.egressFlags(mode, hosts));
		}
		// An owner's list of public hosts is kept, shown expanded with the platform's hosts, and emptied by
		// --egress without it, which says so.
		const listed = "m_0000000000000003";
		const printed: string[] = [];
		const log = console.log;
		console.log = (line: string) => {
			printed.push(line);
		};
		try {
			state.pairingEgress(listed, policy.egressFlags("restricted", "git.internal", "@npm")!);
			state.pairingEgress(listed, policy.egressFlags("restricted", "git.internal", "@npm")!);
			assert.deepEqual(printed, [], "kept the list");
			assert.deepEqual(state.pairingEgress(listed), {
				mode: "restricted",
				allow: ["git.internal"],
				domains: ["registry.npmjs.org", "registry.yarnpkg.com"],
			});
			assert.equal(
				state.egressNote(listed),
				"Network egress is restricted. Only these public hosts: api.openai.com (always: Windlass's model requests use it; refused to commands in Codex and OpenCode sessions), github.com (always until the platform names its git host: the platform's git uses it), registry.npmjs.org, registry.yarnpkg.com. Allowed hosts: git.internal",
			);
			state.pairingEgress(listed, policy.egressFlags("restricted", "git.internal")!);
			assert.deepEqual(printed, [state.DOMAINS_REMOVED]);
			assert.match(printed[0]!, /--egress-domains list was removed/);
			assert.equal(state.pairingEgress(listed).domains, undefined);
			state.pairingEgress(listed, policy.egressFlags("restricted")!);
			assert.equal(printed.length, 1, "no list, nothing removed");
		} finally {
			console.log = log;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
test("proxy pins DNS results, fails closed on mixed answers, and scopes private exceptions", async () => {
	// @ts-expect-error the standalone program also runs directly in the pinned sandbox image
	const { selectAddress } = await import("../runner/src/egress-proxy.mjs");
	const check = (ips: string[], allow: string[] = [], host = "mirror.example", local: string[] = []) =>
		selectAddress(host, allow, async () => ips.map(address => ({ address })), {
			eth0: local.map(address => ({ address })),
		});
	for (const ip of [
		"127.0.0.1",
		"0.0.0.0",
		"169.254.169.254",
		"169.254.1.2",
		"100.64.0.1",
		"10.0.0.1",
		"172.31.1.1",
		"192.168.1.1",
		"fc00::1",
		"fd00:ec2::254",
		"fe80::1",
		"::ffff:a00:1",
		"2002:a00:1::1",
	]) {
		await assert.rejects(check([ip]), /blocked/);
	}
	await assert.rejects(check(["1.1.1.1", "10.0.0.1"]), /blocked/);
	assert.equal(await check(["1.1.1.1"]), "1.1.1.1");
	assert.equal(await check(["10.0.0.1"], ["mirror.example"]), "10.0.0.1");
	await assert.rejects(check(["169.254.169.254"], ["mirror.example"]), /blocked/);
	await assert.rejects(check(["8.8.8.8"], [], "mirror.example", ["8.8.8.8"]), /blocked/);
});
test("both harness providers construct the same runner-owned network configuration", async () => {
	Object.assign(globalThis, { SANDBOX_IMAGE: "fixture", SHOTS_IMAGE_PIN: "", HARNESS_IMAGES: { claude: "fixture" } });
	const { Executor } = await import("../runner/src/docker-executor.js");
	for (const mode of ["restricted", "none", "open"] as const) {
		const owner = new Executor({ uid: "u_fixture", machineId: "m_fixture" }, {}, false, true, ["docker-hardened"], {
			mode,
			allow: [],
		});
		// The wire form: JSON drops a field the report left undefined, such as a signed-out loginGeneration.
		const frame = JSON.parse(JSON.stringify({ ...owner.report(), name: "Build runner" }));
		assert.equal(frame.egress, mode);
		assert.equal(frame.claudeRelay, true);
		assert.ok(frame.host && frame.host.cpus > 0 && frame.host.memoryBytes > 0);
		assert.deepEqual(parseRunnerFrame(JSON.stringify(frame)), frame);
		const { host, ...beforeCapacity } = frame;
		assert.deepEqual(parseRunnerFrame(JSON.stringify(beforeCapacity)), beforeCapacity);
		const flags = owner.network.sandboxNetwork();
		assert.equal(flags.name, mode === "open" ? "wlp-open-m_fixture" : "none");
		for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"])
			assert.equal(flags.env[key], mode === "restricted" ? "http://127.0.0.1:17891" : undefined);
		assert.equal(flags.env.NO_PROXY, mode === "restricted" ? "localhost,127.0.0.1,::1" : undefined);
	}
});
test("restoring a kept restricted session prepares the current helper image pin", async () => {
	const { Executor } = await import("../runner/src/docker-executor.js");
	const dir = mkdtempSync(join(tmpdir(), "egress-upgrade-"));
	const path = process.env.PATH;
	try {
		writeFileSync(
			join(dir, "docker"),
			'#!/bin/sh\nif [ "$1" = container ]; then echo "No such container" >&2; fi\nexit 1\n',
			{ mode: 0o700 },
		);
		process.env.PATH = dir + ":" + path;
		const owner = new Executor({ uid: "u_test", machineId: "m_fixture" }, {}, false, false, ["docker-hardened"], {
			mode: "restricted",
			allow: [],
		});
		owner.ownedVolume = async () => true;
		const pulling = new Error("fetch current helper pin");
		owner.ensureImage = async () => {
			throw pulling;
		};
		await assert.rejects(owner.network.attach("0123456789ab", "fixture"), error => error === pulling);
	} finally {
		process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("both platform clone paths hand only the runner proxy to clean Git", () => {
	const dir = mkdtempSync(join(tmpdir(), "clean-git-"));
	try {
		// Inspect the clean environment at the point where the shell would exec Git.
		const inspect = `env() { local args=(); while [ "$1" != git ]; do args+=("$1"); shift; done; command env "\${args[@]}" /usr/bin/env; exit 72; }`;
		for (const script of [
			CLONE_GIT_START + "\ngit clone fixture",
			cloneScript("https://example.invalid/repo", "main", "repo"),
		]) {
			for (const proxy of ["http://127.0.0.1:17891", "http://untrusted.invalid"]) {
				const result = spawnSync(
					"bash",
					[
						"-ec",
						inspect +
							"\n" +
							script.replace("/tmp/wlp-transport-repo", join(dir, proxy.includes("127.0.0.1") ? "known" : "unknown")),
					],
					{
						cwd: dir,
						input: "fixture-token\n",
						encoding: "utf8",
						env: { https_proxy: proxy, SECRET: "fixture-secret" },
					},
				);
				assert.equal(result.status, 72, result.stderr);
				assert.doesNotMatch(result.stdout, /fixture-secret|fixture-token|untrusted/);
				if (proxy.includes("127.0.0.1")) assert.match(result.stdout, /^https_proxy=http:\/\/127\.0\.0\.1:17891$/m);
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the restricted OpenCode broker refuses registry and login hosts before DNS, and retains repository egress", async () => {
	// @ts-expect-error the standalone program also runs directly in the pinned sandbox image
	const { selectAddress } = await import("../runner/src/egress-proxy.mjs");
	const { providerHosts } = await import("../runner/src/opencode-providers.js");
	const check = (host: string, policy: string[]) =>
		selectAddress(host, [], async () => [{ address: "8.8.8.8" }], {}, policy);
	for (const host of ["OPENCODE.AI.", "api.z.ai", "open.bigmodel.cn", "chatgpt.com", "auth.openai.com", "8.8.8.8"])
		await assert.rejects(check(host, providerHosts), /blocked/);
	assert.equal(await check("github.com", providerHosts), "8.8.8.8");
	assert.equal(await check("opencode.ai", []), "8.8.8.8");
});

test("--egress-domains: presets as hosted names them, the platform's hosts always, and refused lists", async () => {
	const policy = await import("../runner/src/egress-policy.js");
	const { PRESETS } = await import("../server/src/sandbox/hosted-network.js");
	const listed = policy.egressFlags(undefined, undefined, "@npm, @github, *.Example.org.")!;
	assert.equal(listed.mode, "restricted");
	assert.deepEqual(listed.domains, [...new Set(["*.example.org", ...PRESETS["@npm"]!, ...PRESETS["@github"]!])].sort());
	assert.deepEqual(policy.egressFlags("restricted", undefined, "registry.npmjs.org")!.domains, ["registry.npmjs.org"]);
	assert.deepEqual(policy.listedHosts(["registry.npmjs.org"]), ["api.openai.com", "github.com", "registry.npmjs.org"]);
	const most = policy.egressFlags(
		"restricted",
		undefined,
		Array.from({ length: 62 }, (_, i) => `h${i}.example`).join(","),
	)!.domains!;
	assert.equal(policy.listedHosts(most).length, 64);
	assert.equal(
		policy.listedHosts(most, "git.example.com").length,
		64,
		"the platform's git host takes github.com's place",
	);
	assert.equal(policy.egressFlags("restricted")!.domains, undefined);
	const many = Array.from({ length: 63 }, (_, i) => `h${i}.example`).join(",");
	for (const [mode, domains] of [
		["restricted", many],
		["restricted", "93.184.216.34"],
		["restricted", "*.com"],
		["restricted", "*.com."],
		["restricted", "com"],
		["restricted", "a..example"],
		["restricted", "@nope"],
		["restricted", "https://registry.npmjs.org"],
		["restricted", "registry.npmjs.org:443"],
		["restricted", "*.*.example.org"],
		["open", "@npm"],
		["none", "@npm"],
	])
		assert.throws(
			() => policy.egressFlags(mode, undefined, domains),
			new RegExp(mode === "restricted" || domains === "@npm" ? "--egress-domains" : ""),
			`${mode} ${domains}`,
		);
});

test("with a list, the proxy matches the name before DNS, keeps every range blocked and limits ports", async () => {
	// @ts-expect-error the standalone program also runs directly in the pinned sandbox image
	const { targetAddress, listedHost } = await import("../runner/src/egress-proxy.mjs");
	const domains = ["github.com", "registry.npmjs.org", "*.githubusercontent.com"];
	const asked: string[] = [];
	const check = (
		target: string,
		tunnel: boolean,
		ips = ["104.16.1.1"],
		list: string[] | null = domains,
		allow: string[] = [],
	) =>
		targetAddress(
			new URL(tunnel ? "http://" + target : target),
			tunnel,
			allow,
			[],
			list,
			false,
			async (host: string) => {
				asked.push(host);
				return ips.map(address => ({ address }));
			},
			{},
		);
	await assert.rejects(check("evil.example:443", true), /blocked/);
	await assert.rejects(check("http://evil.example/", false), /blocked/);
	assert.deepEqual(asked, [], "an unlisted name reached the resolver");
	assert.equal(await check("registry.npmjs.org:443", true), "104.16.1.1");
	assert.equal(await check("REGISTRY.npmjs.org.:443", true), "104.16.1.1");
	assert.equal(await check("http://registry.npmjs.org/x", false), "104.16.1.1");
	assert.equal(await check("objects.githubusercontent.com:443", true), "104.16.1.1");
	for (const target of [
		"githubusercontent.com:443",
		"x.githubusercontent.com.evil.example:443",
		"xgithubusercontent.com:443",
		"93.184.216.34:443",
		"[2606:2800::1]:443",
		"registry.npmjs.org:8443",
		"registry.npmjs.org:80",
	])
		await assert.rejects(check(target, true), /blocked/, target);
	for (const target of ["http://registry.npmjs.org:8080/", "http://93.184.216.34/", "http://registry.npmjs.org:443/"])
		await assert.rejects(check(target, false), /blocked/, target);
	for (const ip of ["10.0.0.5", "169.254.169.254", "127.0.0.1"])
		await assert.rejects(check("registry.npmjs.org:443", true, [ip]), /blocked/, ip);
	assert.equal(
		asked.every(host => domains.includes(host) || host === "objects.githubusercontent.com"),
		true,
		asked.join(),
	);
	// A private name the owner allows passes the list too, as with --egress-allow alone, but only to the private
	// network: an allowed name that answers with a public address is no way past the list.
	assert.equal(await check("git.internal:443", true, ["10.0.0.5"], domains, ["git.internal"]), "10.0.0.5");
	for (const ips of [["93.184.216.34"], ["10.0.0.5", "93.184.216.34"], ["2606:2800::1"]])
		await assert.rejects(check("git.internal:443", true, ips, domains, ["git.internal"]), /blocked/, ips.join());
	assert.equal(
		await check("registry.npmjs.org:443", true, ["10.0.0.5"], domains, ["registry.npmjs.org"]),
		"10.0.0.5",
		"a listed name the owner also allows",
	);
	assert.equal(
		await check("git.internal:443", true, ["93.184.216.34"], null, ["git.internal"]),
		"93.184.216.34",
		"without a list, as before",
	);
	// Names under a wildcard are checked label by label, as the list's own entries are, before DNS.
	asked.length = 0;
	for (const name of [
		"a..objects.githubusercontent.com",
		".githubusercontent.com",
		"-a.githubusercontent.com",
		"a-.githubusercontent.com",
		"a_b.githubusercontent.com",
		"a".repeat(64) + ".githubusercontent.com",
		("a".repeat(63) + ".").repeat(4) + "githubusercontent.com",
	]) {
		assert.equal(listedHost(name, domains), false, name);
		await assert.rejects(check("http://" + name + "/", false), /blocked/, name);
	}
	assert.deepEqual(asked, [], "a malformed name reached the resolver");
	assert.equal(listedHost("a-b.c0.githubusercontent.com", domains), true);
	// Without a list: today's behaviour, any public name and any port.
	assert.equal(await check("evil.example:8443", true, ["93.184.216.34"], null), "93.184.216.34");
	assert.equal(await check("http://evil.example:8080/", false, ["93.184.216.34"], null), "93.184.216.34");
	assert.equal(listedHost("", domains), false);
});

/** A ClientHello in one record, with these extensions. */
function hello(extensions: [number, Buffer][]) {
	const ext = Buffer.concat(
		extensions.map(([type, body]) =>
			Buffer.concat([Buffer.from([type >> 8, type & 255, body.length >> 8, body.length & 255]), body]),
		),
	);
	const body = Buffer.concat([
		Buffer.from([3, 3]),
		Buffer.alloc(32, 7),
		Buffer.from([0]),
		Buffer.from([0, 2, 0x13, 0x01]),
		Buffer.from([1, 0]),
		Buffer.from([ext.length >> 8, ext.length & 255]),
		ext,
	]);
	const handshake = Buffer.concat([Buffer.from([1, 0, body.length >> 8, body.length & 255]), body]);
	return Buffer.concat([Buffer.from([0x16, 3, 1, handshake.length >> 8, handshake.length & 255]), handshake]);
}
function sni(...names: string[]) {
	const list = Buffer.concat(
		names.map(name => Buffer.concat([Buffer.from([0, name.length >> 8, name.length & 255]), Buffer.from(name)])),
	);
	return Buffer.concat([Buffer.from([list.length >> 8, list.length & 255]), list]);
}
test("the ClientHello parser takes exactly one server name and refuses the rest", async () => {
	// @ts-expect-error the standalone program also runs directly in the pinned sandbox image
	const { clientHelloName } = await import("../runner/src/egress-proxy.mjs");
	// A real ClientHello, from Node's own TLS client.
	const { createServer } = await import("node:net");
	const tls = await import("node:tls");
	const real = await new Promise<Buffer>((done, fail) => {
		const server = createServer(socket =>
			socket.once("data", chunk => {
				done(chunk);
				socket.destroy();
				server.close();
			}),
		).listen(0, "127.0.0.1", () => {
			const port = (server.address() as import("node:net").AddressInfo).port;
			tls.connect({ host: "127.0.0.1", port, servername: "registry.npmjs.org" }).on("error", () => {});
		});
		server.on("error", fail);
	});
	assert.equal(clientHelloName(real), "registry.npmjs.org");
	for (let cut = 0; cut < real.length; cut += 37)
		assert.equal(clientHelloName(real.subarray(0, cut)), undefined, String(cut));
	assert.equal(clientHelloName(hello([[0, sni("Registry.NPMJS.org")]])), "registry.npmjs.org");
	assert.equal(clientHelloName(hello([[10, Buffer.from([0, 2, 0, 29])]])), null, "no name");
	assert.equal(clientHelloName(hello([[0, sni("a.example", "b.example")]])), null, "two names");
	assert.equal(
		clientHelloName(
			hello([
				[0, sni("a.example")],
				[0, sni("a.example")],
			]),
		),
		null,
		"two server_name extensions",
	);
	for (let type = 0xfe00; type <= 0xfe0d; type++)
		assert.equal(
			clientHelloName(
				hello([
					[0, sni("a.example")],
					[type, Buffer.alloc(8)],
				]),
			),
			null,
			"Encrypted Client Hello " + type.toString(16),
		);
	assert.equal(
		clientHelloName(
			hello([
				[0, sni("a.example")],
				[0xffce, Buffer.alloc(8)],
			]),
		),
		null,
		"Encrypted Client Hello ffce",
	);
	for (const type of [0xfdff, 0xfe0e, 0xffcd])
		assert.equal(
			clientHelloName(
				hello([
					[0, sni("a.example")],
					[type, Buffer.alloc(8)],
				]),
			),
			"a.example",
			type.toString(16),
		);
	assert.equal(clientHelloName(hello([[0, sni("a.example\u0000.evil")]])), null, "a name with a NUL");
	assert.equal(clientHelloName(Buffer.from("GET / HTTP/1.1\r\n\r\n")), null, "not TLS");
	const past = Buffer.from(real);
	past[8] = 0xff; // the handshake length, past its record
	assert.equal(clientHelloName(past), null);
	const huge = Buffer.from(real);
	huge.writeUInt16BE(16385, 3);
	assert.equal(clientHelloName(huge), null);
	const fake = hello([[0, sni("a.example")]]);
	fake.writeUInt16BE(fake.readUInt16BE(9 + 2 + 32 + 1) + 2, 9 + 2 + 32 + 1); // the cipher suites' length, past the hello
	assert.equal(clientHelloName(fake), null);
	// Random and mutated input: nothing escapes, and every answer is a name, null or "wait".
	let seed = 7;
	const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
	for (let i = 0; i < 10_000; i++) {
		const data =
			i % 2
				? Buffer.from(Array.from({ length: Math.floor(next() * 600) }, () => Math.floor(next() * 256)))
				: Buffer.from(real);
		if (i % 2 === 0) for (let k = 0; k < 4; k++) data[Math.floor(next() * data.length)] = Math.floor(next() * 256);
		if (i % 4 === 1) data[0] = 0x16;
		const name = clientHelloName(data);
		assert.ok(name === undefined || name === null || /^[a-z0-9.-]+$/.test(name), String(name));
	}
});

test("the report names the list's size only to a server that reads it", async () => {
	const { reportFor } = await import("../server/src/runner/control.js");
	const listed: import("../server/src/runner/control.js").Report = {
		...report,
		sandboxes: [],
		egress: "restricted",
		egressDomains: 3,
	};
	assert.ok(parseRunnerFrame(JSON.stringify(listed)));
	for (const bad of [0, 65, 1.5, "3"])
		assert.equal(parseRunnerFrame(JSON.stringify({ ...listed, egressDomains: bad })), null, String(bad));
	assert.equal("egressDomains" in reportFor(listed, ["git-mirrors"]), false);
	assert.equal(reportFor(listed, ["egress-domains"]).egressDomains, 3);
	const [, hardened] = machineProfiles("fixture", { ...listed, sandboxes: [] });
	assert.equal(
		hardened.commandNetworkText,
		"commands can reach only the 3 public hosts the owner allows, through the web proxy",
	);
});

test("a wildcard on a public suffix is refused, with the reason", async () => {
	const policy = await import("../runner/src/egress-policy.js");
	const { PUBLIC_SUFFIX_VERSION } = await import("../runner/src/public-suffixes.js");
	assert.match(PUBLIC_SUFFIX_VERSION, /^\d{4}-\d{2}-\d{2}_/);
	for (const entry of [
		"*.co.uk",
		"*.github.io",
		"*.s3.amazonaws.com",
		"*.amazonaws.com",
		"*.workers.dev",
		"*.vercel.app",
		"*.appspot.com",
		"*.blob.core.windows.net",
		"*.ngrok-free.app",
		"*.githubusercontent.com",
		"*.herokuapp.com",
		"*.ward.kobe.jp",
		"*.x.compute.amazonaws.com",
	]) {
		assert.throws(
			() => policy.egressFlags("restricted", undefined, entry),
			(error: Error) => /public suffix/.test(error.message) && error.message.includes(entry),
			entry,
		);
	}
	assert.throws(() => policy.egressFlags("restricted", undefined, "*.amazonaws.com"), /under it, is a public suffix/);
	// Names under a suffix are one owner's, and an exact host is one host.
	for (const entry of [
		"*.example.org",
		"*.example.co.uk",
		"*.npmjs.org",
		"*.mycompany.github.io",
		"*.city.kobe.jp",
		"github.io",
		"s3.amazonaws.com",
		"objects.githubusercontent.com",
	])
		assert.ok(policy.egressFlags("restricted", undefined, entry), entry);
	assert.equal(policy.sharedSuffix("example.org"), undefined);
});

test("the welcome names the platform's git host to a runner that reads it, and the list takes it", async () => {
	const { GIT_HOST_RUNNER_VERSION, parseServerFrame, welcomeCapabilities } = await import(
		"../server/src/runner/control.js"
	);
	assert.equal(welcomeCapabilities(GIT_HOST_RUNNER_VERSION, "https://git.example.com").gitHost, "git.example.com");
	assert.equal(welcomeCapabilities("1.0.0", "https://GitHub.com/").gitHost, "github.com");
	assert.equal(
		"gitHost" in welcomeCapabilities("0.2.0", "https://git.example.com"),
		false,
		"an older runner refuses unknown keys",
	);
	assert.equal(
		"gitHost" in welcomeCapabilities("0.3.0", "https://git.example.com"),
		false,
		"runner 0.3.0 shipped before gitHost and refuses unknown keys",
	);
	for (const url of [
		"http://git.example.com",
		"https://git.example.com:8443",
		"https://10.0.0.5",
		"not a url",
		undefined,
	])
		assert.equal("gitHost" in welcomeCapabilities("1.0.0", url), false, String(url));
	const welcome = { kind: "welcome", idleSuspendMs: 1000, capabilities: ["git-mirrors"] };
	assert.ok(parseServerFrame(JSON.stringify({ ...welcome, gitHost: "git.example.com" })));
	assert.ok(parseServerFrame(JSON.stringify(welcome)));
	for (const bad of ["GIT.example.com", "localhost", "10.0.0.5", "a..example.com", "", 5])
		assert.equal(parseServerFrame(JSON.stringify({ ...welcome, gitHost: bad })), null, String(bad));
	Object.assign(globalThis, { SANDBOX_IMAGE: "fixture", SHOTS_IMAGE_PIN: "", HARNESS_IMAGES: { claude: "fixture" } });
	const { Executor } = await import("../runner/src/docker-executor.js");
	const owner = new Executor({ uid: "u_fixture", machineId: "m_fixture" }, {}, false, false, ["docker-hardened"], {
		mode: "restricted",
		allow: [],
		domains: ["registry.npmjs.org"],
	});
	assert.deepEqual(owner.network.domains(), ["api.openai.com", "github.com", "registry.npmjs.org"]);
	const log = console.log;
	const printed: string[] = [];
	console.log = (line: string) => {
		printed.push(line);
	};
	// The note also goes to the audit log, in the state directory an earlier test removed.
	const dir = process.env.WLP_RUNNER_STATE_DIR!;
	mkdirSync(dir, { recursive: true });
	try {
		owner.network.platformGitHost("git.example.com");
	} finally {
		console.log = log;
		rmSync(dir, { recursive: true, force: true });
	}
	assert.deepEqual(owner.network.domains(), ["api.openai.com", "git.example.com", "registry.npmjs.org"]);
	assert.match(printed.join(), /git host is git\.example\.com/);
	assert.equal(owner.report().egressDomains, 3);
	owner.network.platformGitHost(undefined);
	assert.deepEqual(
		owner.network.domains(),
		["api.openai.com", "github.com", "registry.npmjs.org"],
		"an older platform",
	);
});

test("proxy refusals carry only bounded destination counts, reasons and times", async () => {
	// @ts-expect-error the broker runs as a standalone program in the helper image
	const { proxyServer, refusalLedger, targetAddress } = await import("../runner/src/egress-proxy.mjs");
	const { request } = await import("node:http");
	const counts = refusalLedger();
	const proxy = proxyServer([], ["provider.example"], false, [], counts.record).listen(0, "127.0.0.1");
	await once(proxy, "listening");
	try {
		const ask = async (path: string, method: string) => {
			const req = request({
				port: proxy.address().port,
				host: "127.0.0.1",
				path,
				method,
				headers: { "X-Test": "header-secret" },
			});
			const answer = once(req, method === "CONNECT" ? "connect" : "response");
			req.end(method === "POST" ? "body-secret" : undefined);
			const [res, socket] = await answer;
			assert.equal(res.statusCode, 403);
			socket?.destroy();
			res.resume();
		};
		await ask("http://Registry.Example./private-path?token=query-secret", "POST");
		await ask("http://registry.example/again", "GET");
		await ask("provider.example:443", "CONNECT");
		await ask("169.254.169.254:443", "CONNECT");
		await ask("bad:authority/private-path", "CONNECT");
		const snapshot = counts.read(1);
		assert.deepEqual(
			snapshot.hosts.map(
				({
					host,
					port,
					reason,
					count,
				}: {
					host: string | null;
					port: number | null;
					reason: string;
					count: number;
				}) => [host, port, reason, count],
			),
			[
				["registry.example", 80, "machine_policy", 2],
				["provider.example", 443, "provider", 1],
				["169.254.169.254", 443, "private", 1],
				[null, null, "malformed", 1],
			],
		);
		assert.doesNotMatch(JSON.stringify(snapshot), /private-path|token|secret|again|authority/);
		assert.ok(
			snapshot.hosts.every(
				(entry: { firstAt: number; lastAt: number }) => entry.firstAt > 0 && entry.lastAt >= entry.firstAt,
			),
		);
		await assert.rejects(
			targetAddress(
				new URL("http://listed.example"),
				false,
				[],
				[],
				["listed.example"],
				false,
				async () => [{ address: "10.0.0.4" }],
				{},
			),
			{ reason: "private" },
		);
		for (let i = 0; i < 47; i++) counts.record(new URL("http://h" + i + ".example"), "machine_policy", 1000 + i);
		counts.record(new URL("http://h46.example"), "machine_policy", 2000);
		counts.record(new URL("http://registry.example"), "machine_policy", Date.now());
		assert.equal(counts.read(1).hosts.length, 50);
		assert.equal(counts.read(1).overflow, 2);
		assert.equal(counts.read(1).hosts[0].count, 3);
		assert.deepEqual(counts.read(2), { hosts: [], overflow: 0 });
		counts.record(new URL("http://registry.example"), "private", 3000);
		counts.record(new URL("http://h46.example"), "machine_policy", 3001);
		assert.equal(counts.read(2).hosts[0].count, 1);
		assert.equal(counts.read(2).overflow, 1);
		assert.deepEqual(counts.read(1), { hosts: [], overflow: 0 }, "a late old turn cannot reset the ledger");
		const replacement = refusalLedger();
		replacement.record(new URL("http://new.example"), "machine_policy", 10);
		replacement.record(new URL("http://registry.example"), "machine_policy", 11);
		replacement.read(
			3,
			snapshot.hosts.concat(Array.from({ length: 46 }, (_, i) => ({ host: "prior" + i + ".example", port: 80 }))),
		);
		replacement.record(new URL("http://new.example"), "machine_policy");
		replacement.record(new URL("http://registry.example"), "machine_policy");
		assert.equal(replacement.read(3).overflow, 2);
		assert.equal(replacement.read(3).hosts[0].firstAt, 11);
		assert.equal(replacement.read(3).hosts[0].count, 2);
		assert.equal(replacement.read(3).hosts[0].host, "registry.example");
	} finally {
		proxy.close();
	}
});

test("the runner samples the observation socket with curl in the broker", async () => {
	const { createServer } = await import("node:http");
	const { Executor } = await import("../runner/src/docker-executor.js");
	const dir = mkdtempSync(join(tmpdir(), "observe-"));
	const path = process.env.PATH;
	const id = "a".repeat(64);
	const owner = new Executor({ uid: "u_fixture", machineId: "m_fixture" }, {}, false, false, ["docker-hardened"], {
		mode: "restricted",
		allow: [],
	});
	const labels = { ...owner.labels, "dev.windlass-platform": "1", "dev.windlass-platform.egress-helper": "broker" };
	const received: unknown[] = [];
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		received.push([req.method, req.url, JSON.parse(body)]);
		res.end(JSON.stringify({ hosts: [], overflow: 3 }));
	});
	try {
		server.listen(join(dir, "observe.sock"));
		await once(server, "listening");
		// Execute the real curl argv against the fixture socket in place of the broker's mount.
		writeFileSync(
			join(dir, "docker"),
			`#!/bin/bash
set -eu
if [[ $1 = container ]]; then echo '${id}|true|${JSON.stringify(labels)}'; exit; fi
[[ $1 = exec && $2 = -i && $3 = ${id} && $4 = curl ]]
shift 4
args=()
for arg do
  if [[ $arg = /workspace/observe.sock ]]; then arg="$(dirname "$0")/observe.sock"; fi
  args+=("$arg")
done
exec curl "\${args[@]}"
`,
			{ mode: 0o700 },
		);
		process.env.PATH = dir + ":" + path;
		const retained = [{ host: "known.example", port: 443 }];
		assert.deepEqual(await owner.network.blocked("fixture", 7, retained), { broker: id, hosts: [], overflow: 3 });
		assert.deepEqual(received, [["POST", "/7", retained]]);
	} finally {
		process.env.PATH = path;
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("migration removes the legacy brokers and their named socket volumes", async () => {
	const { Executor } = await import("../runner/src/docker-executor.js");
	const dir = mkdtempSync(join(tmpdir(), "egress-migrate-"));
	const path = process.env.PATH;
	const owner = new Executor({ uid: "u_fixture", machineId: "m_fixture" }, {}, false, false, ["docker-hardened"], {
		mode: "restricted",
		allow: [],
	});
	const labels = { ...owner.labels, "dev.windlass-platform": "1", "dev.windlass-platform.egress-helper": "broker" };
	const prefix = "wlp-egress-m_fixture";
	const legacy = [prefix, prefix + "-codex-broker", prefix + "-opencode-broker"];
	const dropped: string[] = [];
	owner.dropVolume = async name => {
		dropped.push(name!);
	};
	try {
		// The OpenCode broker is already gone, as after an interrupted migration.
		writeFileSync(
			join(dir, "docker"),
			`#!/bin/sh
case "$1" in
  ps) echo '${legacy.slice(0, 2).join("\n")}' ;;
  container) echo "id-$5|true|"'${JSON.stringify(labels)}' ;;
  rm) echo "$3" >> "$(dirname "$0")/removed" ;;
  *) exit 1 ;;
esac
`,
			{ mode: 0o700 },
		);
		process.env.PATH = dir + ":" + path;
		await owner.network.reconcile(new Set());
		assert.deepEqual(
			readFileSync(join(dir, "removed"), "utf8").trim().split("\n"),
			legacy.slice(0, 2).map(name => "id-" + name),
		);
		assert.deepEqual(
			dropped,
			legacy.map(name => name + "-socket"),
		);
	} finally {
		process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
	}
});
