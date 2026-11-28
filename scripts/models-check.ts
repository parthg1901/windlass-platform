/**
 * The models a user may choose, on their own: no server, no sandbox, no ChatGPT account, and nothing
 * sent anywhere but to a stand-in in this process (server/src/account-models.ts, and `models` in
 * server/src/signin/commands.ts).
 *
 *   cd server && npx tsx ../scripts/models-check.ts
 *
 * What it holds to. What Windlass prints is read line by line, and half a list is no list. A model
 * and an effort are held against the user's list, the effort against its model's own. The list is
 * kept in the user's storage under the generation of the sign-in it was listed with: listed once
 * for all who ask at once, served for an hour without asking again, served on while a later listing
 * fails, never served after its sign-in was forgotten or replaced, and never waited on for longer
 * than a few seconds. Where there is none, the stand-in is served, and the answer says why. The
 * storage is a SQLite database in memory, behind a door that makes every statement wait a little, as
 * the actor's database does.
 *
 * With a Windlass executable at hand (WLP_WINDLASS_BIN, or the released one the build scripts keep
 * in ~/.cache/windlass-platform), the listing is the real one: `windlass --models --json` as a
 * local process, on a made-up access token handed in through a file, with a stand-in for the
 * provider's endpoint as its HTTPS proxy. Windlass asks for a tunnel to api.openai.com:443 and the
 * stand-in answers on that tunnel itself; nothing is forwarded anywhere.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer as createHttpServer } from "node:http";
import { type AddressInfo, type Server, type Socket, createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TLSSocket } from "node:tls";
import {
	AccountModels,
	type ListedModels,
	MODELS_TABLE,
	ModelProblem,
	type ModelsDb,
	type ModelsSource,
	STAND_IN_MODELS,
	checkEffort,
	chosenModel,
	standInModels,
	turnEffort,
} from "../server/src/account-models.js";
import type { ModelList } from "../server/src/contract.js";
import { WindlassSignIns, parseModels } from "../server/src/signin/commands.js";
import { LocalLoginRunner, TMP_PREFIX } from "../server/src/signin/runner.js";
import { OkReport } from "./check-report.js";
import { sleep as wait } from "./check-wait.js";

const tally = new OkReport();
const { expect } = tally;

const plain = (value: unknown) => JSON.stringify(value);
const caught = <T>(promise: Promise<T>) =>
	promise.then(
		() => null,
		(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
	);

// ---- what Windlass prints ----------------------------------------------------------------------------

{
	const printed = [
		`{"id":"gpt-6.1-sol","description":"GPT-6.1 Sol","efforts":["low","medium","high","xhigh"],"isDefault":false}`,
		`{"id":"gpt-6-luna","description":null,"efforts":["low","medium"],"isDefault":true}`,
		`{"id":"gpt-7-nova","description":"GPT-7 Nova","efforts":[],"isDefault":false}`,
	];
	const listed = parseModels(`${printed.join("\n")}\n`);
	expect(
		"each line is a model with its own efforts, and the default is the one Windlass marks",
		plain(listed) ===
			plain({
				models: [
					{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh"] },
					{ id: "gpt-6-luna", name: null, efforts: ["low", "medium"] },
					{ id: "gpt-7-nova", name: "GPT-7 Nova", efforts: [] },
				],
				defaultModel: "gpt-6-luna",
			}),
		plain(listed),
	);
	expect(
		"where Windlass marks none, the first is the default",
		parseModels(printed[0]!)?.defaultModel === "gpt-6.1-sol",
	);
	const table =
		"* gpt-6.1-sol  effort: low, medium  GPT-6.1 Sol\n  gpt-6-luna\n\n* the default when --model is not given\n";
	const broken = [
		"",
		"\n\n",
		table,
		`${printed[0]}\nwindlass: something else`,
		`{"id":"","efforts":[]}`,
		`{"id":"a"}`,
		`{"id":"a","efforts":"low"}`,
		`{"id":"a","efforts":[1]}`,
		`[]`,
		`"a"`,
		`${printed[0]}\n${printed[0]}`,
		`{"id":"a\\u0007","efforts":[]}`,
	];
	expect(
		"the table for people, half a list, a line that is no model, a model named twice and no model at all are no list",
		broken.every(text => parseModels(text) === null),
		plain(broken.map(text => parseModels(text) !== null)),
	);
}

// ---- a choice held against a list --------------------------------------------------------------------

const PLAN: ListedModels = {
	models: [
		{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh"] },
		{ id: "gpt-6-luna", name: null, efforts: ["low", "medium"] },
		{ id: "gpt-7-nova", name: "GPT-7 Nova", efforts: [] },
	],
	defaultModel: "gpt-6-luna",
};

function problem(step: () => unknown): string | null {
	try {
		step();
		return null;
	} catch (error) {
		return error instanceof ModelProblem ? `${error.code}: ${error.message}` : `another error: ${String(error)}`;
	}
}

{
	const account: ModelList = { source: "account", ...PLAN, fetchedAt: 1 };
	const standIn = standInModels("unavailable");
	expect(
		"no model asked for is the list's default, and one of the list's is taken",
		chosenModel(account, undefined) === "gpt-6-luna" &&
			chosenModel(account, "") === "gpt-6-luna" &&
			chosenModel(account, "gpt-7-nova") === "gpt-7-nova" &&
			chosenModel(standIn, null) === STAND_IN_MODELS[0]!.id,
	);
	expect(
		"a model the list does not have is refused, and the sentence says whose list it is",
		/^bad_model: That model is not among the ones your ChatGPT plan offers\. Choose one of: gpt-6\.1-sol, gpt-6-luna, gpt-7-nova$/.test(
			problem(() => chosenModel(account, "gpt-6-sol")) ?? "",
		) &&
			/^bad_model: That model is not offered\./.test(problem(() => chosenModel(standIn, "gpt-7-nova")) ?? "") &&
			problem(() => chosenModel(account, 7)) !== null,
		`${problem(() => chosenModel(account, "gpt-6-sol"))} | ${problem(() => chosenModel(standIn, "gpt-7-nova"))}`,
	);
	expect(
		"an effort is held against its model's own, and a model that takes none says so",
		problem(() => checkEffort(account, "gpt-6-luna", "medium")) === null &&
			problem(() => checkEffort(account, "gpt-6-luna", "high")) ===
				"bad_effort: The effort for gpt-6-luna must be one of: low, medium" &&
			problem(() => checkEffort(account, "gpt-6.1-sol", "high")) === null &&
			problem(() => checkEffort(account, "gpt-7-nova", "low")) ===
				"bad_effort: gpt-7-nova takes no reasoning effort. Leave the effort at its default." &&
			problem(() => checkEffort(account, "gpt-6-luna", 3)) !== null,
	);
	{
		// A session's turns, each starting from the effort the one before it left (SessionMeta.effort).
		let session: string | null = null;
		const turn = (asked: unknown, model: string) => (session = turnEffort(asked, session, model, account));
		const named = turn("medium", "gpt-6-luna");
		const kept = turn(undefined, "gpt-6-luna");
		const cleared = turn(null, "gpt-6-luna");
		turn("low", "gpt-6-luna");
		const switched = turn(undefined, "gpt-7-nova");
		expect(
			"a turn's effort is kept for the next unless it names another, null is the default, and a model that does not take it drops it",
			named === "medium" && kept === "medium" && cleared === null && switched === null,
			plain({ named, kept, cleared, switched }),
		);
		expect(
			"an effort a prompt names is still refused where its model does not take it; an unchecked one is passed on",
			problem(() => turnEffort("high", "low", "gpt-6-luna", account)) ===
				"bad_effort: The effort for gpt-6-luna must be one of: low, medium" &&
				turnEffort("", "low", "gpt-6-luna", account) === null &&
				turnEffort(undefined, "high", "gpt-6-luna", null) === "high",
		);
	}
	expect(
		"of a model the list does not have nothing is said: that one is Windlass's to refuse",
		problem(() => checkEffort(account, "gpt-5-old", "extreme")) === null,
	);
	expect(
		"the stand-in is the same list whatever it stands in for, and never says it is the account's",
		plain(standInModels("demo").models) === plain(standIn.models) &&
			standIn.fetchedAt === null &&
			standIn.defaultModel === standIn.models[0]!.id &&
			standIn.models.every(model => model.efforts.length === 5),
	);
}

// ---- the list as the user's actor keeps it -----------------------------------------------------------

/** A database whose every statement waits a moment first: whoever started another call meanwhile gets a turn. */
function database(): {
	db: ModelsDb;
	rows(): Array<{ generation: string; list: string; fetched_at: number }>;
	age(ms: number): void;
} {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(MODELS_TABLE);
	const db: ModelsDb = {
		async execute<Row extends Record<string, unknown>>(query: string, ...args: unknown[]): Promise<Row[]> {
			for (let waits = Math.floor(Math.random() * 4); waits >= 0; waits -= 1)
				await new Promise<void>(done => setImmediate(done));
			return sqlite.prepare(query).all(...(args as Array<string | number | null>)) as Row[];
		},
	};
	return {
		db,
		rows: () => sqlite.prepare("SELECT generation, list, fetched_at FROM model_list").all() as never,
		age: ms => void sqlite.prepare("UPDATE model_list SET fetched_at = fetched_at - ?").run(ms),
	};
}

/** A user as the keeper sees one: a sign-in's generation (null: none), and a listing the check answers as it says. */
class Account {
	generation: string | null = "1";
	asked = 0;
	answer: ListedModels | Error = PLAN;
	/** Resolved by the check to let the listings that wait go on. */
	hold: Promise<void> | null = null;
	readonly lines: string[] = [];
	readonly store = database();

	source(): ModelsSource {
		return {
			db: this.store.db,
			generation: async () => {
				await wait(Math.random() * 3);
				return this.generation;
			},
			list: async () => {
				this.asked += 1;
				const answer = this.answer;
				if (this.hold !== null) await this.hold;
				else await wait(5);
				if (answer instanceof Error) throw answer;
				return structuredClone(answer);
			},
		};
	}

	keeper(options: { freshMs?: number; waitMs?: number; retryMs?: number } = {}): AccountModels {
		return new AccountModels({ uid: "u_check", log: line => this.lines.push(line), ...options });
	}
}

const OTHER: ListedModels = {
	models: [{ id: "gpt-8-terra", name: null, efforts: ["low"] }],
	defaultModel: "gpt-8-terra",
};

{
	const user = new Account();
	const advertised = { id: "test-model", name: null, efforts: ["none", "minimal", "high", "max", "ultra"] };
	user.answer = { defaultModel: advertised.id, models: [advertised] };
	const expected = ["none", "minimal", "high", "max"];
	const current = await user.keeper().current(user.source());
	expect(
		"a new account listing offers only the model's Responses API efforts",
		plain(current.models[0]?.efforts) === plain(expected),
		plain(current.models),
	);
	await user.store.db.execute("UPDATE model_list SET list = ?", JSON.stringify(user.answer));
	const cached = await user.keeper().current(user.source());
	expect(
		"cached listings from before the filter reject an unsupported effort without relisting",
		user.asked === 1 &&
			plain(cached.models[0]?.efforts) === plain(expected) &&
			problem(() => checkEffort(cached, advertised.id, "ultra"))?.startsWith("bad_effort:") === true,
		plain(cached.models),
	);
}

{
	const user = new Account();
	const models = user.keeper();
	user.generation = null;
	const before = await models.current(user.source());
	expect(
		"before a sign-in the list is the stand-in, it says so, and Windlass is not asked",
		before.source === "signed-out" && before.fetchedAt === null && user.asked === 0 && user.store.rows().length === 0,
	);

	user.generation = "1";
	const many = await Promise.all(Array.from({ length: 8 }, () => models.current(user.source())));
	expect(
		"eight who ask at once are answered from one listing",
		user.asked === 1 && many.every(list => plain(list) === plain(many[0])),
		`${user.asked} listings`,
	);
	const [first] = many;
	expect(
		"the answer is the account's: its models, each with its efforts, its default, and when it was read",
		first!.source === "account" &&
			plain(first!.models) === plain(PLAN.models) &&
			first!.defaultModel === "gpt-6-luna" &&
			typeof first!.fetchedAt === "number" &&
			Date.now() - first!.fetchedAt! < 5_000,
	);
	expect(
		"it is stored before it is answered, with the generation of the sign-in it was listed with",
		user.store.rows().length === 1 &&
			user.store.rows()[0]!.generation === "1" &&
			plain(JSON.parse(user.store.rows()[0]!.list)) === plain(PLAN) &&
			user.store.rows()[0]!.fetched_at === first!.fetchedAt,
	);
	await models.current(user.source());
	expect("a list that is fresh is served without asking Windlass", user.asked === 1);
	expect(
		"an actor that wakes elsewhere serves the stored list without asking",
		plain(await user.keeper().current(user.source())) === plain(first) && user.asked === 1,
	);

	// An hour on: listed again, by whoever asks.
	user.store.age(61 * 60_000);
	user.answer = OTHER;
	const woken = user.keeper();
	const renewed = await Promise.all([
		woken.current(user.source()),
		woken.current(user.source()),
		woken.current(user.source()),
	]);
	expect(
		"after an hour it is listed again, once for all who ask",
		user.asked === 2 &&
			renewed.every(list => list.defaultModel === "gpt-8-terra" && list.source === "account") &&
			user.store.rows().length === 1,
	);
}

{
	// A listing that fails.
	const user = new Account();
	const models = user.keeper({ retryMs: 150 });
	user.answer = new Error("`windlass --models` failed (exit code 1): HTTP 500: the stand-in is down");
	const none = await Promise.all([models.current(user.source()), models.current(user.source())]);
	expect(
		"a listing that fails with nothing kept gives the stand-in, which says the plan could not be read",
		user.asked === 1 &&
			none.every(
				list =>
					list.source === "unavailable" &&
					list.fetchedAt === null &&
					plain(list.models) === plain(standInModels("unavailable").models),
			) &&
			user.store.rows().length === 0,
	);
	await models.current(user.source());
	expect("and Windlass is not asked again at once", user.asked === 1);
	expect(
		"the failure is logged with its reason",
		user.lines.filter(
			line =>
				line.startsWith("[wlp] models.list_failed uid=u_check: ") &&
				line.includes("HTTP 500") &&
				line.includes("the stand-in is served"),
		).length === 1,
		user.lines.join(" | "),
	);
	await wait(170);
	user.answer = PLAN;
	const mended = await models.current(user.source());
	expect(
		"a while later it is asked again, and the plan's list is there",
		user.asked === 2 && mended.source === "account",
	);

	// A list that was kept is served on while listing fails.
	user.store.age(2 * 60 * 60_000);
	user.answer = new Error("`windlass --models` did not answer in 5 s and was stopped");
	const again = user.keeper({ retryMs: 150 });
	const stale = await again.current(user.source());
	expect(
		"an old list is served rather than the stand-in while a listing fails, with the time it was read",
		user.asked === 3 &&
			stale.source === "account" &&
			plain(stale.models) === plain(PLAN.models) &&
			Date.now() - stale.fetchedAt! > 60 * 60_000 &&
			user.lines.some(line => line.includes("the list kept from before is served")),
	);
	await again.current(user.source());
	expect("and the failed listing is not repeated for every request", user.asked === 3);
}

{
	// Nobody waits for long.
	const user = new Account();
	const models = user.keeper({ waitMs: 120 });
	let release: () => void = () => undefined;
	user.hold = new Promise<void>(done => (release = done));
	const started = Date.now();
	const waited = await Promise.all([models.current(user.source()), models.current(user.source())]);
	const took = Date.now() - started;
	expect(
		"a listing that takes long is waited on for the deadline and no longer: the stand-in is answered meanwhile",
		took >= 110 && took < 1_000 && waited.every(list => list.source === "unavailable") && user.asked === 1,
		`${took} ms`,
	);
	const joined = models.current(user.source());
	release();
	user.hold = null;
	const late = await joined;
	expect(
		"the listing goes on, whoever asks meanwhile joins it, and its list is stored for the next",
		user.asked === 1 &&
			late.source === "account" &&
			(await models.current(user.source())).source === "account" &&
			user.asked === 1 &&
			user.store.rows().length === 1,
	);
}

{
	// The list and the sign-in it came from.
	const user = new Account();
	const models = user.keeper();
	await models.current(user.source());
	user.generation = null;
	const out = await models.current(user.source());
	expect(
		"once the sign-in is forgotten the list is not served, also where nothing removed it",
		out.source === "signed-out" && user.store.rows().length === 1 && user.asked === 1,
	);
	await models.forget(user.store.db);
	expect("forgetting removes the row", user.store.rows().length === 0);

	// Signed in again: the earlier list is nobody's, also for an actor that wakes with the old row in its storage.
	const stale = new Account();
	await stale.keeper().current(stale.source());
	stale.generation = "2";
	stale.answer = OTHER;
	const fresh = await stale.keeper().current(stale.source());
	expect(
		"after a new sign-in the list of the earlier one is not served: the plan is listed again",
		stale.asked === 2 &&
			fresh.defaultModel === "gpt-8-terra" &&
			stale.store.rows().length === 1 &&
			stale.store.rows()[0]!.generation === "2",
	);

	// A listing that was running for the earlier sign-in ends after the new one's.
	const racing = new Account();
	const keeper = racing.keeper();
	let release: () => void = () => undefined;
	racing.hold = new Promise<void>(done => (release = done));
	const early = keeper.current(racing.source());
	await wait(30);
	racing.generation = "2";
	racing.hold = null;
	racing.answer = OTHER;
	const current = await keeper.current(racing.source());
	release();
	const earlier = await early;
	await wait(30);
	const settled = await keeper.current(racing.source());
	expect(
		"a listing that ran for the earlier sign-in and ends late is nobody's: whoever waited on it is answered with the new sign-in's list, which is what the row holds",
		racing.asked === 2 &&
			current.defaultModel === "gpt-8-terra" &&
			settled.defaultModel === "gpt-8-terra" &&
			racing.store.rows().length === 1 &&
			racing.store.rows()[0]!.generation === "2" &&
			plain(JSON.parse(racing.store.rows()[0]!.list)) === plain(OTHER) &&
			earlier.defaultModel === "gpt-8-terra",
		`${racing.asked} listings; row ${plain(racing.store.rows())}`,
	);
}

{
	// The sign-in is forgotten while its models are being listed.
	const leaving = new Account();
	const keeper = leaving.keeper();
	let release: () => void = () => undefined;
	leaving.hold = new Promise<void>(done => (release = done));
	const asking = keeper.current(leaving.source());
	await wait(30);
	leaving.generation = null;
	release();
	const answered = await asking;
	expect(
		"a listing that ends after the sign-in was forgotten is neither stored nor answered",
		answered.source === "signed-out" &&
			leaving.store.rows().length === 0 &&
			(await keeper.current(leaving.source())).source === "signed-out" &&
			leaving.asked === 1,
	);

	// The same with an old list kept: the old list is not what whoever waited is answered with.
	const old = new Account();
	await old.keeper().current(old.source());
	old.store.age(2 * 60 * 60_000);
	const woken = old.keeper();
	old.hold = new Promise<void>(done => (release = done));
	const waiting = woken.current(old.source());
	await wait(30);
	old.generation = null;
	release();
	expect(
		"nor is the list kept from before, once its sign-in is gone",
		(await waiting).source === "signed-out" && old.asked === 2,
	);
}

{
	const ROUNDS = 100;
	let once = 0;
	for (let round = 0; round < ROUNDS; round += 1) {
		const user = new Account();
		const models = user.keeper();
		const asking = Array.from({ length: 6 }, async (_, index) => {
			await wait(index % 3);
			return models.current(user.source());
		});
		const lists = await Promise.all(asking);
		if (user.asked === 1 && lists.every(list => list.source === "account") && user.store.rows().length === 1) once += 1;
	}
	expect(
		`requests that start a moment apart, each waiting on the storage, share one listing (${ROUNDS} rounds)`,
		once === ROUNDS,
		`${once} of ${ROUNDS}`,
	);
}

// ---- the real `windlass --models`, against a stand-in for the provider's endpoint --------------------

/**
 * Answers what Windlass sends to api.openai.com. Windlass is given this as its HTTPS proxy: it asks
 * for a tunnel to api.openai.com:443, and the stand-in answers on that tunnel itself, with a
 * certificate of its own that Windlass is told to trust. Nothing is forwarded anywhere.
 */
class StandIn {
	/** Every request it answered, as "<method> <path>", and whether it carried the token it was to expect. Never the token. */
	readonly requests: Array<{ what: string; authorized: boolean }> = [];
	readonly tunnels: string[] = [];
	/** What it answers `GET /v1/models` with: a plan, a refusal, or nothing at all. */
	mode: "plan" | "rejected" | "broken" | "silent" = "plan";
	expected = "";
	private proxy: Server | null = null;
	private readonly sockets = new Set<Socket>();
	private port = 0;

	constructor(private readonly dir: string) {}

	async start(): Promise<void> {
		const [keyFile, certFile] = [join(this.dir, "standin-key.pem"), join(this.dir, "standin-cert.pem")];
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
				"/CN=api.openai.com",
				"-addext",
				"subjectAltName=DNS:api.openai.com",
				"-keyout",
				keyFile,
				"-out",
				certFile,
			],
			{ stdio: "pipe" },
		);
		const [key, cert] = [readFileSync(keyFile), readFileSync(certFile)];
		const http = createHttpServer((request, response) => this.answer(request, response));
		this.proxy = createNetServer(socket => {
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
			socket.on("error", () => {});
			socket.once("data", (head: Buffer) => {
				this.tunnels.push(head.toString("latin1").split("\r\n")[0] ?? "");
				socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
				const secure = new TLSSocket(socket, { isServer: true, key, cert });
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
		return { HTTPS_PROXY: proxy, https_proxy: proxy, NODE_EXTRA_CA_CERTS: join(this.dir, "standin-cert.pem") };
	}

	private answer(request: IncomingMessage, response: ServerResponse): void {
		const send = (status: number, body: unknown) => {
			const text = JSON.stringify(body);
			response.writeHead(status, {
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(text),
				Connection: "close",
			});
			response.end(text);
		};
		this.requests.push({
			what: `${request.method} ${request.url}`,
			authorized: request.headers.authorization === `Bearer ${this.expected}`,
		});
		if (request.method !== "GET" || request.url !== "/v1/models")
			return send(404, { error: { message: "the stand-in knows no such path" } });
		if (this.mode === "silent") return;
		if (this.mode === "rejected")
			return send(401, { error: { message: "the stand-in accepts no token", code: "token_revoked" } });
		if (this.mode === "broken") return send(500, { error: { message: "the stand-in is down" } });
		const level = (effort: string) => ({ effort, description: effort });
		send(200, {
			models: [
				{
					slug: "gpt-6.1-sol",
					display_name: "GPT-6.1 Sol",
					visibility: "list",
					context_window: 400_000,
					default_reasoning_level: "medium",
					supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map(level),
				},
				{
					slug: "gpt-6-luna",
					display_name: "gpt-6-luna",
					visibility: "list",
					supported_reasoning_levels: ["low", "medium"].map(level),
				},
				{ slug: "gpt-7-nova", display_name: "GPT-7 Nova", visibility: "list", supported_reasoning_levels: [] },
				{ slug: "gpt-internal", display_name: "Not listed", visibility: "hide", supported_reasoning_levels: [] },
			],
		});
	}
}

const arch = process.arch === "arm64" ? "arm64" : "x64";
const cache = join(homedir(), ".cache", "windlass-platform");
const released = existsSync(cache)
	? readdirSync(cache)
			.filter(name => /^windlass-v\d+\.\d+\.\d+$/.test(name))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
			.map(name => join(cache, name, `windlass-linux-${arch}`))
			.filter(file => existsSync(file))
			.pop()
	: undefined;
const binary = process.env.WLP_WINDLASS_BIN || released;

if (binary === undefined) {
	console.log(
		"\nSKIPPED: the real `windlass --models`. No Windlass executable is at hand: run sandbox/fetch-windlass.sh, or set WLP_WINDLASS_BIN.",
	);
} else {
	const scratch = mkdtempSync(join(tmpdir(), "wlp-models-check-"));
	const root = join(scratch, "private");
	execFileSync("mkdir", ["-p", root]);
	const standin = new StandIn(scratch);
	await standin.start();
	try {
		const lines: string[] = [];
		const log = (line: string) => lines.push(line);
		const runner = new LocalLoginRunner({ binary, tmpRoot: root, env: standin.env(), log });
		const commands = new WindlassSignIns(runner, { log, modelsTimeoutMs: 4_000 });
		console.log(
			`\n      Windlass ${await runner.version()} at ${binary}, as a local process; the provider's endpoint is the stand-in in this process`,
		);
		const left = () => readdirSync(root).filter(name => name.startsWith(TMP_PREFIX));
		const token = {
			accessToken: `FAKE-ACCESS-TOKEN-${Math.random().toString(36).slice(2)}-not-a-real-token`,
			expiresAt: Date.now() + 50 * 60_000,
		};
		standin.expected = token.accessToken;

		const listed = await commands.models(token);
		expect(
			"Windlass lists the plan's models on a handed-in token: those the provider lists, each with its efforts, and its default",
			plain(listed) ===
				plain({
					models: [
						{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh"] },
						{ id: "gpt-6-luna", name: null, efforts: ["low", "medium"] },
						{ id: "gpt-7-nova", name: "GPT-7 Nova", efforts: [] },
					],
					defaultModel: "gpt-6.1-sol",
				}),
			plain(listed),
		);
		expect(
			"it asked the provider once, with the token it was handed, through a tunnel to api.openai.com",
			plain(standin.requests) === plain([{ what: "GET /v1/models", authorized: true }]) &&
				plain(standin.tunnels) === plain(["CONNECT api.openai.com:443 HTTP/1.1"]),
			`${plain(standin.requests)} ${plain(standin.tunnels)}`,
		);
		expect(
			"the token's file and its private directory are gone when the command has ended",
			left().length === 0,
			left().join(", "),
		);

		const failures: Array<Error | null> = [];
		for (const mode of ["rejected", "broken", "silent"] as const) {
			standin.mode = mode;
			failures.push(await caught(commands.models(token)));
		}
		const expired = await caught(commands.models({ accessToken: token.accessToken, expiresAt: Date.now() - 1_000 }));
		const [rejected, broken, silent] = failures;
		expect(
			"a token the provider rejects, a provider that fails and one that does not answer are each a failure with Windlass's reason",
			/exit code 1\): .*was rejected \(HTTP 401/.test(rejected?.message ?? "") &&
				/exit code 1\): HTTP 500: the stand-in is down/.test(broken?.message ?? "") &&
				/did not answer in 4 s and was stopped/.test(silent?.message ?? ""),
			failures.map(failure => failure?.message ?? "no failure").join(" | "),
		);
		expect(
			"a token that has run out is refused by Windlass before anything is sent",
			/expired at/.test(expired?.message ?? "") && standin.requests.length === 4,
			`${expired?.message}; ${standin.requests.length} requests`,
		);
		expect(
			"no failure leaves a directory behind, and no message or log line holds the token",
			left().length === 0 &&
				![...failures, expired].some(failure => failure?.message.includes(token.accessToken)) &&
				!lines.some(line => line.includes(token.accessToken)),
			left().join(", "),
		);

		// The whole way: the keeper over a database, asking the real Windlass.
		standin.mode = "plan";
		const store = database();
		let generation: string | null = "1";
		const said: string[] = [];
		const source: ModelsSource = {
			db: store.db,
			generation: async () => generation,
			list: () => commands.models(token),
		};
		const woken = () => new AccountModels({ uid: "u_check", log: line => said.push(line), retryMs: 0 });
		let keeper = woken();
		const asked = () => standin.requests.length;
		const from = asked();
		const lists = await Promise.all([
			keeper.current(source),
			keeper.current(source),
			keeper.current(source),
			keeper.current(source),
		]);
		expect(
			"four requests for a user's models: Windlass runs once, the provider is asked once, and the list is kept",
			asked() === from + 1 &&
				lists.every(list => list.source === "account" && list.models.length === 3) &&
				store.rows().length === 1 &&
				(await keeper.current(source)).source === "account" &&
				asked() === from + 1,
			`${asked() - from} requests to the provider`,
		);
		// An hour on, in an actor that has slept since: what it knows is the row.
		store.age(61 * 60_000);
		keeper = woken();
		standin.mode = "broken";
		const kept = await keeper.current(source);
		expect(
			"an hour on with the provider failing: the kept list is served, with the time it was read",
			asked() === from + 2 &&
				kept.source === "account" &&
				kept.models.length === 3 &&
				Date.now() - kept.fetchedAt! > 60 * 60_000,
		);
		standin.mode = "plan";
		const again = await keeper.current(source);
		expect(
			"and when the provider answers again, the list is new",
			asked() === from + 3 && again.source === "account" && Date.now() - again.fetchedAt! < 10_000,
		);
		generation = null;
		const out = await keeper.current(source);
		await keeper.forget(store.db);
		expect(
			"signed out: the stand-in, nothing kept, and Windlass is not run",
			out.source === "signed-out" && store.rows().length === 0 && asked() === from + 3,
		);
		generation = "2";
		standin.mode = "rejected";
		const refused = await keeper.current(source);
		expect(
			"signed in again with a token the provider rejects: the stand-in, which says the plan could not be read, and nothing of the earlier sign-in",
			refused.source === "unavailable" && store.rows().length === 0 && asked() === from + 4,
		);
		expect(
			"what was logged names the user and the reason, and never the token",
			said.some(line => line.startsWith("[wlp] models.listed uid=u_check: 3 models")) &&
				said.some(line => line.startsWith("[wlp] models.list_failed uid=u_check: ")) &&
				!said.some(line => line.includes(token.accessToken)) &&
				left().length === 0,
			said.join(" | "),
		);
	} finally {
		await standin.stop();
		rmSync(scratch, { recursive: true, force: true });
	}
}

process.exit(tally.summary("\nAll checks passed.", failed => `\n${failed} check(s) failed.`));
