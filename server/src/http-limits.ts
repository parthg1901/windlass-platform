import { isIP, SocketAddress } from "node:net";
import { config } from "./config.js";

export const MINUTE_MS = 60_000;

// registry.listen passes application.fetch the ordinary headers, without the socket peer.
// Only an ingress that overwrites a header on EVERY path to this port can supply an address.
export function clientAddress(request: Request): string | null {
	const name = config.httpLimits.ipHeader;
	if (!name) return null; // Address limits are disabled. An invalid configured header still uses the "" bucket.
	const ip = request.headers.get(name);
	if (!ip || ip.includes("%")) return "";
	switch (isIP(ip)) {
		case 4:
			return ip;
		case 6: {
			const canonical = new SocketAddress({ address: ip, family: "ipv6" }).address;
			return canonical.replace(/^::ffff:(?=\d+\.)/, "");
		}
		default:
			return "";
	}
}

interface Count {
	used: number;
	pending: number;
	changed?: Promise<void>;
	wake?: () => void;
}

/** One minute of admission counts on this listener. New keys share an overflow budget
 * once full; an influx of new addresses cannot evict a live counter. */
export class AddressBudget {
	private counts = new Map<string, Count>();
	private until = 0;

	constructor(private readonly limit: number) {}

	private counter(key: string, now: number): Count {
		if (now >= this.until) {
			this.counts.clear();
			this.until = now + MINUTE_MS;
		}
		if (this.counts.size >= 4096 && !this.counts.has(key)) key = "";
		let count = this.counts.get(key);
		if (!count) {
			count = { used: 0, pending: 0 };
			this.counts.set(key, count);
		}
		return count;
	}

	/** Zero when admitted, otherwise seconds until this window ends. */
	take(key: string | null): number {
		if (key === null) return 0;
		const now = Date.now();
		const count = this.counter(key, now);
		if (count.used >= this.limit) return Math.ceil((this.until - now) / 1000);
		count.used++;
		return 0;
	}

	/** Call only after rejection. Without a trusted address, refusals share one counter. */
	refusal(address: string | null): number {
		return this.take(address ?? "refused");
	}

	/** Reserve capacity before an expensive lookup. When slots are merely in flight, wait
	 * for their outcomes: concurrent successful requests must not count as failures. */
	async lookup(key: string | null): Promise<number | ((invalid: boolean) => void)> {
		if (key === null) return () => {};
		for (;;) {
			const now = Date.now();
			const count = this.counter(key, now);
			if (count.used >= this.limit) return Math.ceil((this.until - now) / 1000);
			if (count.used + count.pending < this.limit) {
				count.pending++;
				return invalid => {
					count.pending--;
					if (invalid) count.used++;
					count.wake?.();
				};
			}
			if (!count.changed) {
				count.changed = new Promise<void>(resolve => {
					const wake = () => {
						clearTimeout(timer);
						count.wake = undefined;
						count.changed = undefined;
						resolve();
					};
					const timer = setTimeout(wake, this.until - now);
					count.wake = wake;
				});
			}
			await count.changed;
		}
	}
}

export function rateLimited(seconds: number, message: string, code = "rate_limited"): Response {
	return Response.json(
		{ code, message },
		{
			status: 429,
			headers: { "cache-control": "no-store", "retry-after": String(seconds) },
		},
	);
}

const noStore = (status: number, body: unknown) =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** RivetKit has already bounded and buffered the HTTP body. Apply a route's smaller limit before parsing it. */
export async function readJsonBody(request: Request, maxBytes: number): Promise<{ value: unknown } | Response> {
	if (Number(request.headers.get("content-length")) > maxBytes) return noStore(413, { code: "body_too_large" });
	const reader = request.body?.getReader();
	if (!reader) return noStore(400, { code: "bad_input" });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > maxBytes) return noStore(413, { code: "body_too_large" });
			chunks.push(value);
		}
		try {
			return { value: JSON.parse(Buffer.concat(chunks).toString()) };
		} catch {
			return noStore(400, { code: "bad_input" });
		}
	} finally {
		reader.releaseLock();
	}
}
