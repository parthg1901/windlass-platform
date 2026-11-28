import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { internalConnection, requireServiceFor } from "../auth.js";
import type { ConnectRequestState, PlanProvider } from "../contract.js";

/**
 * How long an approved request waits for its token: long enough for `claude setup-token` or a ChatGPT sign-in. Also
 * the window a user's wrong codes are counted in.
 */
export const CONNECT_REQUEST_TTL_MS = 10 * 60_000;
/** How long a request waits for approval. Short: anyone can start one, and only approval takes a signed-in user. */
export const CONNECT_PENDING_TTL_MS = 3 * 60_000;
/**
 * Requests open at once across the deployment: starting one needs no sign-in, so the table is bounded. At the bound a
 * new request pushes out the oldest one nobody approved, so a flood of starts cannot refuse everyone else's.
 */
export const LIVE_REQUESTS = 1_000;
/** Codes a user may get wrong per TTL: with at most LIVE_REQUESTS live, guessing one stays out of reach. */
const MISSES_PER_USER = 10;

export type ConnectDecision = "ok" | "not_found" | "rate_limited";

/** An approved request the connect route took, as it was: what it needs to put it back (`internalUntake`). */
export type TakenRequest = {
	request: string;
	userCode: string;
	uid: string;
	provider: PlanProvider;
	expires: number;
};

/**
 * Connect requests of the connect command (connect-route.ts), `gh auth login`-style: the terminal starts one
 * without signing in, its user approves the code it shows on the web page, and only then does the terminal
 * hand a plan's token over, once. Only digests of the user code and of the terminal's request secret are kept.
 */
export const connectCodes = actor({
	db: db({
		onMigrate: async db => {
			await db.execute(
				`CREATE TABLE IF NOT EXISTS requests (
					request TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, provider TEXT NOT NULL,
					state TEXT NOT NULL DEFAULT 'pending', uid TEXT, expires INTEGER NOT NULL
				)`,
			);
			await db.execute("CREATE TABLE IF NOT EXISTS misses (uid TEXT NOT NULL, at INTEGER NOT NULL)");
		},
	}),
	onCreate: c => {
		if (c.key.length !== 1 || c.key[0] !== "codes") c.destroy();
	},
	onBeforeConnect: internalConnection,
	actions: {
		/**
		 * Opens a pending request. Null when every open request is approved and the table is full, or (vanishingly
		 * rarely) the user code is taken.
		 */
		internalStart: async (c, request: string, userCode: string, provider: PlanProvider): Promise<number | null> => {
			requireServiceFor(c, "call");
			const now = Date.now();
			await c.db.execute("DELETE FROM requests WHERE expires <= ?", now);
			await c.db.execute("DELETE FROM misses WHERE at <= ?", now - CONNECT_REQUEST_TTL_MS);
			await c.db.execute(
				`DELETE FROM requests WHERE request IN (
					SELECT request FROM requests WHERE state <> 'approved' ORDER BY expires
					LIMIT max(0, (SELECT count(*) FROM requests) - ? + 1)
				)`,
				LIVE_REQUESTS,
			);
			const rows = await c.db.execute<{ expires: number }>(
				`INSERT OR IGNORE INTO requests (request, user_code, provider, expires)
				SELECT ?, ?, ?, ? WHERE (SELECT count(*) FROM requests) < ? RETURNING expires`,
				request,
				userCode,
				provider,
				now + CONNECT_PENDING_TTL_MS,
				LIVE_REQUESTS,
			);
			return rows[0]?.expires ?? null;
		},
		/** Where the terminal's request stands. A request that is gone, used or out of time is expired. */
		internalPoll: async (c, request: string): Promise<ConnectRequestState> => {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ state: ConnectRequestState }>(
				"SELECT state FROM requests WHERE request = ? AND expires > ?",
				request,
				Date.now(),
			);
			return row?.state ?? "expired";
		},
		/**
		 * The signed-in user approves or denies the code on the page. Only a pending, live request is decided, and
		 * an approval only for the plan the page named (`provider`), so a link that names another plan approves
		 * nothing. Approving gives the terminal a fresh TTL for its sign-in. Wrong codes count against the user.
		 */
		internalDecide: async (
			c,
			userCode: string,
			uid: string,
			approve: boolean,
			provider?: PlanProvider,
		): Promise<ConnectDecision> => {
			requireServiceFor(c, "call");
			const now = Date.now();
			const [misses] = await c.db.execute<{ n: number }>(
				"SELECT count(*) AS n FROM misses WHERE uid = ? AND at > ?",
				uid,
				now - CONNECT_REQUEST_TTL_MS,
			);
			if ((misses?.n ?? 0) >= MISSES_PER_USER) return "rate_limited";
			const decided = await c.db.execute(
				`UPDATE requests SET state = ?, uid = ?, expires = ?
				WHERE user_code = ? AND state = 'pending' AND expires > ? AND (? IS NULL OR provider = ?) RETURNING provider`,
				approve ? "approved" : "denied",
				uid,
				approve ? now + CONNECT_REQUEST_TTL_MS : now + 60_000,
				userCode,
				now,
				provider ?? null,
				provider ?? null,
			);
			if (decided.length) return "ok";
			await c.db.execute("INSERT INTO misses VALUES (?, ?)", uid, now);
			return "not_found";
		},
		/**
		 * Takes an approved request for `provider`'s plan: whose it is. A request is taken once. `other_plan`: it is
		 * approved for another plan, and stays as it was.
		 */
		internalTake: async (c, request: string, provider: PlanProvider): Promise<TakenRequest | "other_plan" | null> => {
			requireServiceFor(c, "call");
			const now = Date.now();
			const [row] = await c.db.execute<TakenRequest>(
				`DELETE FROM requests WHERE request = ? AND state = 'approved' AND expires > ? AND provider = ?
				RETURNING request, user_code AS userCode, uid, provider, expires`,
				request,
				now,
				provider,
			);
			if (row) return row;
			const [other] = await c.db.execute(
				"SELECT 1 FROM requests WHERE request = ? AND state = 'approved' AND expires > ?",
				request,
				now,
			);
			return other ? "other_plan" : null;
		},
		/** Puts back a request taken for a handover that failed for a reason the terminal can retry (the provider unreachable). */
		internalUntake: async (c, taken: TakenRequest): Promise<void> => {
			requireServiceFor(c, "call");
			await c.db.execute(
				`INSERT OR IGNORE INTO requests (request, user_code, provider, state, uid, expires)
				VALUES (?, ?, ?, 'approved', ?, ?)`,
				taken.request,
				taken.userCode,
				taken.provider,
				taken.uid,
				taken.expires,
			);
		},
	},
});
