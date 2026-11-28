/**
 * End-to-end check of the connection browsers are handed and of its renewal: the web app's own client
 * (web/src/api/rivet.ts, with RivetKit's real client under it) against a real server, through an
 * engine that asks for tokens and lets them run out. Run with:
 *
 *   cd server && npx tsx ../scripts/connection-e2e.ts
 *
 * The local engine asks for no token and issues none, so this check stands a front before it, on a
 * port of its own, that does what a cluster's engine does at its edge (guard-core `auth.rs` and
 * `errors.rs`, pegboard-gateway `routes.rs`, 3.1.1):
 *
 *   - `POST /auth/tokens` with the admin token issues a JWT, here good for twelve seconds;
 *   - every other request, and every WebSocket open, must carry such a token, wherever RivetKit's
 *     client puts it: in the actor's selector (`/gateway/<actor id>@<token>/`), in `rvt-token`, in
 *     `x-rivet-token`, as a bearer, or as the `rivet_token.` subprotocol. Without one it is refused with 401
 *     `auth.invalid_token`, with one that ran out with 401 `auth.token_expired` and the header
 *     `x-rivet-error`; a WebSocket is accepted and closed with 1008 and that reason. What is let
 *     through goes to the local engine;
 *   - a WebSocket that is open is not looked at again, as on the engine: it outlives its token;
 *   - a token may create actors only when its grants say so: the browser's (CONNECTION_GRANTS) do not,
 *     and a `getOrCreate` with one is refused with 403 `auth.forbidden`.
 *
 * The server is started as a deployment's: with the (made-up) admin token and the front as
 * WLP_PUBLIC_ENDPOINT. The client is given the platform's address and nothing else. Sandboxes are the
 * fake layer's. The front and the server use OS-assigned ports.
 *
 * What it shows, with turns that really run: the web app signs in, creates an agent and runs a turn
 * with a token it was handed; a feed stays open and delivers after its token ran out; the next prompt
 * after that is sent with a new token and no refusal; a feed whose connection drops comes back with a
 * new token; and, with a browser clock that runs behind (the token's `exp` says an hour more than it
 * has), a refused prompt and a refused reconnect are both renewed and go through, unseen by the caller.
 * With GitLab configured, the web app also opens the user's GitLab settings with only that token.
 *
 * Prints one PASS/FAIL line per check and exits 1 if any failed. No token is printed.
 */

import { localListeners } from "./check-listeners.js";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer, request as httpRequest } from "node:http";
import { type AddressInfo, type Socket, connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AuthResult,
	PlatformConnection,
	PlatformInfo,
	SessionSnapshot,
	SessionSummary,
	TimelineItem,
} from "../server/src/contract.js";
import { Report } from "./check-report.js";
import { sleep, waitFor } from "./check-wait.js";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../server");
const {
	engine,
	http: [HTTP_PORT],
} = await localListeners();
const ENGINE = { host: "127.0.0.1", port: engine };
const API = `http://127.0.0.1:${HTTP_PORT}`;
const ADMIN = "FAKE-ADMIN-TOKEN-for-connection-e2e";
/** How long the front's tokens last. The server hands one out until half of that is gone. */
const TOKEN_MS = 12_000;

const tally = new Report({ failure: "dash", fold: false });
const { check } = tally;
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------------------------
// The front: an engine's edge that asks for tokens
// ---------------------------------------------------------------------------------------------

interface Issued {
	number: number;
	expiresAt: number;
	/** Whether its grants let it create actors. */
	creates: boolean;
}

/** A request that creates an actor when none has the key: a gateway query or the REST API's. */
function creates(method: string | undefined, path: string): boolean {
	const url = new URL(path, "http://front");
	return (
		url.searchParams.get("rvt-method") === "getOrCreate" ||
		(url.pathname === "/actors" && (method === "PUT" || method === "POST"))
	);
}

class Front {
	/** Every token issued, by its text. */
	readonly tokens = new Map<string, Issued>();
	/** What was let through, by the number of the token it carried. */
	readonly served: Array<{ token: number; kind: "http" | "ws" }> = [];
	readonly refused: Array<{ code: string; kind: "http" | "ws"; token: number | null }> = [];
	/** Requests to create an actor refused for a token whose grants do not allow it. */
	readonly forbidden: string[] = [];
	/** Added to the `exp` a token claims: what RivetKit's client reads, and a browser clock that runs behind. */
	claimAheadMs = 0;
	private readonly open = new Set<Socket>();
	private readonly server = createServer((request, response) => this.http(request, response));
	url = "";

	async start(): Promise<void> {
		this.server.on("upgrade", (request, socket, head) => this.upgrade(request, socket as Socket, head));
		await new Promise<void>(done => this.server.listen(0, "127.0.0.1", done));
		const { port } = this.server.address() as AddressInfo;
		this.url = `http://127.0.0.1:${port}`;
		console.log(`Connection proxy port: ${port}`);
	}

	async stop(): Promise<void> {
		this.dropSockets();
		// Not waited for: a WebSocket the server handed over is no longer its to count, and its close may never be reported.
		this.server.close();
		this.server.closeAllConnections();
		await sleep(100);
	}

	/** Cuts every open WebSocket, as a network that drops does. */
	dropSockets(): number {
		const count = this.open.size;
		for (const socket of this.open) socket.destroy();
		this.open.clear();
		return count;
	}

	get openSockets(): number {
		return this.open.size;
	}

	private issue(grants: unknown): { token: string; issued_ts: number; expires_ts: number } {
		const now = Date.now();
		const number = this.tokens.size + 1;
		const expiresAt = now + TOKEN_MS;
		const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
		const token = `${part({ alg: "none", typ: "JWT" })}.${part({ exp: Math.floor((expiresAt + this.claimAheadMs) / 1000), jti: `${number}-${randomBytes(6).toString("hex")}` })}.FAKE`;
		const creates =
			Array.isArray(grants) &&
			grants.some(
				grant => grant?.resource === "actor" && Array.isArray(grant.operations) && grant.operations.includes("create"),
			);
		this.tokens.set(token, { number, expiresAt, creates });
		return { token, issued_ts: now, expires_ts: expiresAt };
	}

	/**
	 * The token a request carries, looked for where the engine looks (pegboard-gateway `routes.rs`): the
	 * actor's selector when it names an actor directly, then `rvt-token`, then the transport. `path` is
	 * the request's own with that token replaced by the one the local engine knows.
	 */
	private presented(request: IncomingMessage, protocols: string[] = []): { token: string | undefined; path: string } {
		const raw = request.url ?? "/";
		const url = new URL(raw, "http://front");
		const selector =
			url.pathname.split("/")[1] === "gateway" && !url.searchParams.has("rvt-method")
				? (url.pathname.split("/")[2] ?? "")
				: "";
		const inSelector = selector.includes("@")
			? decodeURIComponent(selector.slice(selector.indexOf("@") + 1))
			: undefined;
		const inUrl = inSelector ?? url.searchParams.get("rvt-token") ?? undefined;
		const header = request.headers["x-rivet-token"];
		const token =
			inUrl ??
			protocols.find(protocol => protocol.startsWith("rivet_token."))?.slice("rivet_token.".length) ??
			(typeof header === "string" ? header : undefined) ??
			/^bearer (.+)$/i.exec(request.headers.authorization ?? "")?.[1];
		const path =
			inUrl === undefined ? raw : raw.split(encodeURIComponent(inUrl)).join("default").split(inUrl).join("default");
		return { token, path };
	}

	/** Null when the token is good for the request; otherwise the engine's code for the refusal. */
	private judge(token: string | undefined, kind: "http" | "ws", creating = false): string | null {
		const known = token === undefined ? undefined : this.tokens.get(token);
		const code =
			known === undefined
				? "invalid_token"
				: Date.now() >= known.expiresAt
					? "token_expired"
					: creating && !known.creates
						? "forbidden"
						: null;
		if (code === null) this.served.push({ token: known!.number, kind });
		else this.refused.push({ code, kind, token: known?.number ?? null });
		return code;
	}

	private http(request: IncomingMessage, response: ServerResponse): void {
		const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
			response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
			response.end(JSON.stringify(body));
		};
		const bearer = /^bearer (.+)$/i.exec(request.headers.authorization ?? "")?.[1];
		if (request.method === "POST" && request.url === "/auth/tokens") {
			const chunks: Buffer[] = [];
			request.on("data", chunk => chunks.push(chunk));
			request.on("end", () => {
				if (bearer !== ADMIN)
					return send(
						401,
						{ group: "auth", code: "invalid_token", message: "Authentication token is invalid." },
						{ "x-rivet-error": "auth.invalid_token" },
					);
				let grants: unknown = null;
				try {
					grants = JSON.parse(Buffer.concat(chunks).toString("utf8")).grants;
				} catch {
					/* No grants: a token that may not create. */
				}
				send(200, this.issue(grants));
			});
			return;
		}
		const { token, path } = this.presented(request);
		// The engine's own facts are open to anyone, as on the engine (api-public `metadata.rs`): RivetKit's
		// client asks for them first, and without a token.
		if (path.split("?")[0] !== "/metadata") {
			const creating = creates(request.method, path);
			const code = this.judge(token, "http", creating);
			if (code !== null) {
				request.resume();
				if (code === "forbidden") {
					this.forbidden.push(`${request.method} ${new URL(path, "http://front").pathname}`);
					return send(
						403,
						{ group: "auth", code, message: "This token may not create actors." },
						{ "x-rivet-error": `auth.${code}` },
					);
				}
				const message =
					code === "token_expired" ? "Authentication token has expired." : "Authentication token is invalid.";
				return send(401, { group: "auth", code, message }, { "x-rivet-error": `auth.${code}` });
			}
		}
		// Let through: to the local engine, with the token it knows in place of the front's.
		const headers: Record<string, string | string[] | undefined> = {
			...request.headers,
			host: `${ENGINE.host}:${ENGINE.port}`,
		};
		if (headers["x-rivet-token"] !== undefined) headers["x-rivet-token"] = "default";
		if (headers.authorization !== undefined) headers.authorization = "Bearer default";
		const upstream = httpRequest({ ...ENGINE, method: request.method, path, headers }, answer => {
			response.writeHead(answer.statusCode ?? 502, answer.headers);
			answer.pipe(response);
		});
		upstream.on("error", () => {
			if (!response.headersSent)
				send(502, { group: "guard", code: "upstream_error", message: "The engine did not answer." });
			else response.destroy();
		});
		request.pipe(upstream);
	}

	private upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
		const protocols = (request.headers["sec-websocket-protocol"] ?? "").split(",").map(protocol => protocol.trim());
		const { token, path } = this.presented(request, protocols);
		const creating = creates(request.method, path);
		const code = this.judge(token, "ws", creating);
		if (code === "forbidden") this.forbidden.push(`WS ${new URL(path, "http://front").pathname}`);
		if (code !== null) {
			// A browser cannot read a refused upgrade, so the engine accepts the socket and closes it with the reason.
			const accept = createHash("sha1")
				.update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
				.digest("base64");
			const chosen = protocols.find(protocol => !protocol.startsWith("rivet_token."));
			const reason = Buffer.from(`auth.${code}#front`);
			const frame = Buffer.concat([Buffer.from([0x88, 2 + reason.length, 1008 >> 8, 1008 & 0xff]), reason]);
			socket.write(
				`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${chosen ? `Sec-WebSocket-Protocol: ${chosen}\r\n` : ""}\r\n`,
			);
			socket.end(frame);
			return;
		}
		const upstream = connect(ENGINE.port, ENGINE.host, () => {
			const lines = [`${request.method} ${path} HTTP/1.1`];
			for (let i = 0; i < request.rawHeaders.length; i += 2) {
				const name = request.rawHeaders[i]!;
				let value = request.rawHeaders[i + 1]!;
				if (name.toLowerCase() === "host") value = `${ENGINE.host}:${ENGINE.port}`;
				if (name.toLowerCase() === "sec-websocket-protocol")
					value = protocols
						.map(protocol => (protocol.startsWith("rivet_token.") ? "rivet_token.default" : protocol))
						.join(", ");
				lines.push(`${name}: ${value}`);
			}
			upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
			if (head.length > 0) upstream.write(head);
			socket.pipe(upstream);
			upstream.pipe(socket);
		});
		this.open.add(socket);
		const end = () => {
			this.open.delete(socket);
			socket.destroy();
			upstream.destroy();
		};
		socket.on("close", end);
		socket.on("error", end);
		upstream.on("close", end);
		upstream.on("error", end);
	}
}

// ---------------------------------------------------------------------------------------------
// The server, and the web app's client
// ---------------------------------------------------------------------------------------------

class Server {
	private child: ChildProcess | null = null;
	output = "";
	readonly storage = mkdtempSync(join(tmpdir(), "wlp-connection-e2e-"));

	async start(publicEndpoint: string): Promise<void> {
		const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
			cwd: SERVER_DIR,
			env: {
				...process.env,
				WLP_DEMO: "1",
				WLP_SANDBOX: "fake",
				WLP_SECRET: randomBytes(24).toString("hex"),
				RIVETKIT_STORAGE_PATH: this.storage,
				RIVET_RUN_ENGINE_PORT: String(ENGINE.port),
				WLP_HTTP_PORT: String(HTTP_PORT),
				WLP_FAKE_DELAY_MS: "15",
				RIVET_ADMIN_TOKEN: ADMIN,
				WLP_PUBLIC_ENDPOINT: publicEndpoint,
				// GitLab is configured; its settings are read without reaching the instance, which is never asked.
				WLP_GITLAB_BASE_URL: "http://127.0.0.1:9",
				WLP_GITLAB_CLIENT_ID: "connection-e2e",
				WLP_GITLAB_CLIENT_SECRET: "connection-e2e-client-secret",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.child = child;
		const keep = (chunk: Buffer) => (this.output += chunk.toString("utf8"));
		child.stdout?.on("data", keep);
		child.stderr?.on("data", keep);
		child.on("exit", () => {
			if (this.child === child) this.child = null;
		});
		await waitFor(
			"the server to answer",
			async () => {
				if (!this.child) throw new Error(`the server exited while starting:\n${this.output.slice(-1500)}`);
				try {
					return (await fetch(`${API}/platform/info`)).ok;
				} catch {
					return false;
				}
			},
			120_000,
			400,
		);
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (child) {
			child.kill("SIGTERM");
			await waitFor("the server to exit", () => this.child === null, 40_000, 100).catch(() => child.kill("SIGKILL"));
			await sleep(300);
		}
		try {
			const runtime = JSON.parse(
				readFileSync(join(this.storage, ".rivetkit", "var", "engine", "runtime.json"), "utf8"),
			) as { pid?: number };
			if (typeof runtime.pid === "number") process.kill(runtime.pid, "SIGKILL");
		} catch {
			// No engine left, which is the point.
		}
		rmSync(this.storage, { recursive: true, force: true });
	}
}

/** The parts of the web app's `PlatformClient` this check uses (web/src/api/client.ts). */
interface WebClient {
	readonly endpoint: string | null;
	info(): Promise<PlatformInfo>;
	login: { demo(): Promise<AuthResult> };
	user(auth: AuthResult): {
		createSession(input: { profile: string }): Promise<SessionSummary>;
		listSessions(): Promise<SessionSummary[]>;
		deleteSession(id: string): Promise<void>;
		gitlab(): Promise<{ state: string }>;
		watch(feed: { onSessions(sessions: SessionSummary[]): void; onConnection?(state: string): void }): () => void;
	};
	session(
		auth: AuthResult,
		id: string,
	): {
		prompt(input: { text: string }): Promise<{ turn: number; steered: boolean }>;
		open(feed: {
			onSnapshot(snapshot: SessionSnapshot): void;
			onItem(item: TimelineItem): void;
			onDelta(delta: unknown): void;
			onSummary(summary: SessionSummary): void;
			onQuestion(question: unknown): void;
			onConnection(state: string, error?: Error): void;
		}): () => void;
	};
	dispose(): void;
}

async function main(): Promise<void> {
	const front = new Front();
	await front.start();
	const server = new Server();
	// The web app's module is loaded by its address, so that the server's type check does not take the web app in.
	const webModule = "../web/src/api/rivet.ts";
	const { createRivetClient } = (await import(webModule)) as {
		createRivetClient(built: string, api: string): WebClient;
	};
	let client: WebClient | null = null;

	try {
		await server.start(front.url);
		// Built with an endpoint nothing listens on: only the server's answer can make this client work.
		client = createRivetClient("http://127.0.0.1:9", API);
		const web = client;

		let auth!: AuthResult;
		let session!: SessionSummary;
		const feed = { states: [] as string[], snapshots: 0, items: [] as TimelineItem[], status: "" };
		const sessions = { states: [] as string[], lists: 0 };
		let closeFeed: () => void = () => undefined;
		let closeList: () => void = () => undefined;
		const tokensUsed = (from: number) => [...new Set(front.served.slice(from).map(entry => entry.token))];
		/** Sends a prompt and waits until the feed has seen its turn end. */
		const turn = async (text: string) => {
			const before = feed.items.length;
			const result = await web.session(auth, session.id).prompt({ text });
			await waitFor(`turn ${result.turn} to end`, () => feed.status === "idle" && feed.items.length > before, 30_000);
			return result;
		};

		await check("the server tells the web app where the engine is, and hands it a token", async () => {
			const connection = (await (await fetch(`${API}/platform/connection`)).json()) as PlatformConnection;
			assert(
				connection.endpoint === front.url && connection.namespace === "default",
				`the server answered endpoint ${connection.endpoint}, namespace ${connection.namespace}`,
			);
			assert(
				connection.token !== null && front.tokens.has(connection.token.token),
				"the token is not one the engine issued",
			);
			assert(
				connection.token.validForMs > TOKEN_MS / 2 - 500 && connection.token.validForMs <= TOKEN_MS,
				`validForMs is ${connection.token.validForMs}`,
			);
			assert(
				!server.output.includes(ADMIN) && ![...front.tokens.keys()].some(token => server.output.includes(token)),
				"a token is in the server's output",
			);
			return `the engine made it last ${TOKEN_MS / 1000} s, not the hour asked for; ${Math.round(connection.token.validForMs / 100) / 10} s left when handed out`;
		});

		await check(
			"a request without a token, or with one the engine does not know, is refused by this engine",
			async () => {
				const bare = await fetch(`${front.url}/actors?namespace=default&name=user`);
				const wrong = await fetch(`${front.url}/actors?namespace=default&name=user`, {
					headers: { authorization: "Bearer default" },
				});
				assert(
					bare.status === 401 && wrong.status === 401 && wrong.headers.get("x-rivet-error") === "auth.invalid_token",
					`it answered ${bare.status} and ${wrong.status}`,
				);
				front.refused.length = 0;
				return "401 auth.invalid_token: what worked on the local engine does not work here";
			},
		);

		await check("the web app, built with no token: demo sign-in, a new agent, its feed, and a turn", async () => {
			const info = await web.info();
			const profile = info.profiles.find(candidate => candidate.available);
			assert(profile, "no available profile");
			auth = await web.login.demo();
			session = await web.user(auth).createSession({ profile: profile.id });
			closeList = web
				.user(auth)
				.watch({ onSessions: () => (sessions.lists += 1), onConnection: state => sessions.states.push(state) });
			closeFeed = web.session(auth, session.id).open({
				onSnapshot: snapshot => {
					feed.snapshots += 1;
					feed.status = snapshot.summary.status;
				},
				onItem: item => feed.items.push(item),
				onDelta: () => undefined,
				onSummary: summary => (feed.status = summary.status),
				onQuestion: () => undefined,
				onConnection: state => feed.states.push(state),
			});
			await waitFor("the feeds to connect", () => feed.snapshots === 1 && sessions.lists >= 1, 20_000);
			const first = await turn("List the files here.");
			assert(
				front.refused.length === 0,
				`the engine refused ${front.refused.length} request(s): ${JSON.stringify(front.refused)}`,
			);
			assert(web.endpoint === front.url, `the client names ${web.endpoint} as its endpoint`);
			return `turn ${first.turn} ran; ${feed.items.length} items on the feed; ${front.served.length} requests let through, none refused; ${front.openSockets} feeds open`;
		});

		await check(
			"with GitLab configured, the web app opens the user's GitLab settings with a token that cannot create actors",
			async () => {
				const refusedBefore = front.refused.length;
				const connection = (await (await fetch(`${API}/platform/connection`)).json()) as PlatformConnection;
				assert(connection.token, "the server handed out no token");
				// What the web app did before: create the GitLab actor from the browser. The token does not allow it.
				const query = new URLSearchParams({
					"rvt-namespace": "default",
					"rvt-method": "getOrCreate",
					"rvt-runner": "default",
					"rvt-key": `${auth.profile.uid}-probe`,
					"rvt-token": connection.token.token,
				});
				const created = await fetch(`${front.url}/gateway/userGitlab/action/gitlab?${query}`, { method: "POST" });
				assert(
					created.status === 403 && created.headers.get("x-rivet-error") === "auth.forbidden",
					`creating an actor with the browser's token answered ${created.status}`,
				);
				front.forbidden.length = 0;
				const status = await web.user(auth).gitlab();
				assert(status.state === "disconnected", `GitLab settings say ${JSON.stringify(status)}`);
				assert(front.forbidden.length === 0, `the web app tried to create: ${front.forbidden.join(", ")}`);
				const refusals = front.refused.splice(refusedBefore);
				assert(
					refusals.length === 1 && refusals[0]!.code === "forbidden",
					`the engine refused ${JSON.stringify(refusals)}`,
				);
				return "a getOrCreate with the browser's token is refused 403 auth.forbidden; the web app reads GitLab settings (disconnected) with no creation";
			},
		);

		await check(
			"a feed that is open stays open and delivers after its token ran out, and the next prompt goes with a new token",
			async () => {
				const firstToken = Math.min(...tokensUsed(0));
				const expiresAt = [...front.tokens.values()].find(token => token.number === firstToken)!.expiresAt;
				await sleep(Math.max(0, expiresAt - Date.now()) + 1_500);
				assert(front.openSockets === 2, `${front.openSockets} feeds are open after the token ran out`);
				const servedBefore = front.served.length;
				const snapshotsBefore = feed.snapshots;
				const second = await turn("And now?");
				const used = tokensUsed(servedBefore);
				assert(front.refused.length === 0, `the engine refused ${JSON.stringify(front.refused)}`);
				assert(
					used.length >= 1 && used.every(token => token > firstToken),
					`the prompt was sent with token ${used.join(", ")}; the first was ${firstToken}`,
				);
				assert(
					feed.snapshots === snapshotsBefore && !feed.states.includes("reconnecting"),
					"the feed was opened again",
				);
				return `token ${firstToken} ran out; turn ${second.turn} was sent with token ${used.join(", ")} and nothing was refused; the feed, opened with token ${firstToken}, delivered it without reconnecting`;
			},
		);

		await check("a feed whose connection drops comes back by itself, with a token that is good", async () => {
			await sleep(TOKEN_MS + 1_000);
			const servedBefore = front.served.length;
			const snapshotsBefore = feed.snapshots;
			const dropped = front.dropSockets();
			await waitFor(
				"the feeds to come back",
				() => feed.snapshots > snapshotsBefore && front.openSockets === 2,
				30_000,
			);
			const used = front.served
				.slice(servedBefore)
				.filter(entry => entry.kind === "ws")
				.map(entry => entry.token);
			assert(front.refused.length === 0, `the engine refused ${JSON.stringify(front.refused)}`);
			assert(
				feed.states.includes("reconnecting") && feed.states.at(-1) === "connected",
				`the feed went ${feed.states.join(" > ")}`,
			);
			const third = await turn("Still there?");
			return `${dropped} feeds cut; both back with token ${[...new Set(used)].join(", ")}, none refused; the feed went ${feed.states.slice(-2).join(" > ")}; turn ${third.turn} ran`;
		});

		await check(
			"a browser whose clock runs behind: a prompt the engine refuses is renewed and sent again, and the caller sees nothing",
			async () => {
				// From here the tokens claim an hour more than they have, so RivetKit takes a token that ran out for good.
				front.claimAheadMs = 60 * 60 * 1000;
				await sleep(TOKEN_MS + 1_000);
				await web.user(auth).listSessions();
				const liar = Math.max(...front.served.map(entry => entry.token));
				const expiresAt = [...front.tokens.values()].find(token => token.number === liar)!.expiresAt;
				await sleep(Math.max(0, expiresAt - Date.now()) + 1_000);
				front.refused.length = 0;
				const servedBefore = front.served.length;
				const fourth = await turn("After the clock went wrong.");
				const refusals = front.refused.filter(entry => entry.kind === "http");
				assert(
					refusals.length === 1 && refusals[0]!.code === "token_expired" && refusals[0]!.token === liar,
					`the engine refused ${JSON.stringify(front.refused)}`,
				);
				const used = tokensUsed(servedBefore);
				assert(
					used.every(token => token > liar),
					`sent again with token ${used.join(", ")}`,
				);
				return `token ${liar} claimed an hour more than it had; the engine refused the prompt once (auth.token_expired), it went through with token ${used.join(", ")}, and turn ${fourth.turn} ran`;
			},
		);

		await check("and a feed that reconnects with such a token is refused once, renewed, and connected", async () => {
			const current = Math.max(...front.served.map(entry => entry.token));
			const expiresAt = [...front.tokens.values()].find(token => token.number === current)!.expiresAt;
			await sleep(Math.max(0, expiresAt - Date.now()) + 1_000);
			front.refused.length = 0;
			const snapshotsBefore = feed.snapshots;
			front.dropSockets();
			await waitFor(
				"the feeds to come back",
				() => feed.snapshots > snapshotsBefore && front.openSockets === 2,
				30_000,
			);
			const refusals = front.refused.filter(entry => entry.kind === "ws");
			assert(
				refusals.length >= 1 && refusals.every(entry => entry.code === "token_expired"),
				`the engine refused ${JSON.stringify(front.refused)}`,
			);
			assert(
				feed.states.at(-1) === "connected" && !feed.states.includes("failed"),
				`the feed went ${feed.states.join(" > ")}`,
			);
			const fifth = await turn("Last one.");
			return `${refusals.length} WebSocket open(s) refused with auth.token_expired, then accepted with a new token; the feed never failed; turn ${fifth.turn} ran`;
		});

		await check("the agent is deleted, and no token is in the server's output", async () => {
			closeFeed();
			closeList();
			await web.user(auth).deleteSession(session.id);
			assert(
				(await web.user(auth).listSessions()).every(entry => entry.id !== session.id),
				"the session is still listed",
			);
			assert(
				!server.output.includes(ADMIN) && ![...front.tokens.keys()].some(token => server.output.includes(token)),
				"a token is in the server's output",
			);
			assert(!server.output.includes("connection.token_failed"), "the server failed to issue a token");
			return `${front.tokens.size} tokens issued in all, for ${front.served.length} requests and WebSocket opens`;
		});
	} finally {
		client?.dispose();
		await server.stop();
		await front.stop();
	}
	tally.summary(true);
}

main()
	.catch(error => {
		tally.failures += 1;
		console.error(error instanceof Error ? error.message : "the check failed");
	})
	.finally(() => process.exit(tally.failures === 0 ? 0 : 1));
