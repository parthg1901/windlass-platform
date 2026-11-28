// Runs as agent in the immutable base image. Only the broker has an uplink.
// Both ends of the filesystem socket live in helpers, outside every agent mount namespace.
import { lookup } from "node:dns/promises";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { networkInterfaces } from "node:os";

function refuse(reason) {
	throw Object.assign(Error("blocked"), { reason });
}

const severity = { machine_policy: 0, malformed: 1, provider: 2, private: 3 };
/** Trusted broker memory. Keep the same 50 destination slots across turns, but report only this turn's counts. */
export function refusalLedger() {
	const slots = new Map();
	let turn = 0,
		overflow = 0;
	return {
		read(number, retained) {
			if (number > turn) {
				// Requests can arrive between attach and the first observer. Fit those counts around
				// the slots already reserved by this session, including on a replacement broker.
				const early = turn === 0 ? new Map(slots) : null;
				if (!early) overflow = 0;
				turn = number;
				// A resumed sandbox can have a fresh broker. Reserve the session's previously admitted slots.
				if (retained) {
					slots.clear();
					for (const { host, port } of retained) slots.set(JSON.stringify([host, port]), null);
				} else for (const key of slots.keys()) slots.set(key, null);
				if (early)
					for (const [key, entry] of early) {
						if (slots.has(key) || slots.size < 50) slots.set(key, entry);
						else overflow += entry.count;
					}
			}
			return number === turn ? { hosts: [...slots.values()].filter(Boolean), overflow } : { hosts: [], overflow: 0 };
		},
		record(url, reason, at = Date.now()) {
			const name = url?.hostname
				.replace(/^\[|\]$/g, "")
				.toLowerCase()
				.replace(/\.$/, "");
			const host =
				name && (net.isIP(name) || (name.length <= 253 && name.split(".").every(label => LABEL.test(label))))
					? name
					: null;
			const port = host
				? url.port
					? Number(url.port)
					: url.protocol === "http:"
						? 80
						: url.protocol === "https:"
							? 443
							: null
				: null;
			const key = JSON.stringify([host, port]);
			const entry = slots.get(key);
			if (entry) {
				entry.count++;
				entry.lastAt = at;
				if (severity[reason] > severity[entry.reason]) entry.reason = reason;
			} else if (slots.has(key) || slots.size < 50) {
				slots.set(key, { host, port, reason, firstAt: at, lastAt: at, count: 1 });
			} else overflow++;
		},
	};
}

const socket = "/workspace/egress.sock";
/** Where the model relay's forwarder says it holds its port: a tmpfs of the forwarder's own container. */
export const MODEL_FORWARD_READY = "/run/wlp-model/ready/listening";
function subnets(cidrs) {
	const list = new net.BlockList();
	for (const cidr of cidrs) {
		const [ip, prefix] = cidr.split("/");
		list.addSubnet(ip, Number(prefix), net.isIPv4(ip) ? "ipv4" : "ipv6");
	}
	return list;
}
const lan = subnets(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]);
const blocked = subnets([
	"0.0.0.0/8",
	"127.0.0.0/8",
	"100.64.0.0/10",
	"169.254.0.0/16",
	"168.63.129.16/32",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.88.99.0/24",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
	"fd00:ec2::/32",
	"fd20:ce::254/128",
	"2001::/23",
	"2001:db8::/32",
	"2002::/16",
]);
const globalV6 = subnets(["2000::/3"]);
// `privateOnly`: an --egress-allow name that is not on the owner's list of public hosts may reach only the private network.
export async function selectAddress(
	host,
	allow,
	resolve = lookup,
	interfaces = networkInterfaces(),
	denied = [],
	privateOnly = false,
) {
	if (denied.length && (net.isIP(host) || denied.includes(host.toLowerCase().replace(/\.$/, "")))) refuse("provider");
	const answers = net.isIP(host) ? [{ address: host }] : await resolve(host, { all: true });
	const hostAndBridges = new net.BlockList();
	for (const [name, entries] of Object.entries(interfaces)) {
		for (const { address, cidr } of entries ?? []) {
			const family = net.isIPv4(address) ? "ipv4" : "ipv6";
			hostAndBridges.addAddress(address, family);
			if (cidr && existsSync("/sys/class/net/" + name + "/bridge"))
				hostAndBridges.addSubnet(address, Number(cidr.split("/")[1]), family);
		}
	}
	for (const { address } of answers) {
		const family = net.isIPv4(address) ? "ipv4" : "ipv6";
		const privateLan = lan.check(address, family);
		if (
			!net.isIP(address) ||
			blocked.check(address, family) ||
			hostAndBridges.check(address, family) ||
			(privateLan && !allow.includes(host)) ||
			(family === "ipv6" && !privateLan && !globalV6.check(address, family)) ||
			(family === "ipv6" && address.toLowerCase().startsWith("::ffff:"))
		)
			refuse("private");
		if (privateOnly && !privateLan) refuse("machine_policy");
	}
	if (!answers.length) throw Error("unresolved");
	// Dial the checked IP. A second DNS lookup, even inside http.request, would reopen rebinding.
	return (answers.find(a => net.isIPv4(a.address)) ?? answers[0]).address;
}
// With an owner's list of public hosts (--egress-domains): the name is matched before any DNS lookup,
// so an unlisted name never reaches the machine's resolver. `*.name` is any subdomain, not the name.
// Each label is checked as the list's own are (egress-policy.ts), so `a..x.example` matches nothing.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export function listedHost(host, domains) {
	const name = host.toLowerCase().replace(/\.$/, "");
	if (!name || name.length > 253 || net.isIP(name) || !name.split(".").every(label => LABEL.test(label))) return false;
	return domains.some(entry => (entry.startsWith("*.") ? name.endsWith(entry.slice(1)) : name === entry));
}
const MAX_RECORD = 16384;
// The one server_name of the ClientHello in the first TLS record. Undefined while the record is still
// incomplete; null for anything refused: not TLS, a hello split across records, a malformed length,
// no name, two names, a duplicated extension or Encrypted Client Hello (its outer name says nothing), under
// its final code point or any of the drafts' (0xfe00 to 0xfe0d, and 0xffce).
export function clientHelloName(data) {
	if (data.length < 1) return undefined;
	if (data[0] !== 0x16) return null;
	if (data.length < 5) return undefined;
	const length = data.readUInt16BE(3);
	if (data[1] !== 3 || length < 4 || length > MAX_RECORD) return null;
	if (data.length < 5 + length) return undefined;
	const record = data.subarray(5, 5 + length);
	if (record[0] !== 1) return null;
	const size = (record[1] << 16) | (record[2] << 8) | record[3];
	if (4 + size > record.length) return null;
	const hello = record.subarray(4, 4 + size);
	let at = 0;
	const take = n => {
		if (n < 0 || at + n > hello.length) throw Error("short");
		const part = hello.subarray(at, at + n);
		at += n;
		return part;
	};
	const u8 = () => take(1)[0],
		u16 = () => take(2).readUInt16BE(0);
	try {
		take(2 + 32);
		const session = u8();
		if (session > 32) return null;
		take(session);
		const suites = u16();
		if (suites < 2 || suites % 2) return null;
		take(suites);
		const compression = u8();
		if (compression < 1) return null;
		take(compression);
		const extensions = take(u16());
		if (at !== hello.length) return null;
		const seen = new Set();
		let name = null;
		for (let p = 0; p < extensions.length; ) {
			if (p + 4 > extensions.length) return null;
			const type = extensions.readUInt16BE(p),
				len = extensions.readUInt16BE(p + 2);
			p += 4;
			if (p + len > extensions.length || seen.has(type)) return null;
			seen.add(type);
			const body = extensions.subarray(p, p + len);
			p += len;
			if ((type >= 0xfe00 && type <= 0xfe0d) || type === 0xffce) return null;
			if (type !== 0) continue;
			if (len < 2 || body.readUInt16BE(0) !== len - 2 || len < 5 || body[2] !== 0) return null;
			const nameLength = body.readUInt16BE(3);
			if (5 + nameLength !== len || nameLength < 1 || nameLength > 253) return null;
			name = body.subarray(5).toString("latin1").toLowerCase();
			if (!/^[a-z0-9.-]+$/.test(name)) return null;
		}
		return name;
	} catch {
		return null;
	}
}
function pipes(a, b) {
	a.on("error", () => b.destroy());
	b.on("error", () => a.destroy());
	a.on("close", () => b.destroy());
	b.on("close", () => a.destroy());
	a.pipe(b).pipe(a);
}
function headers(input) {
	const result = { ...input };
	for (const key of [
		"connection",
		"proxy-connection",
		"proxy-authenticate",
		"proxy-authorization",
		"keep-alive",
		"transfer-encoding",
		"te",
		"trailer",
		"upgrade",
		...(input.connection ?? "")
			.toLowerCase()
			.split(",")
			.map(s => s.trim()),
	])
		delete result[key];
	return result;
}
// The address a request may go to. `tunnel`: a CONNECT (whose port is always explicit) rather than plain HTTP.
export async function targetAddress(
	url,
	tunnel,
	allow,
	denied,
	domains = null,
	device = false,
	resolve = lookup,
	interfaces = networkInterfaces(),
) {
	const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (!host || url.username || url.password) refuse("malformed");
	if (device && (host !== "auth.openai.com" || url.port !== "443")) refuse("provider");
	if (net.isIP(host)) {
		const family = net.isIPv4(host) ? "ipv4" : "ipv6";
		if (
			blocked.check(host, family) ||
			(lan.check(host, family) && !allow.includes(host)) ||
			(family === "ipv6" && !lan.check(host, family) && !globalV6.check(host, family))
		)
			refuse("private");
	}
	if (denied.length && (net.isIP(host) || denied.includes(host.toLowerCase()))) refuse("provider");
	// A list also limits the ports: HTTPS tunnels to 443, plain HTTP to 80. A name only in --egress-allow
	// passes it, but then only to a private address: the allow list never adds a public host.
	let privateOnly = false;
	if (domains) {
		if (
			url.port !== (tunnel ? "443" : "") ||
			net.isIP(host) ||
			!host.split(".").every(label => LABEL.test(label)) ||
			host.length > 253
		)
			refuse("malformed");
		if (!listedHost(host, domains)) {
			if (!allow.includes(host.toLowerCase())) refuse("machine_policy");
			privateOnly = true;
		}
	}
	return selectAddress(host, allow, resolve, interfaces, denied, privateOnly);
}
export function proxyServer(allow, denied, device = false, domains = null, record = () => {}) {
	const target = (url, tunnel) => targetAddress(url, tunnel, allow, denied, domains, device);
	const server = http.createServer(async (req, res) => {
		let url;
		try {
			url = URL.parse(req.url);
			if (!url || device || url.protocol !== "http:") refuse("malformed");
			const ip = await target(url, false);
			if (res.destroyed) return;
			const out = http.request(
				{
					hostname: ip,
					port: url.port || 80,
					method: req.method,
					path: url.pathname + url.search,
					headers: { ...headers(req.headers), host: url.host },
					agent: false,
				},
				upstream => {
					res.writeHead(upstream.statusCode, headers(upstream.headers));
					upstream.on("error", () => res.destroy());
					upstream.pipe(res);
				},
			);
			out.setTimeout(60_000, () => out.destroy());
			out.on("error", () => {
				if (!res.headersSent) res.writeHead(502);
				res.end();
			});
			res.on("close", () => out.destroy());
			req.pipe(out);
		} catch (error) {
			if (error.reason) record(url, error.reason);
			res.writeHead(error.message === "blocked" ? 403 : 502);
			res.end(error.message === "blocked" ? "blocked by runner egress policy\n" : "upstream unavailable\n");
		}
	});
	server.on("connect", async (req, client, head) => {
		client.on("error", () => client.destroy());
		let url;
		try {
			if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):[0-9]{1,5}$/i.test(req.url)) refuse("malformed");
			url = URL.parse("http://" + req.url);
			if (!url) refuse("malformed");
			const ip = await target(url, true);
			if (client.destroyed) return;
			const out = net.connect(Number(url.port || 80), ip);
			client.on("close", () => out.destroy());
			out.setTimeout(300_000, () => out.destroy());
			out.once("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"));
			out.once("connect", () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (!domains) {
					if (head.length) out.write(head);
					return pipes(client, out);
				}
				// Only a TLS ClientHello naming the tunnel's own host is sent on.
				const host = url.hostname.replace(/\.$/, "").toLowerCase();
				let data = head;
				const refuse = () => {
					record(url, "malformed");
					clearTimeout(timer);
					client.destroy();
					out.destroy();
				};
				const timer = setTimeout(refuse, 5_000);
				const read = chunk => {
					if (chunk) data = Buffer.concat([data, chunk]);
					const name = clientHelloName(data);
					if (name === undefined) return;
					client.off("data", read);
					client.pause();
					clearTimeout(timer);
					if (name !== host) return refuse();
					out.write(data);
					pipes(client, out);
				};
				client.on("close", () => clearTimeout(timer));
				client.on("data", read);
				read();
			});
		} catch (error) {
			if (error.reason) record(url, error.reason);
			client.end(
				error.message === "blocked"
					? "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"
					: "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n",
			);
		}
	});
	// Node can reject a malformed request before either HTTP handler sees it. Never inspect its raw packet.
	server.on("clientError", (error, client) => {
		if (!client.destroyed && error.code?.startsWith("HPE_")) record(null, "malformed");
		client.destroy();
	});
	server.maxConnections = 256;
	return server;
}
function broker(allow, denied, device = false, domains = null) {
	const ledger = refusalLedger();
	if (!device) {
		// Separate Unix socket in the helpers' volume. The sandbox can only reach the HTTP forwarder.
		const path = "/workspace/observe.sock";
		rmSync(path, { force: true });
		http
			.createServer(async (req, res) => {
				const turn = Number(req.url.slice(1));
				if (!Number.isSafeInteger(turn) || turn <= 0) {
					res.writeHead(400);
					return res.end();
				}
				try {
					let input = "";
					for await (const chunk of req) {
						input += chunk;
						if (input.length > 16384) throw Error();
					}
					const retained = JSON.parse(input);
					if (!Array.isArray(retained) || retained.length > 50) throw Error();
					res.end(JSON.stringify(ledger.read(turn, retained)));
				} catch {
					res.writeHead(400);
					res.end();
				}
			})
			.listen(path);
	}
	const server = proxyServer(allow, denied, device, domains, ledger.record);
	rmSync(socket, { force: true });
	server.listen(socket);
}
if (process.argv[1] === "wlp-egress-device") broker([], [], true);
if (process.argv[1] === "wlp-egress-broker")
	broker(
		JSON.parse(process.argv[2]),
		JSON.parse(process.argv[3] ?? "[]"),
		false,
		JSON.parse(process.argv[4] ?? "null"),
	);
// Only the trusted forwarder mounts these sockets. Write its fixed-width identity before
// connecting the agent byte stream so even a second HTTP request has the same identity.
export function forward(port, path, nonce) {
	const server = net.createServer(client => {
		const upstream = net.connect(path);
		if (nonce) upstream.write(nonce);
		pipes(client, upstream);
	});
	server.maxConnections = 128;
	return server.listen(port, "127.0.0.1");
}
if (process.argv[1] === "wlp-egress-forward") {
	if (process.argv[2] === "restricted") forward(17891, socket);
	if (process.argv[3]) {
		// The pinned Codex adapter takes its key on the relay's port: Codex has only a key relay on a machine.
		if (process.argv[4] === "codex") forward(17892, "/run/wlp-relay/keys.sock", process.argv[3]);
		else {
			forward(17892, "/run/wlp-relay/relay.sock", process.argv[3]);
			forward(17894, "/run/wlp-relay/keys.sock", process.argv[3]);
		}
	}
}
// Windlass's model relay (docs/model-relay.md): one forwarder per turn, in the session's network namespace,
// with the turn's nonce. Only it and the relay mount the relay's socket volume. It says it is ready, in a
// tmpfs of its own the session cannot reach, only once it holds 127.0.0.1:17893 itself: a process of the
// session that took the port first makes it exit instead, and the turn fails (server/src/sandbox/model-relay.ts).
// A plan turn's forwarder names its plan relay's own socket (`plan-<nonce>.sock`) as the third argument.
if (process.argv[1] === "wlp-model-forward" && /^[0-9a-f]{32}$/.test(process.argv[2] ?? "")) {
	const plan = /^plan-[0-9a-f]{32}\.sock$/.test(process.argv[3] ?? "") ? process.argv[3] : null;
	const server = forward(17893, "/run/wlp-model/socket/" + (plan ?? "relay.sock"), process.argv[2]);
	server.once("error", () => process.exit(3));
	server.once("listening", () => writeFileSync(MODEL_FORWARD_READY, String(process.pid), { mode: 0o600 }));
}
