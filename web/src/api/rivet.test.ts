import type { AuthResult } from "@contract";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState, PlatformError } from "./client";
import type { Connection, ConnectionSource } from "./connection";

/**
 * RivetKit's client, replaced by one that records how it was made and answers actions from a script.
 * What RivetKit itself does with `getToken` is read from its source (connection.ts says where); these
 * tests are about what this app does around it.
 */
const rivet = vi.hoisted(() => ({
	made: [] as Array<Record<string, unknown>>,
	/** What each action call does, in order; the last one repeats. */
	script: [] as Array<() => unknown>,
	calls: [] as string[],
	/** How each actor was opened: `get` or `getOrCreate`, and its name. */
	opened: [] as string[],
	connects: 0,
	disposed: 0,
	status: "connected",
	onError: undefined as ((error: unknown) => void) | undefined,
	onStatus: undefined as ((status: string) => void) | undefined,
	resolve: vi.fn(async () => "actor-id"),
	load: vi.fn(async (): Promise<unknown> => []),
}));

vi.mock("rivetkit/client", () => {
	const handle = () => ({
		resolve: rivet.resolve,
		action: async ({ name }: { name: string }) => {
			rivet.calls.push(name);
			const next = rivet.script[Math.min(rivet.calls.length - 1, rivet.script.length - 1)];
			return next ? next() : undefined;
		},
		connect: () => {
			rivet.connects += 1;
			return {
				get connStatus() {
					return rivet.status;
				},
				on: () => () => undefined,
				onStatusChange: (cb: typeof rivet.onStatus) => {
					rivet.onStatus = cb;
					return () => {
						rivet.onStatus = undefined;
					};
				},
				onError: (cb: typeof rivet.onError) => {
					rivet.onError = cb;
					return () => {
						rivet.onError = undefined;
					};
				},
				action: rivet.load,
				dispose: async () => {
					rivet.disposed += 1;
				},
			};
		},
	});
	return {
		createClient: (config: Record<string, unknown>) => {
			rivet.made.push(config);
			return {
				getOrCreate: (name: string) => (rivet.opened.push(`getOrCreate ${name}`), handle()),
				get: (name: string) => (rivet.opened.push(`get ${name}`), handle()),
				dispose: async () => undefined,
			};
		},
	};
});

const { ACTOR, createRivetClient } = await import("./rivet");

const AUTH: AuthResult = {
	token: "platform-token",
	profile: { uid: "u1", displayName: "Test", email: null, demo: true },
} as unknown as AuthResult;
const EXPIRED = { group: "auth", code: "token_expired", message: "Authentication token has expired." };

/** A source that answers at once, or when `release` is called. */
function source(connection: Connection, held = false) {
	let release: () => void = () => undefined;
	const gate = held ? new Promise<void>(done => (release = done)) : Promise.resolve();
	const fake = {
		connection: async () => {
			await gate;
			return connection;
		},
		token: async () => "engine-token",
		failure: () => null,
		close: () => undefined,
	};
	return { source: fake as unknown as ConnectionSource, token: fake.token, release };
}

const settle = () => new Promise<void>(done => setTimeout(done, 0));

beforeEach(() => {
	rivet.made.length = 0;
	rivet.script.length = 0;
	rivet.calls.length = 0;
	rivet.opened.length = 0;
	rivet.connects = 0;
	rivet.disposed = 0;
	rivet.status = "connected";
	rivet.load.mockClear();
	rivet.resolve.mockClear();
});

describe("the RivetKit client", () => {
	it("is made from what the server says: its endpoint, its namespace, and a function for the token", async () => {
		const { source: from, token } = source({ endpoint: "https://engine.test", namespace: "production", tokens: true });
		const client = createRivetClient("http://localhost:6420", "http://platform.test", from);
		await settle();
		expect(rivet.made).toEqual([
			{
				endpoint: "https://engine.test",
				namespace: "production",
				disableMetadataLookup: true,
				getToken: token,
				devtools: false,
			},
		]);
		expect(client.endpoint).toBe("https://engine.test");
	});

	it("is made as it always was when the server names no endpoint and hands out no token", async () => {
		const { source: from } = source({ endpoint: null, namespace: "default", tokens: false });
		const client = createRivetClient("http://localhost:6420", "http://localhost:6440", from);
		await settle();
		expect(rivet.made).toEqual([{ endpoint: "http://localhost:6420", devtools: false }]);
		expect(client.endpoint).toBe("http://localhost:6420");
	});

	it("is made once, whatever uses it", async () => {
		const { source: from } = source({ endpoint: "https://engine.test", namespace: "default", tokens: true });
		const client = createRivetClient("http://localhost:6420", "http://platform.test", from);
		rivet.script.push(() => []);
		await client.user(AUTH).listSessions();
		await client.session(AUTH, "s1").stop();
		expect(rivet.made.length).toBe(1);
	});
});

describe("the GitLab settings actor", () => {
	const client = () =>
		createRivetClient(
			"http://localhost:6420",
			"http://platform.test",
			source({ endpoint: "https://engine.test", namespace: "default", tokens: true }).source,
		);

	it("is created by the server and only looked up by the browser, whose engine token cannot create actors", async () => {
		rivet.script.push(
			() => true,
			() => ({ state: "disconnected" }),
		);
		const api = client().user(AUTH);
		expect(await api.gitlab()).toEqual({ state: "disconnected" });
		await api.gitlabProjects("");
		expect(rivet.calls).toEqual(["openGitlab", "gitlab", "gitlabProjects"]);
		expect(rivet.opened).toEqual(["get user", "get userGitlab"]);
	});

	it("is not opened when the deployment has no GitLab", async () => {
		rivet.script.push(() => false);
		const api = client().user(AUTH);
		expect(await api.gitlab()).toEqual({ state: "off" });
		await expect(api.gitlabDisconnect()).rejects.toMatchObject({ code: "user", reason: "gitlab_off" });
		expect(rivet.calls).toEqual(["openGitlab"]);
		expect(rivet.opened).toEqual(["get user"]);
	});
});

describe("the example tunnel", () => {
	const example = readFileSync(
		fileURLToPath(new URL("../../../deploy/selfhost/tunnel.example.yml", import.meta.url)),
		"utf8",
	);
	const engine = /hostname: engine\.example\.com\s+path: '([^']+)'/.exec(example)?.[1];

	it.each(Object.values(ACTOR))("lets the browser reach the %s actor's actions and connection", name => {
		expect(engine).toBeDefined();
		const allowed = new RegExp(engine!);
		expect(allowed.test(`/gateway/${name}/action/me`)).toBe(true);
		expect(allowed.test(`/gateway/${name}/connect`)).toBe(true);
	});
});

describe("an action the engine refuses for its token", () => {
	it("is sent once more, and the user sees nothing of it", async () => {
		const { source: from } = source({ endpoint: "https://engine.test", namespace: "default", tokens: true });
		const client = createRivetClient("http://localhost:6420", "http://platform.test", from);
		rivet.script.push(
			() => {
				throw EXPIRED;
			},
			() => ({ turn: 3, steered: false }),
		);
		expect(await client.session(AUTH, "s1").prompt({ text: "after a day" } as never)).toEqual({
			turn: 3,
			steered: false,
		});
		expect(rivet.calls).toEqual(["prompt", "prompt"]);
	});

	it("is not sent a third time, and its failure does not sign the user out", async () => {
		const { source: from } = source({ endpoint: "https://engine.test", namespace: "default", tokens: true });
		const client = createRivetClient("http://localhost:6420", "http://platform.test", from);
		rivet.script.push(() => {
			throw EXPIRED;
		});
		const error = (await client
			.session(AUTH, "s1")
			.prompt({ text: "hello" } as never)
			.catch((thrown: unknown) => thrown)) as PlatformError;
		expect(rivet.calls).toEqual(["prompt", "prompt"]);
		expect(error.code).toBe("network");
		expect(error.message).toBe("The connection to https://engine.test could not be renewed.");
	});

	it("is not sent again for any other refusal", async () => {
		const { source: from } = source({ endpoint: "https://engine.test", namespace: "default", tokens: true });
		const client = createRivetClient("http://localhost:6420", "http://platform.test", from);
		rivet.script.push(() => {
			throw { group: "user", code: "invalid_token", message: "Your sign-in is not valid any more. Sign in again." };
		});
		const error = (await client
			.user(AUTH)
			.me()
			.catch((thrown: unknown) => thrown)) as PlatformError;
		expect(rivet.calls).toEqual(["me"]);
		expect(error.code).toBe("unauthorized");
	});
});

describe("an action that meets the platform restarting", () => {
	const STOPPED = { group: "guard", code: "actor_stopped_while_waiting", message: "Actor stopped while waiting." };
	const client = () =>
		createRivetClient(
			"http://localhost:6420",
			"http://platform.test",
			source({ endpoint: "https://engine.test", namespace: "default", tokens: true }).source,
		);
	const failure = (pending: Promise<unknown>) =>
		pending.then(
			() => null,
			(thrown: unknown) => thrown as PlatformError,
		);

	beforeEach(() => {
		vi.useFakeTimers();
		return () => vi.useRealTimers();
	});

	it("is sent once more after two seconds when it only reads", async () => {
		rivet.script.push(
			() => {
				throw STOPPED;
			},
			() => [],
		);
		const listed = client().user(AUTH).listSessions();
		await vi.advanceTimersByTimeAsync(1_900);
		expect(rivet.calls).toEqual(["listSessions"]);
		await vi.advanceTimersByTimeAsync(100);
		expect(await listed).toEqual([]);
		expect(rivet.calls).toEqual(["listSessions", "listSessions"]);
	});

	it("says to try again in a moment when the one more time fails too", async () => {
		rivet.script.push(() => {
			throw new Error("HTTP request error: Bad Gateway (502):\n");
		});
		const error = failure(client().user(AUTH).me());
		await vi.advanceTimersByTimeAsync(2_000);
		expect(await error).toMatchObject({
			code: "restarting",
			message: "The platform is restarting. Try again in a moment.",
		});
		expect(rivet.calls).toEqual(["me", "me"]);
	});

	it("is sent once more when it writes with the key of its submission, and not without one", async () => {
		rivet.script.push(
			() => {
				throw STOPPED;
			},
			() => ({ turn: 1, steered: false }),
		);
		const prompted = client()
			.session(AUTH, "s1")
			.prompt({ text: "hi", idempotencyKey: "k1" } as never);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(await prompted).toEqual({ turn: 1, steered: false });
		expect(rivet.calls).toEqual(["prompt", "prompt"]);

		rivet.calls.length = 0;
		rivet.script.length = 0;
		rivet.script.push(() => {
			throw STOPPED;
		});
		expect(await failure(client().session(AUTH, "s1").stop())).toMatchObject({
			code: "restarting",
			message: "The platform is restarting. Try again in a moment.",
		});
		expect(rivet.calls).toEqual(["stop"]);
	});

	it("is not sent again for a real internal error", async () => {
		rivet.script.push(() => {
			throw { group: "rivetkit", code: "internal_error", message: "Internal error" };
		});
		expect(await failure(client().user(AUTH).me())).toMatchObject({
			code: "internal",
			message: "The server hit an internal error. Its log has the details.",
		});
		expect(rivet.calls).toEqual(["me"]);
	});
});

describe("a feed", () => {
	it("opens once the connection is known", async () => {
		const { source: from, release } = source(
			{ endpoint: "https://engine.test", namespace: "default", tokens: true },
			true,
		);
		const client = createRivetClient("http://localhost:6420", "http://platform.test", from);
		const states: ConnectionState[] = [];
		const close = client.user(AUTH).watch({ onSessions: () => undefined, onConnection: state => states.push(state) });
		await settle();
		expect(states).toEqual(["connecting"]);
		expect(rivet.connects).toBe(0);
		release();
		await settle();
		expect(rivet.connects).toBe(1);
		expect(states).toEqual(["connecting", "connected"]);
		close();
		expect(rivet.disposed).toBe(1);
	});

	it("confirms a missing actor over HTTP when the WebSocket upgrade has no status", async () => {
		vi.useFakeTimers();
		try {
			rivet.status = "connecting";
			rivet.resolve.mockRejectedValueOnce({ group: "actor", code: "not_found", message: "Gone" });
			const { source: from } = source({ endpoint: null, namespace: "default", tokens: false });
			const api = createRivetClient("http://engine.test", "http://platform.test", from).session(AUTH, "gone");
			const onConnection = vi.fn();
			const close = api.open({
				onConnection,
				onSnapshot: vi.fn(),
				onItem: vi.fn(),
				onDelta: vi.fn(),
				onSummary: vi.fn(),
				onQuestion: vi.fn(),
			});
			await vi.advanceTimersByTimeAsync(120_000);
			expect(rivet.resolve).toHaveBeenCalledTimes(1);
			expect(rivet.load).not.toHaveBeenCalled();
			expect(rivet.disposed).toBe(1);
			expect(onConnection).toHaveBeenLastCalledWith("failed", expect.objectContaining({ code: "not_found" }));
			close();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(["socket", "snapshot"])("stops watching a deleted session after a %s refusal", async path => {
		const { source: from } = source({ endpoint: null, namespace: "default", tokens: false });
		const api = createRivetClient("http://engine.test", "http://platform.test", from).session(AUTH, "gone");
		const onConnection = vi.fn();
		const gone = { group: "actor", code: "not_found", message: "The actor does not exist or was destroyed." };
		if (path === "snapshot") rivet.load.mockRejectedValueOnce({ ...gone, group: "user", code: "session_not_found" });
		const close = api.open({
			onConnection,
			onSnapshot: vi.fn(),
			onItem: vi.fn(),
			onDelta: vi.fn(),
			onQuestion: vi.fn(),
			onSummary: vi.fn(),
		});
		await settle();
		if (path === "socket") rivet.onError!(gone);
		rivet.onStatus?.("idle");
		rivet.onStatus?.("connected");
		api.resync();
		await settle();
		expect(onConnection.mock.calls.filter(([state]) => state === "failed")).toEqual([
			["failed", expect.objectContaining({ code: "not_found" })],
		]);
		expect(rivet.load).toHaveBeenCalledTimes(1);
		expect(rivet.disposed).toBe(1);
		close();
		expect(rivet.disposed).toBe(1);
	});

	it("that is closed before the connection is known never opens", async () => {
		const { source: from, release } = source(
			{ endpoint: "https://engine.test", namespace: "default", tokens: true },
			true,
		);
		const client = createRivetClient("http://localhost:6420", "http://platform.test", from);
		const close = client.user(AUTH).watch({ onSessions: () => undefined });
		close();
		release();
		await settle();
		expect(rivet.connects).toBe(0);
	});

	it("says so when the server refuses to say how to connect", async () => {
		const refused = {
			connection: () => Promise.reject(new Error("This origin is not allowed to connect.")),
			token: async () => "",
			failure: () => null,
			close: () => undefined,
		} as unknown as ConnectionSource;
		const client = createRivetClient("http://localhost:6420", "http://platform.test", refused);
		const seen: Array<[ConnectionState, string | undefined]> = [];
		client.session(AUTH, "s1").open({
			onSnapshot: () => undefined,
			onItem: () => undefined,
			onDelta: () => undefined,
			onSummary: () => undefined,
			onQuestion: () => undefined,
			onConnection: (state, error) => seen.push([state, error?.message]),
		});
		await settle();
		expect(seen).toEqual([
			["connecting", undefined],
			["failed", "This origin is not allowed to connect."],
		]);
	});
});
