/**
 * WLP_CHECK_SECTIONS=seal,holder selects sign-in sections. The cleanup section checks captured output for credentials.
 * The windlass and actors sections use WLP_WINDLASS_BIN or the pinned binary with a local HTTPS proxy and synthetic tokens.
 * The actors section starts its own server with fake sandboxes.
 */

import { matchesSection } from "./check-sections.js";
import "./check-secret.js";
import { localListeners } from "./check-listeners.js";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer as createHttpServer } from "node:http";
import { type AddressInfo, type Server, type Socket, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { createClient, type Registry } from "../server/src/client.js";
import { config } from "../server/src/config.js";
import { type AccessToken, SandboxUserError } from "../server/src/sandbox/api.js";
import {
	NOT_SIGNED_IN,
	SIGN_IN_EXPIRED,
	SignInRefreshError,
	TOKEN_VALID_FOR_MS,
} from "../server/src/sandbox/handoff.js";
import { type SignInCommands, type TokenAnswer, WindlassSignIns } from "../server/src/signin/commands.js";
import { ActorSignInDirectory, errorOf, problemOf, tokenSubject } from "../server/src/signin/directory.js";
import { memorySignIns } from "../server/src/signin/facade.js";
import { SIGN_IN_UNREADABLE, SignInHolder, type StoredSignIn } from "../server/src/signin/holder.js";
import { type SignInMaterial, cleanMaterial } from "../server/src/signin/material.js";
import { LocalLoginRunner, TMP_PREFIX } from "../server/src/signin/runner.js";
import { SealError, createSealer, serverSealer } from "../server/src/signin/seal.js";
import { sleep as wait } from "./check-wait.js";
import { Report } from "./check-report.js";
import { connectChatgpt } from "./chatgpt-connect.js";

const run = randomBytes(3).toString("hex");
/** The Windlass the sections with a real one run: the executable WLP_WINDLASS_BIN names, else the pinned release, which sandbox/fetch-windlass.sh keeps and fetches the first time. */
function windlassBinary(): string | null {
	if (process.env.WLP_WINDLASS_BIN) return process.env.WLP_WINDLASS_BIN;
	const kept = spawnSync(resolve(dirname(fileURLToPath(import.meta.url)), "../sandbox/fetch-windlass.sh"), {
		encoding: "utf8",
	});
	return kept.status === 0
		? join(kept.stdout.trim(), `windlass-linux-${process.arch === "arm64" ? "arm64" : "x64"}`)
		: null;
}
const SECRET = /FAKE-(ACCESS|REFRESH)-TOKEN|FAKE\.ID\.TOKEN|FAKE-code/;

/** Everything this process prints, to be read at the end. */
const output: string[] = [];
for (const method of ["log", "warn", "error"] as const) {
	const real = console[method].bind(console);
	console[method] = (...parts: unknown[]) => {
		const line = parts.map(part => (typeof part === "string" ? part : String(part))).join(" ");
		output.push(line);
		real(line.startsWith("[wlp] ") ? `      ${line}` : line);
	};
}
const tally = new Report();
const { expect } = tally;

function info(text: string): void {
	console.log(`      ${text}`);
}
async function section(name: string, body: () => Promise<void>): Promise<void> {
	if (name !== "cleanup" && !matchesSection(name)) return;
	console.log(`\n== ${name}`);
	try {
		await body();
	} catch (error) {
		expect(`${name}: unexpected error`, false, error instanceof Error ? (error.stack ?? error.message) : String(error));
	}
}
const caught = <T>(promise: Promise<T>) =>
	promise.then(
		() => null,
		(error: unknown) => error,
	);
async function until(test: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!test()) {
		if (Date.now() > deadline) return false;
		await wait(20);
	}
	return true;
}

/** Where this check keeps its own files; removed at the end. */
const scratch = mkdtempSync(join(tmpdir(), `wlp-check-signin-${run}-`));
/** The private directories of a runner that are still there. */
const leftIn = (root: string) =>
	existsSync(root) ? readdirSync(root).filter(name => name.startsWith(TMP_PREFIX)) : [];

/** A made-up sign-in as Windlass saves one. `number` tells its tokens from another's. */
function fakeMaterial(
	sub: string,
	expiresAt: number,
	number: number | string = 0,
	email = `${sub}@example.invalid`,
): SignInMaterial {
	const credentials = {
		hostId: "urn:uuid:00000000-0000-4000-8000-00000000c0de",
		clientId: "FAKE-client-id-for-signin-check",
		account: { sub, email },
		accessToken: `FAKE-ACCESS-TOKEN-${number}-not-a-real-token`,
		refreshToken: `FAKE-REFRESH-TOKEN-${number}-not-a-real-token`,
		idToken: "FAKE.ID.TOKEN",
		scopes: ["openid", "chatgpt.tokens.use.direct"],
		expiresAt,
	};
	return { files: { "auth.json": JSON.stringify(credentials, null, 2), "host-id": credentials.hostId } };
}
const saved = (material: SignInMaterial) =>
	JSON.parse(material.files["auth.json"] ?? "{}") as {
		accessToken: string;
		refreshToken: string;
		expiresAt: number;
		account: { sub: string };
	};

/** A store in memory that says in `events` when a row was saved, and can be made to fail. */
class Rows {
	row: StoredSignIn | null = null;
	readonly events: string[] = [];
	failSaves = 0;
	readonly store = {
		load: async () => (this.row === null ? null : { ...this.row }),
		save: async (row: StoredSignIn) => {
			if (this.failSaves > 0) {
				this.failSaves -= 1;
				this.events.push("save failed");
				throw new Error("the store is away");
			}
			this.row = { ...row };
			this.events.push("saved");
		},
	};
}

/** Sign-in commands that answer as the check says: no Windlass. A request can be held open, and counts. */
class ScriptedCommands implements SignInCommands {
	asked = 0;
	issued = 0;
	/** Resolved by the check to let a held request go on. */
	hold: Promise<void> | null = null;
	lastsMs = 3_600_000;
	shorter = false;
	failWith: Error | null = null;
	readonly aborted: boolean[] = [];

	async start(): Promise<{ url: string; redirectPrefix: string; material: SignInMaterial }> {
		throw new Error("not used");
	}
	async finish(): Promise<never> {
		throw new Error("not used");
	}
	async models(): Promise<never> {
		throw new Error("not used");
	}
	async token(material: SignInMaterial, options: { signal?: AbortSignal } = {}): Promise<TokenAnswer> {
		this.asked += 1;
		if (this.hold !== null)
			await Promise.race([
				this.hold,
				new Promise<void>(done => options.signal?.addEventListener("abort", () => done(), { once: true })),
			]);
		else await wait(5);
		this.aborted.push(options.signal?.aborted === true);
		if (options.signal?.aborted) return { ok: false, material, error: new Error("stopped") };
		if (this.failWith !== null) return { ok: false, material, error: this.failWith };
		const now = saved(material);
		if (now.expiresAt - Date.now() > TOKEN_VALID_FOR_MS)
			return { ok: true, material, token: { accessToken: now.accessToken, expiresAt: now.expiresAt }, shorter: false };
		// A refresh: another access token and another refresh token.
		const next = fakeMaterial(now.account.sub, Date.now() + this.lastsMs, (this.issued += 1) + 100);
		return {
			ok: true,
			material: next,
			token: { accessToken: saved(next).accessToken, expiresAt: saved(next).expiresAt },
			shorter: this.shorter,
		};
	}
}

// ---------------------------------------------------------------------------------------------
// A stand-in for OpenAI's sign-in service, inside this process
// ---------------------------------------------------------------------------------------------

interface Expected {
	sub: string;
	email: string;
}

/**
 * Answers what Windlass sends to auth.openai.com. Windlass is given this as its HTTPS proxy: it asks
 * for a tunnel to auth.openai.com:443, and the stand-in answers on that tunnel itself, with a
 * certificate of its own that Windlass is told to trust. Nothing is forwarded anywhere. It also answers
 * the one thing the platform has Windlass ask the provider outside a turn, the models of an account
 * (`GET /v1/models` at api.openai.com), to whoever shows an access token it issued.
 */
class StandIn {
	/** Every request it answered: "refresh_token" or "models". Never a token. */
	readonly requests: string[] = [];
	/** Every tunnel it was asked for. */
	readonly tunnels: string[] = [];
	expiresIn = 3600;
	/** How long a refresh is held before it is answered. */
	delayMs = 0;
	refuse: { code: string; status: number } | null = null;
	refreshing = 0;
	/** The refresh tokens that are still good. A refresh replaces the one it was asked with. */
	private readonly good = new Map<string, Expected>();
	private issued = 0;
	private proxy: Server | null = null;
	private readonly sockets = new Set<Socket>();
	private port = 0;
	private readonly certFile = join(scratch, "standin-cert.pem");
	private readonly keyFile = join(scratch, "standin-key.pem");

	async start(): Promise<void> {
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"2",
				"-subj",
				"/CN=auth.openai.com",
				"-addext",
				"subjectAltName=DNS:auth.openai.com,DNS:api.openai.com",
				"-keyout",
				this.keyFile,
				"-out",
				this.certFile,
			],
			{ stdio: "pipe" },
		);
		const tlsKey = readFileSync(this.keyFile);
		const tlsCert = readFileSync(this.certFile);
		const http = createHttpServer((request, response) => void this.answer(request, response));
		this.proxy = createNetServer(socket => {
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
			socket.on("error", () => {});
			socket.once("data", (head: Buffer) => {
				this.tunnels.push(head.toString("latin1").split("\r\n")[0] ?? "");
				socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
				const secure = new TLSSocket(socket, { isServer: true, key: tlsKey, cert: tlsCert });
				secure.on("error", () => {});
				http.emit("connection", secure);
			});
		});
		await new Promise<void>(done => this.proxy!.listen(0, "127.0.0.1", done));
		this.port = (this.proxy.address() as AddressInfo).port;
	}

	async stop(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>(done => (this.proxy === null ? done() : this.proxy.close(() => done())));
	}

	/** What a Windlass that is to talk to the stand-in is run with. */
	env(): Record<string, string> {
		const proxy = `http://127.0.0.1:${this.port}`;
		return {
			HTTPS_PROXY: proxy,
			HTTP_PROXY: proxy,
			https_proxy: proxy,
			http_proxy: proxy,
			NODE_EXTRA_CA_CERTS: this.certFile,
		};
	}

	/** A sign-in with this service, as Windlass saves it on the person's computer: what `connect codex` uploads. */
	signIn(sub: string, email = `${sub}@example.invalid`): SignInMaterial {
		const material = fakeMaterial(sub, Date.now() + this.expiresIn * 1000, `S${(this.issued += 1)}`, email);
		this.good.set(saved(material).refreshToken, { sub, email });
		return material;
	}

	isGood(refreshToken: string): boolean {
		return this.good.has(refreshToken);
	}

	count(kind: string): number {
		return this.requests.filter(request => request === kind).length;
	}

	private issue(expected: Expected, letter: string): Record<string, unknown> {
		const number = (this.issued += 1);
		const refreshToken = `FAKE-REFRESH-TOKEN-${letter}${number}-not-a-real-token`;
		this.good.set(refreshToken, expected);
		return {
			access_token: `FAKE-ACCESS-TOKEN-${letter}${number}-not-a-real-token`,
			refresh_token: refreshToken,
			expires_in: this.expiresIn,
			scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
		};
	}

	private async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const send = (status: number, body: unknown) => {
			const text = JSON.stringify(body);
			response.writeHead(status, {
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(text),
				Connection: "close",
			});
			response.end(text);
		};
		try {
			if (request.method === "GET" && request.url === "/v1/models") {
				this.requests.push("models");
				if (!/^Bearer FAKE-ACCESS-TOKEN-[SR]\d+-/.test(request.headers.authorization ?? ""))
					return send(401, { error: { message: "the stand-in issued no such token", code: "token_revoked" } });
				const levels = (efforts: string[]) => efforts.map(effort => ({ effort }));
				return send(200, {
					models: [
						{
							slug: "gpt-6.1-sol",
							display_name: "GPT-6.1 Sol",
							visibility: "list",
							supported_reasoning_levels: levels(["low", "medium", "high"]),
						},
						{ slug: "gpt-6-luna", visibility: "list", supported_reasoning_levels: levels(["low"]) },
					],
				});
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk as Buffer);
			const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
			const grant = form.get("grant_type") ?? "";
			if (request.method !== "POST" || request.url !== "/api/accounts/oauth/token")
				return send(404, { error: "not_found" });
			this.requests.push(grant);
			if (grant === "refresh_token") {
				this.refreshing += 1;
				try {
					if (this.delayMs > 0) await wait(this.delayMs);
					if (this.refuse !== null)
						return send(this.refuse.status, {
							error: this.refuse.code,
							error_description: "the stand-in does not refresh this sign-in",
						});
					const presented = form.get("refresh_token") ?? "";
					const expected = this.good.get(presented);
					// A refresh token is good once: this is what makes a lost refresh cost the sign-in.
					if (expected === undefined)
						return send(400, { error: "invalid_grant", error_description: "this refresh token was already used" });
					this.good.delete(presented);
					return send(200, this.issue(expected, "R"));
				} finally {
					this.refreshing -= 1;
				}
			}
			return send(400, { error: "unsupported_grant_type" });
		} catch {
			response.destroy();
		}
	}
}

// ---------------------------------------------------------------------------------------------

/** A shell program in Windlass's place, for the runner's own checks: `<it> login <what>`. It notes what it was given in $STUB_NOTE. */
const STUB = `#!/bin/sh
data="$XDG_DATA_HOME/windlass"
{
  echo "data=$data"
  echo "home=$HOME"
  echo "cwd=$(pwd)"
  echo "tokenfile=\${WINDLASS_ACCESS_TOKEN_FILE:-unset}"
  echo "probe=\${WLP_SIGNIN_PROBE:-unset}"
  stat -c 'mode %a %n' "$(dirname "$XDG_DATA_HOME")" "$data" "$data"/* 2>/dev/null
} > "$STUB_NOTE"
rotate() {
  sed 's/TOKEN-0-not/TOKEN-1-not/g' "$data/auth.json" > "$data/auth.json.$$.tmp" && mv "$data/auth.json.$$.tmp" "$data/auth.json"
}
case "$2" in
  rotate) rotate; echo junk > "$data/other.txt"; : > "$data/auth.lock"; ln -sf /etc/hostname "$data/auth-pending.json"; echo "said on stdout";;
  fail) rotate; echo "windlass: sign-in failed: the stub says no (some_code)" >&2; exit 1;;
  token) rotate; sleep 30;;
  hang) sleep 30 & wait;;
  echo) cat;;
esac
`;

async function main(): Promise<void> {
	console.log(`signin-check run ${run} on ${process.arch}`);

	await section("seal", async () => {
		const secret = randomBytes(32);
		const sealer = createSealer(secret);
		const text = JSON.stringify(fakeMaterial("fake-sub-seal", Date.now() + 3_600_000));
		const blob = sealer.seal("user", "u_ann", text);
		expect(
			"a sealed sign-in opens again as it was, for the user it was sealed for",
			sealer.open("user", "u_ann", blob) === text,
		);
		expect(
			"the blob shows nothing of what is in it",
			!SECRET.test(blob) &&
				!blob.includes("fake-sub-seal") &&
				!Buffer.from(blob.split(".")[3] ?? "", "base64url")
					.toString("latin1")
					.includes("FAKE-"),
			`${blob.length} characters, ${blob.split(".").length} parts`,
		);
		expect("sealing the same thing twice gives two different blobs", sealer.seal("user", "u_ann", text) !== blob);
		const reasonOf = (step: () => unknown) => {
			try {
				step();
				return "it opened";
			} catch (error) {
				return error instanceof SealError ? error.reason : `another error: ${String(error)}`;
			}
		};
		expect(
			"one user's blob does not open as another user's",
			reasonOf(() => sealer.open("user", "u_ben", blob)) === "tampered",
		);
		expect(
			"a user's sign-in does not open as an attempt's material, nor as a token in transit",
			reasonOf(() => sealer.open("attempt", "u_ann", blob)) === "tampered" &&
				reasonOf(() => sealer.open("transit", "u_ann", blob)) === "tampered",
		);
		const other = createSealer(randomBytes(32));
		expect(
			"it does not open with another key, and the error says that the key is another",
			reasonOf(() => other.open("user", "u_ann", blob)) === "key",
		);
		const parts = blob.split(".");
		const flipped = Buffer.from(parts[3]!, "base64url");
		flipped[0] = flipped[0]! ^ 1;
		const changed = [parts[0], parts[1], parts[2], flipped.toString("base64url"), parts[4]].join(".");
		expect(
			"a blob that was changed does not open",
			reasonOf(() => sealer.open("user", "u_ann", changed)) === "tampered",
		);
		// The key id is not the key: another key under the same id still does not open it.
		const forged = [parts[0], other.seal("user", "u_ann", text).split(".")[1], parts[2], parts[3], parts[4]].join(".");
		expect(
			"a blob with the wrong key's id is refused before anything is decrypted",
			reasonOf(() => sealer.open("user", "u_ann", forged)) === "key",
		);
		expect(
			"what is not a blob is refused as such",
			reasonOf(() => sealer.open("user", "u_ann", "not a blob")) === "format" &&
				reasonOf(() => sealer.open("user", "u_ann", text)) === "format",
		);
		expect(
			"the same secret gives the same key on another server",
			createSealer(Buffer.from(secret)).open("user", "u_ann", blob) === text,
		);
		const token: AccessToken = { accessToken: "FAKE-ACCESS-TOKEN-T-not-a-real-token", expiresAt: 1 };
		const answer = sealer.seal("transit", tokenSubject("u_ann", "nonce-one"), JSON.stringify(token));
		expect(
			"an access token sealed for one request opens for that request only: not for another nonce, not for another user",
			sealer.open("transit", tokenSubject("u_ann", "nonce-one"), answer) === JSON.stringify(token) &&
				reasonOf(() => sealer.open("transit", tokenSubject("u_ann", "nonce-two"), answer)) === "tampered" &&
				reasonOf(() => sealer.open("transit", tokenSubject("u_ben", "nonce-one"), answer)) === "tampered",
		);
		let short = "";
		try {
			createSealer("too short");
		} catch (error) {
			short = error instanceof Error ? error.message : "";
		}
		expect("a secret that is too short to derive a key from is refused", /at least 16 bytes/.test(short));
		// How a failure crosses from an actor to the server that asked: by its kind.
		const crossed = [
			new SandboxUserError(NOT_SIGNED_IN),
			new SignInRefreshError("no network", "network_error"),
			new Error("something else"),
		].map(error => errorOf(JSON.parse(JSON.stringify(problemOf(error)))));
		expect(
			"a failure of the sign-in keeps its kind, its sentence and Windlass's code on the way from the user's actor to the server that asked",
			crossed[0] instanceof SandboxUserError &&
				crossed[0].message === NOT_SIGNED_IN &&
				crossed[1] instanceof SignInRefreshError &&
				crossed[1].code === "network_error" &&
				!(crossed[2] instanceof SandboxUserError) &&
				crossed[2]!.message === "something else",
		);
	});

	const stub = join(scratch, "stub-windlass");
	writeFileSync(stub, STUB);
	chmodSync(stub, 0o755);

	await section("runner", async () => {
		const root = join(scratch, "runner-root");
		mkdirSync(root);
		const note = join(scratch, "stub-note");
		// What the server's own environment holds must not reach Windlass.
		process.env.WLP_SIGNIN_PROBE = "the server's own";
		process.env.WINDLASS_ACCESS_TOKEN_FILE = "/somewhere/else";
		const lines: string[] = [];
		const runner = new LocalLoginRunner({
			binary: stub,
			tmpRoot: root,
			env: { STUB_NOTE: note },
			log: line => lines.push(line),
		});
		const material = fakeMaterial("fake-sub-runner", Date.now() + 3_600_000, 0);
		const read = () => readFileSync(note, "utf8").split("\n");
		const dirOf = () => (read().find(line => line.startsWith("data=")) ?? "").slice(5).replace(/\/data\/windlass$/, "");

		const ok = await runner.run(
			{ files: { ...material.files, "auth-pending.json": "{}" } },
			{ args: ["rotate"], stdin: "ignored\n", network: false, timeoutMs: 10_000 },
		);
		const seen = read();
		const modes = seen.filter(line => line.startsWith("mode "));
		const dir = dirOf();
		expect(
			"the command ran with a private directory as Windlass's data directory: made for it under the runner's root, and nobody else's to enter",
			dir.startsWith(join(root, TMP_PREFIX)) &&
				modes.some(line => line === `mode 700 ${dir}`) &&
				modes.some(line => line === `mode 700 ${dir}/data/windlass`),
			`${dir.replace(root, "<root>")}: ${modes.map(line => line.replace(dir, "").replace("mode ", "")).join(", ")}`,
		);
		expect(
			"the sign-in's files were in it, readable by their owner only",
			["auth.json", "host-id", "auth-pending.json"].every(name =>
				modes.includes(`mode 600 ${dir}/data/windlass/${name}`),
			) && modes.length === 5,
		);
		expect(
			"HOME and the working directory were inside it, and nothing of the server's environment was passed on: no WINDLASS_ACCESS_TOKEN_FILE, with which Windlass would not use a saved sign-in",
			seen.includes(`home=${dir}/home`) &&
				seen.includes(`cwd=${dir}`) &&
				seen.includes("tokenfile=unset") &&
				seen.includes("probe=unset"),
			seen.filter(line => /^(tokenfile|probe)=/.test(line)).join(", "),
		);
		expect(
			"what the command left is read back: the sign-in it replaced, and only the sign-in's own files (not a lock, not another file, not a link in a file's place)",
			ok.code === 0 &&
				ok.materialRead &&
				saved(ok.material).refreshToken === "FAKE-REFRESH-TOKEN-1-not-a-real-token" &&
				Object.keys(ok.material.files).sort().join(",") === "auth.json,host-id" &&
				ok.stdout.trim() === "said on stdout",
			Object.keys(ok.material.files).sort().join(", "),
		);
		expect("the directory is gone after a command that succeeded", !existsSync(dir) && leftIn(root).length === 0);

		const failed = await runner.run(material, { args: ["fail"], network: false, timeoutMs: 10_000 });
		expect(
			"after a command that failed the directory is gone too, and what the command had saved before it failed is still read back",
			failed.code === 1 &&
				/some_code/.test(failed.stderr) &&
				saved(failed.material).refreshToken === "FAKE-REFRESH-TOKEN-1-not-a-real-token" &&
				!existsSync(dirOf()) &&
				leftIn(root).length === 0,
		);

		let start = Date.now();
		const hung = await runner.run(material, { args: ["hang"], network: false, timeoutMs: 700 });
		expect(
			"a command that does not end is stopped when its time is up, with everything it started, and the directory is gone",
			hung.timedOut &&
				hung.code === null &&
				Date.now() - start < 5_000 &&
				!existsSync(dirOf()) &&
				leftIn(root).length === 0,
			`${Date.now() - start} ms for a command that sleeps 30 s in a child of its own`,
		);
		start = Date.now();
		const late = await runner.run(material, { args: ["token"], network: true, timeoutMs: 700 });
		expect(
			"a command that replaced the sign-in and then hung: what it had saved is read back all the same",
			late.timedOut &&
				late.materialRead &&
				saved(late.material).refreshToken === "FAKE-REFRESH-TOKEN-1-not-a-real-token" &&
				leftIn(root).length === 0,
		);

		const controller = new AbortController();
		start = Date.now();
		setTimeout(() => controller.abort(), 300);
		const stopped = await runner.run(material, {
			args: ["hang"],
			network: false,
			timeoutMs: 20_000,
			signal: controller.signal,
		});
		expect(
			"an abort stops the command at once, and the directory is gone",
			stopped.aborted && !stopped.timedOut && Date.now() - start < 5_000 && leftIn(root).length === 0,
			`${Date.now() - start} ms`,
		);

		const echoed = await runner.run(material, {
			args: ["echo"],
			stdin: "one line on standard input\n",
			network: false,
			timeoutMs: 10_000,
		});
		expect("standard input reaches the command", echoed.stdout === "one line on standard input\n");

		const missing = new LocalLoginRunner({
			binary: join(scratch, "no-such-windlass"),
			tmpRoot: root,
			log: line => lines.push(line),
		});
		const notRun = await caught(missing.run(material, { args: ["rotate"], network: false, timeoutMs: 10_000 }));
		expect(
			"a Windlass that cannot be started is an error that names the program and not the sign-in, and the directory that was made for it is gone",
			notRun instanceof Error &&
				/could not run .*no-such-windlass: ENOENT/.test(notRun.message) &&
				!SECRET.test(notRun.message) &&
				leftIn(root).length === 0,
			notRun instanceof Error ? notRun.message.replace(scratch, "<scratch>") : "it ran",
		);

		// What a server that was killed in the middle of a command leaves behind.
		const sweepRoot = join(scratch, "sweep-root");
		mkdirSync(sweepRoot);
		const stale = join(sweepRoot, `${TMP_PREFIX}stale`);
		const young = join(sweepRoot, `${TMP_PREFIX}young`);
		const notOurs = join(sweepRoot, "something-else");
		for (const path of [stale, young, notOurs]) mkdirSync(join(path, "data", "windlass"), { recursive: true });
		writeFileSync(join(stale, "data", "windlass", "auth.json"), material.files["auth.json"]!);
		const longAgo = new Date(Date.now() - 3_600_000);
		utimesSync(stale, longAgo, longAgo);
		const sweeping: string[] = [];
		const sweeper = new LocalLoginRunner({
			binary: stub,
			tmpRoot: sweepRoot,
			env: { STUB_NOTE: note },
			log: line => sweeping.push(line),
		});
		await sweeper.run(material, { args: ["echo"], network: false, timeoutMs: 10_000 });
		expect(
			"a private directory an earlier process left behind is removed before the runner's first command; a young one (another process's command) and anything else are left alone",
			!existsSync(stale) &&
				existsSync(young) &&
				existsSync(notOurs) &&
				sweeping.length === 1 &&
				sweeping[0]!.includes("sign-in.tmp_swept"),
			sweeping.map(line => line.replace(scratch, "<scratch>")).join(" | "),
		);
		expect(
			"nothing the runner logged holds a sign-in",
			![...lines, ...sweeping].some(line => SECRET.test(line)),
			`${lines.length + sweeping.length} line(s)`,
		);
		delete process.env.WLP_SIGNIN_PROBE;
		delete process.env.WINDLASS_ACCESS_TOKEN_FILE;
	});

	await section("holder", async () => {
		const sealer = createSealer(randomBytes(32));
		const uid = "u_holder";
		const seal = (material: SignInMaterial, forUid = uid) => sealer.seal("user", forUid, JSON.stringify(material));
		const open = (rows: Rows) =>
			cleanMaterial((JSON.parse(sealer.open("user", uid, rows.row!.sealed!)) as { files: unknown }).files);
		const lines: string[] = [];
		const log = (line: string) => void (lines.push(line), console.log(line));
		const make = (
			rows: Rows,
			commands: SignInCommands,
			extra: Partial<ConstructorParameters<typeof SignInHolder>[0]> = {},
		) => new SignInHolder({ uid, store: rows.store, commands, sealer, log, ...extra });

		// ---- nothing saved
		{
			const rows = new Rows();
			const commands = new ScriptedCommands();
			const holder = make(rows, commands);
			const none = await caught(holder.accessToken());
			expect(
				"a user without a sign-in is told to sign in with ChatGPT, and Windlass is not asked",
				none instanceof SandboxUserError &&
					none.message === NOT_SIGNED_IN &&
					commands.asked === 0 &&
					(await holder.status()) === null,
			);
			await holder.logout();
			expect("forgetting a sign-in that is not there changes nothing", rows.row === null && rows.events.length === 0);
		}

		// ---- a saved token that is good is handed out as it is; requests at once are one request
		{
			const rows = new Rows();
			const commands = new ScriptedCommands();
			const holder = make(rows, commands);
			await holder.adopt(seal(fakeMaterial("fake-sub-a", Date.now() + 3_600_000, 1)));
			expect(
				"adopting a sign-in saves it sealed: the store's row holds nothing readable",
				rows.row?.sealed != null &&
					!SECRET.test(rows.row.sealed) &&
					!rows.row.sealed.includes("fake-sub-a") &&
					/^[0-9a-f-]{36}$/.test(rows.row.generation),
			);
			const account = await holder.status();
			expect(
				"status() gives who signed in and when the saved token expires, and no token",
				account?.sub === "fake-sub-a" &&
					typeof account.accessExpiresAt === "number" &&
					!SECRET.test(JSON.stringify(account)),
				JSON.stringify(account),
			);
			const savedBefore = rows.events.length;
			const many = await Promise.all(Array.from({ length: 6 }, () => holder.accessToken()));
			expect(
				"six requests at once are answered by one request to Windlass, and a token that needed no refresh causes no save",
				many.every(token => token.accessToken === many[0]!.accessToken) &&
					commands.asked === 1 &&
					rows.events.length === savedBefore,
			);
			many[0]!.accessToken = "changed by the caller";
			const again = await holder.accessToken();
			expect(
				"a fresh answer is reused, and what a caller does to its copy changes nothing",
				again.accessToken === many[1]!.accessToken && commands.asked === 1,
			);
		}

		// ---- a refresh: saved before the token is returned; two at once are one refresh
		{
			const rows = new Rows();
			const commands = new ScriptedCommands();
			const holder = make(rows, commands);
			await holder.adopt(seal(fakeMaterial("fake-sub-b", Date.now() + 12 * 60_000, 1)));
			const adopted = rows.row!.generation;
			rows.events.length = 0;
			let release = () => {};
			commands.hold = new Promise<void>(done => (release = done));
			const order = rows.events;
			const first = holder.accessToken().then(token => (order.push("returned"), token));
			const second = holder.accessToken().then(token => (order.push("returned"), token));
			await wait(30);
			expect(
				"while the request to Windlass runs, nothing is saved and nothing is returned",
				order.length === 0 && commands.asked === 1,
			);
			release();
			const [one, two] = await Promise.all([first, second]);
			const now = saved(open(rows));
			expect(
				"two requests at once for a token that is due cause one refresh, and both get the new token",
				commands.asked === 1 &&
					commands.issued === 1 &&
					one.accessToken === two.accessToken &&
					one.accessToken === "FAKE-ACCESS-TOKEN-101-not-a-real-token",
				`${commands.asked} request to Windlass, ${commands.issued} refresh`,
			);
			expect(
				"the refreshed sign-in is in the store before the token is returned: saved first, with the new refresh token, at the same generation",
				order.join(", ") === "saved, returned, returned" &&
					now.refreshToken === "FAKE-REFRESH-TOKEN-101-not-a-real-token" &&
					now.accessToken === one.accessToken &&
					rows.row!.generation === adopted,
				order.join(", "),
			);
			commands.hold = null;
		}

		// ---- the store does not take the refreshed sign-in: no token is handed out
		{
			const rows = new Rows();
			const commands = new ScriptedCommands();
			const holder = make(rows, commands);
			await holder.adopt(seal(fakeMaterial("fake-sub-c", Date.now() + 12 * 60_000, 1)));
			rows.events.length = 0;
			rows.failSaves = 1;
			const before = lines.length;
			const refused = await caught(holder.accessToken());
			const said = lines.slice(before);
			expect(
				"when the refreshed sign-in cannot be saved, the token is not handed out: the request fails, not as the user's doing, and says so without a token",
				refused instanceof Error &&
					!(refused instanceof SandboxUserError) &&
					/refreshed sign-in could not be saved/.test(refused.message) &&
					!SECRET.test(refused.message) &&
					commands.issued === 1 &&
					saved(open(rows)).refreshToken === "FAKE-REFRESH-TOKEN-1-not-a-real-token",
				refused instanceof Error ? refused.message : "it returned a token",
			);
			expect(
				"a line says that the sign-in was refreshed and not saved, and holds no token",
				said.length === 1 && said[0]!.includes("sign-in.save_failed") && !SECRET.test(said[0]!),
			);
			expect(
				"status() still answers from the refreshed sign-in, which is kept until it is saved",
				(await holder.status())?.sub === "fake-sub-c",
			);
			const next = await holder.accessToken();
			expect(
				"the next request saves it first and only then asks Windlass, which has the new token to give: one refresh in all, and the store ends with the new refresh token",
				rows.events.join(", ") === "save failed, saved" &&
					commands.issued === 1 &&
					commands.asked === 2 &&
					next.accessToken === "FAKE-ACCESS-TOKEN-101-not-a-real-token" &&
					saved(open(rows)).refreshToken === "FAKE-REFRESH-TOKEN-101-not-a-real-token",
				rows.events.join(", "),
			);
		}

		// ---- a sign-in that is replaced or forgotten yields no more tokens
		{
			const rows = new Rows();
			const commands = new ScriptedCommands();
			const revoked: string[] = [];
			const holder = make(rows, commands, { revoke: async user => void revoked.push(user) });
			await holder.adopt(seal(fakeMaterial("fake-sub-d", Date.now() + 3_600_000, 1)));
			const first = rows.row!.generation;
			const old = await holder.accessToken();
			await holder.adopt(seal(fakeMaterial("fake-sub-d", Date.now() + 3_600_001, 2)));
			const second = rows.row!.generation;
			const replaced = await holder.accessToken();
			expect(
				"after a new sign-in is adopted the old one's token is not handed out again, though it was fresh: the new one's is",
				old.accessToken === "FAKE-ACCESS-TOKEN-1-not-a-real-token" &&
					replaced.accessToken === "FAKE-ACCESS-TOKEN-2-not-a-real-token" &&
					second !== first,
			);
			const asked = commands.asked;
			await holder.logout();
			const gone = await caught(holder.accessToken());
			expect(
				"after logout() no token is handed out, though one was fresh: the store holds no sign-in, Windlass is not asked, and the provider was told to remove the token files of running turns",
				gone instanceof SandboxUserError &&
					gone.message === NOT_SIGNED_IN &&
					rows.row!.sealed === null &&
					rows.row!.generation !== second &&
					(await holder.status()) === null &&
					commands.asked === asked &&
					revoked.join(",") === uid,
			);
			// A holder made afresh over the same store (the actor after a sleep, or on another server) agrees.
			const woken = make(rows, commands);
			expect(
				"a holder made afresh over the same store finds no sign-in either",
				(await caught(woken.accessToken())) instanceof SandboxUserError && commands.asked === asked,
			);
		}

		// ---- replaced or forgotten while a request to Windlass runs
		{
			const rows = new Rows();
			const commands = new ScriptedCommands();
			const holder = make(rows, commands);
			await holder.adopt(seal(fakeMaterial("fake-sub-e", Date.now() + 12 * 60_000, 1)));
			commands.hold = new Promise<void>(() => {});
			const waiting = holder.accessToken();
			await until(() => commands.asked === 1, 2_000);
			// Only the request that is running is held: the one made after the change is answered.
			commands.hold = null;
			const start = Date.now();
			await holder.adopt(seal(fakeMaterial("fake-sub-e", Date.now() + 3_600_000, 7)));
			const got = await waiting;
			expect(
				"a new sign-in adopted while a refresh of the old one runs: that request is stopped, not waited for, nothing of it is saved, and whoever was waiting gets the new sign-in's token",
				commands.aborted[0] === true &&
					got.accessToken === "FAKE-ACCESS-TOKEN-7-not-a-real-token" &&
					saved(open(rows)).accessToken === got.accessToken &&
					Date.now() - start < 2_000,
				`${Date.now() - start} ms`,
			);
			await holder.adopt(seal(fakeMaterial("fake-sub-e", Date.now() + 12 * 60_000, 8)));
			commands.hold = new Promise<void>(() => {});
			const waitingToo = caught(holder.accessToken());
			await until(() => commands.asked === 3, 2_000);
			commands.hold = null;
			await holder.logout();
			const refused = await waitingToo;
			expect(
				"a sign-in forgotten while its refresh runs: the request is stopped and whoever was waiting is told to sign in",
				refused instanceof SandboxUserError && refused.message === NOT_SIGNED_IN && rows.row!.sealed === null,
			);
		}

		// ---- whose sign-in it is
		{
			const rows = new Rows();
			const commands = new ScriptedCommands();
			const holder = make(rows, commands);
			const forOther = await caught(
				holder.adopt(seal(fakeMaterial("fake-sub-f", Date.now() + 3_600_000, 1), "u_other")),
			);
			expect(
				"a sign-in sealed for another user is refused, and nothing is saved",
				forOther instanceof Error &&
					!(forOther instanceof SandboxUserError) &&
					/was refused/.test(forOther.message) &&
					rows.row === null,
				forOther instanceof Error ? forOther.message : "",
			);
			const pending = await caught(
				holder.adopt(seal({ files: { "auth-pending.json": "{}", "host-id": "urn:uuid:0" } })),
			);
			expect(
				"a sign-in that is not finished is refused, as the user's to finish",
				pending instanceof SandboxUserError && /not finished/.test(pending.message) && rows.row === null,
			);
			const mine = "u_owner";
			const own = new SignInHolder({ uid: mine, store: rows.store, commands, sealer, log });
			await own.adopt(sealer.seal("user", mine, JSON.stringify(fakeMaterial("fake-sub-f", Date.now() + 3_600_000, 1))));
			expect("and the account's own user takes it", (await own.status())?.sub === "fake-sub-f");
			// The same row read by another user's holder: what one user's storage holds is of no use in another's.
			const thief = new SignInHolder({ uid: "u_thief", store: rows.store, commands, sealer, log });
			const before = lines.length;
			const stolen = await caught(thief.accessToken());
			expect(
				"a user's row put into another user's store does not open there: no token, and a line says that the stored sign-in does not open",
				stolen instanceof SandboxUserError &&
					stolen.message === SIGN_IN_UNREADABLE &&
					(await thief.status()) === null &&
					lines.slice(before).filter(line => line.includes("sign-in.unreadable")).length === 1,
			);
			const rekeyed = new SignInHolder({
				uid: mine,
				store: rows.store,
				commands,
				sealer: createSealer(randomBytes(32)),
				log,
			});
			const unread = await caught(rekeyed.accessToken());
			expect(
				"with another key (a server whose secret differs) the stored sign-in does not open either, and the line names the key",
				unread instanceof SandboxUserError &&
					unread.message === SIGN_IN_UNREADABLE &&
					lines.some(line => line.includes("sign-in.unreadable") && line.includes("another secret")),
			);
		}

		// ---- the service issues tokens shorter than asked
		{
			const rows = new Rows();
			const commands = new ScriptedCommands();
			commands.lastsMs = 8 * 60_000;
			commands.shorter = true;
			const holder = make(rows, commands);
			await holder.adopt(seal(fakeMaterial("fake-sub-g", Date.now() + 60_000, 1)));
			const before = lines.length;
			const short = await holder.accessToken();
			const reused = await holder.accessToken();
			const woken = make(rows, commands);
			woken.forget();
			await woken.accessToken();
			const said = lines.slice(before).filter(line => line.includes("token.short"));
			expect(
				"a token that lasts less than is asked for is handed out as it is and reused until half of what it had is gone; that the service issues shorter ones is said once for the user, also across a restart of the holder",
				short.expiresAt - Date.now() < 9 * 60_000 &&
					reused.accessToken === short.accessToken &&
					commands.issued === 2 &&
					said.length === 1 &&
					rows.row!.shortNoted,
				`${said.length} line, ${commands.issued} refreshes for 3 requests`,
			);
		}

		// ---- a command that is killed after Windlass saved the refreshed sign-in
		{
			const rows = new Rows();
			const note = join(scratch, "stub-note-holder");
			const root = join(scratch, "holder-root");
			mkdirSync(root);
			const commands = new WindlassSignIns(
				new LocalLoginRunner({ binary: stub, tmpRoot: root, env: { STUB_NOTE: note } }),
				{ tokenTimeoutMs: 700, log },
			);
			const holder = make(rows, commands);
			await holder.adopt(seal(fakeMaterial("fake-sub-i", Date.now() + 12 * 60_000, 0)));
			rows.events.length = 0;
			const late = await caught(holder.accessToken());
			expect(
				"`windlass login token` that refreshed the sign-in and then hung is stopped when its time is up; the request fails, but what Windlass had saved is in the store, so the refresh is not lost",
				late instanceof Error &&
					!(late instanceof SandboxUserError) &&
					/did not answer in time/.test(late.message) &&
					rows.events.join(",") === "saved" &&
					saved(open(rows)).refreshToken === "FAKE-REFRESH-TOKEN-1-not-a-real-token" &&
					leftIn(root).length === 0,
				late instanceof Error ? late.message : "it returned a token",
			);
		}
		expect("no line of the holder holds a token", !lines.some(line => SECRET.test(line)), `${lines.length} lines`);
	});

	await section("windlass", async () => {
		const binary = windlassBinary();
		if (binary === null || !existsSync(binary)) {
			info(
				`SKIP  no Windlass executable ${binary === null ? "from sandbox/fetch-windlass.sh" : `at ${binary}`}: set WLP_WINDLASS_BIN to one with \`login token --valid-for\``,
			);
			return;
		}
		const standin = new StandIn();
		await standin.start();
		try {
			// Two servers: each has its own runner and its own place for private directories. They share the
			// users' store (the actors' storage) and the key, and nothing else. A user's holder is in one
			// place, as the user's actor is: here it is server B's, so tokens are asked for, and sign-ins
			// adopted and forgotten, there.
			const rootA = join(scratch, "server-a");
			const rootB = join(scratch, "server-b");
			mkdirSync(rootA);
			mkdirSync(rootB);
			const lines: string[] = [];
			const log = (line: string) => void (lines.push(line), console.log(line));
			const rows = new Map<string, StoredSignIn>();
			const revoked: string[] = [];
			const commandsA = new WindlassSignIns(new LocalLoginRunner({ binary, tmpRoot: rootA, env: standin.env() }), {
				log,
			});
			const commandsB = new WindlassSignIns(new LocalLoginRunner({ binary, tmpRoot: rootB, env: standin.env() }), {
				log,
			});
			const serverA = memorySignIns({ commands: commandsA, rows, log, revoke: async user => void revoked.push(user) });
			const serverB = memorySignIns({ commands: commandsB, rows, log, revoke: async user => void revoked.push(user) });
			const { sealer } = serverB;
			const version = await new LocalLoginRunner({ binary, tmpRoot: rootA }).version();
			info(`Windlass ${version} at ${binary}, as a local process; its sign-in service is the stand-in in this process`);
			const stored = (uid: string) =>
				saved(
					cleanMaterial((JSON.parse(sealer.open("user", uid, rows.get(uid)!.sealed!)) as { files: unknown }).files),
				);
			/** The same sign-in with a token that is due: what time does to a saved sign-in. */
			const makeDue = (uid: string, minutes: number) => {
				const now = cleanMaterial(
					(JSON.parse(sealer.open("user", uid, rows.get(uid)!.sealed!)) as { files: unknown }).files,
				);
				const credentials = JSON.parse(now.files["auth.json"]!) as { expiresAt: number };
				credentials.expiresAt = Date.now() + minutes * 60_000;
				serverB.directory.put(uid, { files: { ...now.files, "auth.json": JSON.stringify(credentials) } });
				serverB.tokens.forget(uid);
			};
			/** A sign-in of `sub`, uploaded: adopted by the user's holder on server B, as the connect route hands it over. */
			const signIn = async (uid: string, sub: string) => {
				const material = standin.signIn(sub);
				await serverB.directory.adopt(uid, sealer.seal("user", uid, JSON.stringify(material)));
				return { uid };
			};

			// ---- adopted: the user's sign-in
			const uid = "u_ann";
			await signIn(uid, "fake-sub-ann");
			const account = await serverA.logins.status(uid);
			const row = rows.get(uid)!;
			expect(
				"adopt() puts the sign-in in the user's store, sealed for that user: status() reports who signed in from either server, and the stored row shows no token and no account",
				account?.sub === "fake-sub-ann" &&
					Math.abs((account.accessExpiresAt ?? 0) - (Date.now() + 3_600_000)) < 60_000 &&
					row.sealed !== null &&
					!SECRET.test(row.sealed) &&
					!row.sealed.includes("fake-sub-ann") &&
					!row.sealed.includes("@example"),
				`${row.sealed?.length} characters stored`,
			);
			const asAnother = await caught(serverB.directory.adopt("u_someone_else", row.sealed!));
			expect(
				"the stored blob is refused as another user's sign-in",
				asAnother instanceof Error && (await serverB.logins.status("u_someone_else")) === null,
			);

			// ---- the token: as it is while it is good
			let asked = commandsB.asked;
			const first = await serverB.tokens.current(uid);
			expect(
				"current() returns the access token Windlass saved at the sign-in, without a refresh: no request to the sign-in service, nothing saved again",
				/^FAKE-ACCESS-TOKEN-S\d+-/.test(first.accessToken) &&
					commandsB.asked === asked + 1 &&
					standin.count("refresh_token") === 0 &&
					first.accessToken === stored(uid).accessToken,
			);

			// ---- due: one refresh for many requests, saved before it is returned
			makeDue(uid, 12);
			const before = stored(uid);
			const order: string[] = [];
			const watched = rows.set.bind(rows);
			rows.set = (key, value) => (order.push("saved"), watched(key, value));
			asked = commandsB.asked;
			const many = await Promise.all(
				Array.from({ length: 6 }, () => serverB.tokens.current(uid).then(token => (order.push("returned"), token))),
			);
			rows.set = watched;
			const after = stored(uid);
			expect(
				"six requests at once for a token that is due: one run of Windlass, one refresh at the sign-in service, one new token for all six",
				many.every(token => token.accessToken === many[0]!.accessToken) &&
					/^FAKE-ACCESS-TOKEN-R\d+-/.test(many[0]!.accessToken) &&
					commandsB.asked === asked + 1 &&
					standin.count("refresh_token") === 1,
				`${commandsB.asked - asked} run, ${standin.count("refresh_token")} refresh`,
			);
			expect(
				"the refresh replaced the refresh token, and the new sign-in was in the store before any of the six got the token: the store holds the one refresh token the service still accepts",
				order[0] === "saved" &&
					order.filter(entry => entry === "saved").length === 1 &&
					after.refreshToken !== before.refreshToken &&
					standin.isGood(after.refreshToken) &&
					!standin.isGood(before.refreshToken) &&
					after.accessToken === many[0]!.accessToken &&
					leftIn(rootB).length === 0,
				order.join(", "),
			);
			const reused = await serverB.tokens.current(uid);
			expect(
				"the new token is reused: Windlass is not asked again",
				reused.accessToken === many[0]!.accessToken && commandsB.asked === asked + 1,
			);

			// ---- the window: a server dies between the refresh and the save
			makeDue(uid, 12);
			const lost = await commandsA.token(
				cleanMaterial((JSON.parse(sealer.open("user", uid, rows.get(uid)!.sealed!)) as { files: unknown }).files),
			);
			// `lost` is what a server that died right here would have had in memory: the service refreshed, nothing was saved.
			const refreshes = standin.count("refresh_token");
			const dead = await caught(serverB.tokens.current(uid));
			expect(
				"a refresh the service carried out and no server saved (the server died in between): the stored refresh token is used up, the next request is refused by the service, and the user is told to sign in with ChatGPT again",
				lost.ok &&
					refreshes === 2 &&
					!standin.isGood(stored(uid).refreshToken) &&
					dead instanceof SandboxUserError &&
					dead.message === SIGN_IN_EXPIRED &&
					standin.count("refresh_token") === 3,
				dead instanceof Error ? dead.message : "it returned a token",
			);
			expect(
				"status() still names the account: the sign-in is there, and no longer accepted",
				(await serverB.logins.status(uid))?.sub === "fake-sub-ann",
			);
			const renewed = await signIn(uid, "fake-sub-ann");
			const afterRenewal = await serverB.tokens.current(uid);
			expect(
				"signing in again replaces it, and tokens come again",
				renewed.uid === uid &&
					/^FAKE-ACCESS-TOKEN-S\d+-/.test(afterRenewal.accessToken) &&
					standin.isGood(stored(uid).refreshToken),
			);

			// ---- refused, and unwell
			makeDue(uid, 12);
			standin.refuse = { code: "invalid_grant", status: 400 };
			const refusal = await caught(serverB.tokens.current(uid));
			standin.refuse = { code: "server_error", status: 503 };
			const unwell = await caught(serverB.tokens.current(uid));
			standin.refuse = null;
			expect(
				"a refresh the service refuses (`invalid_grant`) is the user's to mend: sign in with ChatGPT again. One it could not do (`server_error`) is not, and says so with Windlass's code",
				refusal instanceof SandboxUserError &&
					refusal.message === SIGN_IN_EXPIRED &&
					unwell instanceof SignInRefreshError &&
					!(unwell instanceof SandboxUserError) &&
					unwell.code === "server_error",
				unwell instanceof Error ? `${unwell.name}: ${unwell.message}` : "",
			);
			expect("neither changed the stored sign-in", standin.isGood(stored(uid).refreshToken));

			// ---- another user: never the first one's token
			const ben = await signIn("u_ben", "fake-sub-ben");
			const [annsToken, bensToken] = await Promise.all([serverB.tokens.current(uid), serverB.tokens.current(ben.uid)]);
			expect(
				"two users' requests do not wait for each other and never get each other's token",
				ben.uid !== uid &&
					annsToken.accessToken !== bensToken.accessToken &&
					bensToken.accessToken === stored(ben.uid).accessToken &&
					annsToken.accessToken === stored(uid).accessToken,
			);

			// ---- replaced while its refresh runs
			makeDue(uid, 12);
			standin.delayMs = 5_000;
			const waiting = serverB.tokens.current(uid);
			const inFlight = await until(() => standin.refreshing === 1, 10_000);
			const start = Date.now();
			await signIn(uid, "fake-sub-ann");
			const got = await waiting;
			const took = Date.now() - start;
			standin.delayMs = 0;
			expect(
				"a new sign-in adopted while Windlass is refreshing the old one: the command is stopped, not waited for, and the waiting request is answered with the new sign-in's token",
				inFlight &&
					took < 4_500 &&
					/^FAKE-ACCESS-TOKEN-S\d+-/.test(got.accessToken) &&
					got.accessToken === stored(uid).accessToken &&
					leftIn(rootB).length === 0,
				`${took} ms, while the service would have answered the old refresh after 5000 ms`,
			);

			// ---- shorter than asked
			makeDue(uid, 12);
			standin.expiresIn = 600;
			const linesBefore = lines.length;
			asked = commandsB.asked;
			const short = await serverB.tokens.current(uid);
			const shortAgain = await serverB.tokens.current(uid);
			standin.expiresIn = 3600;
			const said = lines.slice(linesBefore).filter(line => line.includes("token.short"));
			expect(
				"when the service issues a token that lasts ten minutes, less than the twenty asked for, Windlass says so and the token is handed out as it is and reused; a line says it once",
				short.expiresAt - Date.now() < 11 * 60_000 &&
					short.expiresAt - Date.now() > 8 * 60_000 &&
					shortAgain.accessToken === short.accessToken &&
					commandsB.asked === asked + 1 &&
					said.length === 1 &&
					said[0]!.includes(`uid=${uid}`),
				`${Math.round((short.expiresAt - Date.now()) / 1000)} s left; ${said.length} line`,
			);

			// ---- forgotten
			asked = commandsB.asked;
			await serverB.logins.logout(uid);
			const gone = await caught(serverB.tokens.current(uid));
			expect(
				"logout() forgets the sign-in: the store's row holds none, status() is null on both servers, the provider was told to remove the token files of running turns, and current() says to sign in without asking Windlass",
				rows.get(uid)!.sealed === null &&
					(await serverA.logins.status(uid)) === null &&
					(await serverB.logins.status(uid)) === null &&
					revoked.includes(uid) &&
					gone instanceof SandboxUserError &&
					gone.message === NOT_SIGNED_IN &&
					commandsB.asked === asked,
			);
			expect(
				"the other user's sign-in is untouched",
				(await serverB.tokens.current(ben.uid)).accessToken === bensToken.accessToken,
			);

			expect("no private directory of either server is left", leftIn(rootA).length === 0 && leftIn(rootB).length === 0);
			expect(
				"every request went to the stand-in, as a tunnel to auth.openai.com",
				standin.tunnels.length > 0 &&
					standin.tunnels.every(tunnel => tunnel === "CONNECT auth.openai.com:443 HTTP/1.1"),
				`${standin.tunnels.length} tunnels, ${standin.requests.length} requests`,
			);
		} finally {
			await standin.stop();
		}
	});

	await section("actors", async () => {
		const binary = windlassBinary();
		if (binary === null || !existsSync(binary)) {
			info(
				`SKIP  no Windlass executable ${binary === null ? "from sandbox/fetch-windlass.sh" : `at ${binary}`}: set WLP_WINDLASS_BIN to one with \`login token --valid-for\``,
			);
			return;
		}
		const {
			engine: enginePort,
			http: [httpPort],
		} = await localListeners();
		const standin = new StandIn();
		await standin.start();
		const storage = join(scratch, "server-state");
		mkdirSync(storage);
		const privateRoot = join(scratch, "server-private");
		mkdirSync(privateRoot);
		const endpoint = `http://127.0.0.1:${enginePort}`;
		process.env.RIVET_RUN_ENGINE_PORT = String(enginePort); // Also used by this process's ActorSignInDirectory.
		let output = "";
		let child: ChildProcess | null = null;
		const reapEngine = () => {
			try {
				const runtime = JSON.parse(
					readFileSync(join(storage, ".rivetkit", "var", "engine", "runtime.json"), "utf8"),
				) as { pid?: number };
				if (typeof runtime.pid === "number") process.kill(runtime.pid, "SIGKILL");
			} catch {
				// No engine left, which is the point.
			}
		};
		/** A server as a deployment's: fake sandboxes, and the real sign-in with a Windlass of its own, pointed at the stand-in. It shares this process's secret, as two servers share theirs. */
		const startServer = async () => {
			const started = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
				cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../server"),
				env: {
					...process.env,
					// Only what is meant for the sign-in service goes to the stand-in: Windlass asks over HTTPS. The
					// server's own traffic to its engine is plain HTTP on this machine and must not be sent there.
					HTTPS_PROXY: standin.env().HTTPS_PROXY!,
					https_proxy: standin.env().HTTPS_PROXY!,
					NO_PROXY: "127.0.0.1,localhost",
					no_proxy: "127.0.0.1,localhost",
					NODE_EXTRA_CA_CERTS: standin.env().NODE_EXTRA_CA_CERTS!,
					WLP_SANDBOX: "fake",
					WLP_SIGNIN_RUNNER: "local",
					WLP_WINDLASS_BIN: binary,
					WLP_SIGNIN_TMPDIR: privateRoot,
					WLP_SECRET: config.signingKeys[0].secret.toString("utf8"),
					WLP_DEMO: "0",
					WLP_FAKE_DELAY_MS: "2",
					RIVETKIT_STORAGE_PATH: storage,
					WLP_HTTP_PORT: String(httpPort),
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			child = started;
			const keep = (chunk: Buffer) => (output += chunk.toString("utf8"));
			started.stdout?.on("data", keep);
			started.stderr?.on("data", keep);
			started.on("exit", () => {
				if (child === started) child = null;
			});
			const probe = createClient<Registry>(endpoint);
			try {
				const deadline = Date.now() + 120_000;
				for (;;) {
					if (child === null) throw new Error(`the server exited while starting: ${output.slice(-600)}`);
					const up = await fetch(`http://127.0.0.1:${httpPort}/health`).then(
						response => response.ok,
						() => false,
					);
					if (up) break;
					if (Date.now() > deadline) throw new Error("the server did not come up in two minutes");
					await wait(400);
				}
			} finally {
				await probe.dispose().catch(() => undefined);
			}
		};
		const killServer = async (signal: "SIGTERM" | "SIGKILL") => {
			const running = child;
			if (running !== null) {
				running.kill(signal);
				if (!(await until(() => child === null, 40_000))) running.kill("SIGKILL");
				await wait(500);
			}
			// The engine is the server's child and can outlive it; it must not keep the port.
			reapEngine();
			await until(() => {
				try {
					execFileSync("sh", ["-c", `! ss -ltn | grep -q ':${enginePort} '`], { stdio: "pipe" });
					return true;
				} catch {
					return false;
				}
			}, 20_000);
		};
		const linesOf = (what: string, uid: string) =>
			output.split("\n").filter(line => line.includes(`[wlp] ${what}`) && line.includes(`uid=${uid}`));

		const client = createClient<Registry>(endpoint);
		try {
			await startServer();
			info(
				`a server with fake sandboxes and the real sign-in: Windlass at ${binary}, its sign-in service the stand-in in this process`,
			);
			// This process is the second server: it has the same secret and no actors of its own.
			const second = new ActorSignInDirectory(serverSealer());

			// Attach a ChatGPT sign-in to an existing platform user, as `npx @windlassai/cli connect codex` does: the
			// files Windlass saved on the person's computer go to the connect route. Its token is due (ten minutes left).
			standin.expiresIn = 600;
			const uid = "u_existing";
			const { issueUserToken } = await import("../server/src/tokens.js");
			const auth = { token: issueUserToken({ uid, email: "platform@example.invalid", demo: false }, 0) };
			const user = client.user.getOrCreate([uid], { params: { token: auth.token } });
			const signedIn = standin.signIn("fake-sub-actors", "actors@example.invalid").files;
			await connectChatgpt(`http://127.0.0.1:${httpPort}`, user, {
				files: { "auth.json": signedIn["auth.json"] ?? "", "host-id": signedIn["host-id"] },
			});
			standin.expiresIn = 3600;
			const status = await user.chatgpt();
			expect(
				"connecting a ChatGPT plan preserves the platform profile and reports the plan email",
				(await user.me()).email === "platform@example.invalid" &&
					status.connected &&
					status.email === "actors@example.invalid" &&
					standin.requests.length === 0,
				`uid ${uid}; requests to the stand-in: ${standin.requests.join(", ")}`,
			);
			expect(
				"the second server reads the same from the user's actor",
				(await second.status(uid))?.sub === "fake-sub-actors" && (await second.status(`u_nobody${run}`)) === null,
			);

			// ---- the token: asked by the second server, six times at once, while the saved one is due
			const many = await Promise.all(Array.from({ length: 6 }, () => second.accessToken(uid)));
			const afterRefresh = await user.chatgpt();
			expect(
				"six requests at once from another server for a token that is due: the user's actor runs Windlass once, the service refreshes once, and all six get the one new token",
				many.every(token => token.accessToken === many[0]!.accessToken && token.expiresAt === many[0]!.expiresAt) &&
					/^FAKE-ACCESS-TOKEN-R\d+-/.test(many[0]!.accessToken) &&
					standin.count("refresh_token") === 1 &&
					linesOf("sign-in.refreshed", uid).length === 1,
				`${standin.count("refresh_token")} refresh, ${linesOf("sign-in.refreshed", uid).length} line`,
			);
			expect(
				"the refreshed sign-in is in the actor: it reports the new token's expiry",
				afterRefresh.accessExpiresAt === many[0]!.expiresAt && many[0]!.expiresAt - Date.now() > 55 * 60_000,
			);
			const wrongKey = await caught(new ActorSignInDirectory(createSealer(randomBytes(32))).accessToken(uid));
			expect(
				"the token travels sealed: a process that has the servers' token secret and not the sign-in key gets an answer it cannot open",
				wrongKey instanceof Error &&
					!(wrongKey instanceof SandboxUserError) &&
					/does not open/.test(wrongKey.message) &&
					!SECRET.test(wrongKey.message),
				wrongKey instanceof Error ? wrongKey.message.slice(0, 140) : "it got a token",
			);
			const nobody = await caught(second.accessToken(`u_nobody${run}`));
			await second.logout(`u_nobody${run}`);
			// The engine's own list of this server's `user` actors (the local engine's control plane, with its fixed development token).
			const listed = (await (
				await fetch(`${endpoint}/actors?namespace=default&name=user`, { headers: { Authorization: "Bearer default" } })
			).json()) as { actors?: Array<{ key: string }> };
			const keys = (listed.actors ?? []).map(actor => actor.key);
			expect(
				"a user who never signed in has no token, and asking, or forgetting, makes no actor for them",
				nobody instanceof SandboxUserError &&
					nobody.message === NOT_SIGNED_IN &&
					keys.some(key => key.includes(uid)) &&
					!keys.some(key => key.includes("u_nobody")),
				`${keys.length} user actor(s): ${keys.join(", ")}`,
			);

			// ---- the models of the account: listed by the real Windlass with that token, once, and kept in the user's actor
			const lists = await Promise.all([user.models(), user.models(), user.models()]);
			expect(
				"three requests at once for the user's models: Windlass lists the account's once on the user's token, without another refresh, and the answer says it is the account's",
				lists.every(
					list =>
						list.source === "account" &&
						typeof list.fetchedAt === "number" &&
						list.defaultModel === "gpt-6.1-sol" &&
						list.models.map(model => `${model.id}:${model.efforts.join("+")}`).join(" ") ===
							"gpt-6.1-sol:low+medium+high gpt-6-luna:low",
				) &&
					standin.count("models") === 1 &&
					standin.count("refresh_token") === 1 &&
					linesOf("models.listed", uid).length === 1,
				`${standin.count("models")} listing, ${standin.count("refresh_token")} refresh; ${JSON.stringify(lists[0]).slice(0, 200)}`,
			);
			const unknownModel = await caught(user.createSession({ profile: "docker-windlass-sandbox", model: "gpt-6-sol" }));
			expect(
				"a model the account does not offer is refused, though the platform's stand-in list has it",
				(unknownModel as { code?: string } | null)?.code === "bad_model" && standin.count("models") === 1,
				String((unknownModel as Error | null)?.message),
			);

			// ---- a hosted turn pays with the ChatGPT plan, which WLP_PLAN_USERS (unset on this server) leaves this user out of
			const profiles = (await (await fetch(`http://127.0.0.1:${httpPort}/platform/info`)).json()) as {
				profiles?: Array<{ id: string; available: boolean }>;
			};
			const profile = profiles.profiles?.find(entry => entry.available)?.id ?? "docker-windlass-sandbox";
			const session = await user.createSession({ profile: profile as never });
			const sessionHandle = client.agentSession.get([uid, session.id], { params: { token: auth.token } });
			const refused = (await caught(sessionHandle.prompt({ text: "hello" }))) as (Error & { code?: string }) | null;
			await wait(500);
			expect(
				"a hosted Windlass turn of a user WLP_PLAN_USERS leaves out is refused with the plan's sentence, and is handed no token",
				refused?.code === "harness_signed_out" &&
					/ChatGPT plan isn't enabled for hosted runs on this account/.test(refused.message) &&
					linesOf("token.handed", uid).length === 0 &&
					standin.count("refresh_token") === 1,
				`${refused?.code}: ${refused?.message}; ${linesOf("token.handed", uid).length} hand-over, ${standin.count("refresh_token")} refresh`,
			);
			await wait(1_000);
			await user.deleteSession(session.id).catch(() => undefined);

			// ---- the server dies; another takes its place
			await killServer("SIGKILL");
			await startServer();
			const afterDeath = await second.accessToken(uid);
			expect(
				"the server is killed and another is started over the same actor storage: the user's actor wakes with the refreshed sign-in and hands out the same token, without a refresh",
				afterDeath.accessToken === many[0]!.accessToken &&
					afterDeath.expiresAt === many[0]!.expiresAt &&
					standin.count("refresh_token") === 1,
				`${standin.count("refresh_token")} refresh in all`,
			);
			const afterWake = await user.models();
			expect(
				"and it wakes with the account's models: they are served from the actor's storage, and Windlass is not asked again",
				afterWake.source === "account" && afterWake.fetchedAt === lists[0]!.fetchedAt && standin.count("models") === 1,
			);

			// Everything the engine wrote, while the sign-in is there: it is in it sealed, and nothing of it is readable.
			let files = 0;
			let sealed = 0;
			const leaks: string[] = [];
			const walk = (dir: string) => {
				for (const entry of readdirSync(dir, { withFileTypes: true })) {
					const path = join(dir, entry.name);
					if (entry.isDirectory()) walk(path);
					else if (entry.isFile() && statSync(path).size < 256 * 1024 * 1024) {
						const text = readFileSync(path).toString("latin1");
						files += 1;
						if (text.includes("wlps1.")) sealed += 1;
						if (SECRET.test(text) || text.includes("fake-sub-actors")) leaks.push(path.replace(storage, ""));
					}
				}
			};
			walk(storage);
			expect(
				"the actor storage holds the sealed sign-in and nothing readable of it: no token, no code, no account id",
				leaks.length === 0 && sealed > 0,
				`${files} files read: sealed blobs in ${sealed}, something readable in ${leaks.length}${leaks.length === 0 ? "" : ` (${leaks.join(", ")})`}`,
			);

			// ---- forgotten, from the second server
			await second.logout(uid);
			const gone = await caught(second.accessToken(uid));
			expect(
				"logout() from the second server forgets the sign-in in the user's actor: no token, no account",
				gone instanceof SandboxUserError &&
					gone.message === NOT_SIGNED_IN &&
					(await second.status(uid)) === null &&
					(await user.chatgpt()).connected === false,
			);
			const signedOut = await user.models();
			expect(
				"and the account's models go with the sign-in: the stand-in list is served, it says why, and Windlass is not asked",
				signedOut.source === "signed-out" &&
					signedOut.fetchedAt === null &&
					signedOut.models.length === 3 &&
					standin.count("models") === 1,
				JSON.stringify(signedOut).slice(0, 160),
			);

			await killServer("SIGTERM");
			expect(
				"the server printed no token, and left no private directory",
				!SECRET.test(output) && leftIn(privateRoot).length === 0,
				`${output.split("\n").length} lines of server output read`,
			);
		} finally {
			await client.dispose().catch(() => undefined);
			await killServer("SIGKILL");
			await standin.stop();
		}
	});

	await section("cleanup", async () => {
		rmSync(scratch, { recursive: true, force: true });
		expect("this check's own files are removed", !existsSync(scratch));
		const defaultRoot = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
		const mine = leftIn(defaultRoot).filter(name => {
			try {
				return (
					statSync(join(defaultRoot, name)).uid === process.getuid?.() &&
					Date.now() - statSync(join(defaultRoot, name)).mtimeMs < 60_000
				);
			} catch {
				return false;
			}
		});
		expect("no private directory was made outside this check's own places", mine.length === 0, mine.join(", "));
		const leaked = output.filter(line => SECRET.test(line));
		expect(
			"no token is in anything this check printed",
			leaked.length === 0,
			`${output.length} lines read${leaked.length === 0 ? "" : `; first: ${leaked[0]!.replace(SECRET, "<a token>").slice(0, 120)}`}`,
		);
	});

	tally.summary(true);
}

main()
	.catch(error => {
		tally.failures += 1;
		console.error(error);
	})
	.finally(() => {
		rmSync(scratch, { recursive: true, force: true });
		process.exit(tally.failures === 0 ? 0 : 1);
	});
