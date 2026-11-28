/**
 * One end of an Agent Client Protocol connection: JSON-RPC 2.0, one message per line.
 *
 * It knows nothing of Docker or of Windlass's sessions. Its owner gives it a way to write a line and
 * feeds it the lines that arrive; it matches responses to requests, hands notifications and the
 * agent's own requests to the owner, and fails every request still waiting when the connection ends.
 * Lines that are not JSON, or not JSON-RPC, are kept apart for an error message and otherwise ignored:
 * a stray print must not end a turn.
 */

import { limitError } from "../provider-usage.js";
import { errorText } from "../util.js";

/** A request the other side answered with an error, or one that could not be answered at all. */
export class AcpError extends Error {
	constructor(
		message: string,
		/** The JSON-RPC error code; 0 for a failure of the connection itself. */
		readonly code: number,
		/** Windlass's own reason (`data.windlass.reason`); "closed" when the connection ended; "timeout" when the answer did not come in time. */
		readonly reason: string | null,
		/** `data.windlass.holderPid` of a `session_in_use` error. */
		readonly holderPid: number | null = null,
		/**
		 * Windlass's stable code for what failed (`data.windlass.code`), when it gave one: a sign-in's
		 * (`handed_in_expired`, `signed_out`, ...), `network_error`, or a provider's own for its answer.
		 * It says which failure this is; the message is for reading only.
		 */
		readonly failureCode: string | null = null,
		readonly limit?: ReturnType<typeof limitError>,
		readonly codexErrorInfo?: unknown,
	) {
		super(message);
		this.name = "AcpError";
	}
}

export interface AcpHandlers {
	notification(method: string, params: Record<string, unknown>): void;
	/** A request from the agent. The value it resolves with is the result; a rejection is answered as an internal error. */
	request(method: string, params: Record<string, unknown>, withdrawn: AbortSignal): Promise<unknown>;
}

interface Waiting {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: AcpError) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
}

const NOT_JSON_KEPT = 20;

export class AcpConnection {
	private nextId = 1;
	private readonly incoming = new Map<
		number | string,
		{ controller: AbortController; method: string; params: Record<string, unknown> }
	>();
	private readonly waiting = new Map<number, Waiting>();
	private ended: string | null = null;
	/** Lines that were not protocol messages, the latest ones. */
	readonly notJson: string[] = [];

	constructor(
		/** Writes one line (without the line break). Returns false when it could not be written. */
		private readonly writeLine: (line: string) => boolean,
		private readonly handlers: AcpHandlers,
		/** The key Windlass's extensions live under in `_meta` and in an error's `data`. */
		private readonly namespace: string,
		/**
		 * Applied to everything the agent sends before anyone sees it: a notification's or a request's
		 * `params`, and a response's `result` and `error`. The turn takes the repository's saved secrets
		 * out there (repo-secrets.ts). A message's `method` and `id` are never passed through it.
		 */
		private readonly clean: <T>(value: T) => T = value => value,
	) {}

	get closed(): boolean {
		return this.ended !== null;
	}

	/** Sends a request and resolves with its result. Rejects with an AcpError: the agent's refusal, a time limit, or the connection's end. */
	request<T>(
		method: string,
		params: Record<string, unknown>,
		options: { timeoutMs?: number; onResult?: (value: T) => void } = {},
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (this.ended !== null) return reject(new AcpError(this.ended, 0, "closed"));
			const id = this.nextId++;
			const entry: Waiting = {
				method,
				reject,
				timer: undefined,
				resolve(value) {
					try {
						// Observe the reply before receive() dispatches the next line from the same chunk.
						options.onResult?.(value as T);
						resolve(value as T);
					} catch (error) {
						reject(error);
					}
				},
			};
			if (options.timeoutMs !== undefined) {
				entry.timer = setTimeout(() => {
					if (this.waiting.delete(id))
						reject(
							new AcpError(`${method} was not answered within ${formatSeconds(options.timeoutMs!)}`, 0, "timeout"),
						);
				}, options.timeoutMs);
			}
			this.waiting.set(id, entry);
			if (!this.send({ jsonrpc: "2.0", id, method, params })) {
				this.waiting.delete(id);
				if (entry.timer) clearTimeout(entry.timer);
				reject(new AcpError(this.ended ?? "the connection to the engine is closed", 0, "closed"));
			}
		});
	}

	/** The id the last request was sent with. */
	get lastId(): number {
		return this.nextId - 1;
	}

	/**
	 * What a connection taken up again on a restarted server needs (`restore`): the next id, the agent's
	 * requests not answered yet, and the requests of ours still waiting. The params are as `clean` left them.
	 */
	state(): {
		nextId: number;
		incoming: Array<[number | string, string, Record<string, unknown>]>;
		waiting: Array<[number, string]>;
	} {
		return {
			nextId: this.nextId,
			incoming: [...this.incoming].map(([id, { method, params }]) => [id, method, params]),
			waiting: [...this.waiting].map(([id, { method }]) => [id, method]),
		};
	}

	/** Continues the numbering of a connection a server before a restart had with the same process. */
	restore(nextId: number): void {
		this.nextId = Math.max(this.nextId, nextId);
	}

	/** A request sent before a restart, as `request` would wait for it: its answer settles what this returns. */
	expect<T>(id: number, method: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (this.ended !== null) return reject(new AcpError(this.ended, 0, "closed"));
			this.waiting.set(id, { method, reject, timer: undefined, resolve: value => resolve(value as T) });
		});
	}

	/** A request of the agent's that a server before a restart had not answered: it is answered now, under the same id. */
	answerAgain(id: number | string, method: string, params: Record<string, unknown>): void {
		if (this.ended === null && !this.incoming.has(id)) void this.answer(id, method, params);
	}

	notify(method: string, params: Record<string, unknown>): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	/** One line from the agent. */
	receive(line: string): void {
		const text = line.trim();
		if (text === "") return;
		let message: unknown;
		try {
			message = JSON.parse(text);
		} catch {
			return this.keep(line);
		}
		if (typeof message !== "object" || message === null || Array.isArray(message)) return this.keep(line);
		const { id, method } = message as { id?: unknown; method?: unknown };
		if (method === "$/cancel_request" && id == null) {
			// Correlate using the wire id, including its type, before redacting payload strings.
			const requestId = (message as { params?: { requestId?: unknown } }).params?.requestId;
			if (typeof requestId === "number" || typeof requestId === "string")
				this.incoming.get(requestId)?.controller.abort();
			return;
		}
		const { params, result, error } = this.clean(message as { params?: unknown; result?: unknown; error?: unknown });
		if (typeof method === "string") {
			const given = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
			if (id === undefined || id === null) {
				try {
					this.handlers.notification(method, given);
				} catch {
					// A handler's failure must not end the connection.
				}
				return;
			}
			void this.answer(id as number | string, method, given);
			return;
		}
		if (typeof id !== "number") return this.keep(line);
		const entry = this.waiting.get(id);
		if (entry === undefined) return;
		this.waiting.delete(id);
		if (entry.timer) clearTimeout(entry.timer);
		if (error !== undefined && error !== null) entry.reject(this.errorOf(error, entry.method));
		else entry.resolve(result);
	}

	/** The connection ended: every request still waiting fails with `why`, and nothing more is sent. */
	end(why: string): void {
		if (this.ended !== null) return;
		this.ended = why;
		for (const { controller } of this.incoming.values()) controller.abort();
		this.incoming.clear();
		for (const [id, entry] of this.waiting) {
			this.waiting.delete(id);
			if (entry.timer) clearTimeout(entry.timer);
			entry.reject(new AcpError(why, 0, "closed"));
		}
	}

	private async answer(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
		const controller = new AbortController();
		const entry = { controller, method, params };
		this.incoming.set(id, entry);
		try {
			const result = await this.handlers.request(method, params, controller.signal);
			this.send({ jsonrpc: "2.0", id, result: result ?? null });
		} catch (error) {
			const message = errorText(error);
			this.send({ jsonrpc: "2.0", id, error: { code: error instanceof MethodNotFound ? -32601 : -32603, message } });
		} finally {
			if (this.incoming.get(id) === entry) this.incoming.delete(id);
		}
	}

	private send(message: Record<string, unknown>): boolean {
		if (this.ended !== null) return false;
		try {
			return this.writeLine(JSON.stringify(message));
		} catch {
			return false;
		}
	}

	private keep(line: string): void {
		this.notJson.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
		if (this.notJson.length > NOT_JSON_KEPT) this.notJson.shift();
	}

	private errorOf(raw: unknown, method: string): AcpError {
		const error = (typeof raw === "object" && raw !== null ? raw : {}) as {
			code?: unknown;
			message?: unknown;
			data?: unknown;
		};
		const code = typeof error.code === "number" ? error.code : 0;
		const data =
			typeof error.data === "object" && error.data !== null
				? (error.data as Record<string, unknown>)[this.namespace]
				: undefined;
		const named = (typeof data === "object" && data !== null ? data : {}) as {
			reason?: unknown;
			message?: unknown;
			holderPid?: unknown;
			code?: unknown;
		};
		// The engine's own sentence when it gave one; the protocol's message otherwise.
		const message =
			typeof named.message === "string" && named.message !== ""
				? named.message
				: typeof error.message === "string" && error.message !== ""
					? withDetails(error.message, error.data)
					: `${method} failed`;
		return new AcpError(
			message,
			code,
			typeof named.reason === "string" ? named.reason : null,
			typeof named.holderPid === "number" ? named.holderPid : null,
			typeof named.code === "string" && named.code !== "" ? named.code : null,
			limitError(error.data),
			typeof error.data === "object" && error.data !== null
				? (error.data as Record<string, unknown>).codexErrorInfo
				: undefined,
		);
	}
}

/** A generic JSON-RPC message ("Internal error") with the `data.details` the engine put beside it: the details say what failed. */
function withDetails(message: string, data: unknown): string {
	const details = typeof data === "object" && data !== null ? (data as { details?: unknown }).details : undefined;
	return typeof details === "string" && details.trim() !== "" ? `${message}: ${details.trim().slice(0, 300)}` : message;
}

/** Thrown by a request handler for a method it does not serve. */
export class MethodNotFound extends Error {
	constructor(method: string) {
		super(`method not found: ${method}`);
		this.name = "MethodNotFound";
	}
}

function formatSeconds(ms: number): string {
	return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** Splits a stream of text into lines, keeping what is left of an unfinished one. */
export class LineSplitter {
	private rest = "";
	constructor(private readonly line: (text: string) => void) {}

	/** The start of a line whose end has not come yet. */
	get pending(): string {
		return this.rest;
	}

	/** Takes up a stream whose last line had begun before a restart. */
	resume(rest: string): void {
		this.rest = rest;
	}

	push(chunk: string): void {
		const parts = (this.rest + chunk).split("\n");
		this.rest = parts.pop() ?? "";
		for (const part of parts) this.line(part);
	}

	/** The stream ended: what is left is a line too. */
	flush(): void {
		const text = this.rest;
		this.rest = "";
		if (text !== "") this.line(text);
	}
}
