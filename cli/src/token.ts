/**
 * Reading the token `claude setup-token` prints off its terminal output. The output is a TUI's: colours, cursor
 * moves, redraws, and a long token hard-wrapped at the terminal's width, sometimes inside a box. Nothing here
 * prints or keeps the token.
 */

const PREFIX = "sk-ant-oat01-";
const TOKEN_CHARS = /[A-Za-z0-9_-]/;
/** What a box or indentation puts around a wrapped line. */
const EDGE = /^[\s│┃║|]+|[\s│┃║|]+$/g;

/**
 * Plain text from terminal output: a cursor move, an erase or a line feed becomes a line break (so two redrawn
 * pieces never run together), a cursor step forward a space, and every other escape nothing.
 */
export function plainText(output: string): string {
	return (
		output
			// OSC (titles, hyperlinks): ESC ] … BEL or ESC \
			.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
			// CSI: ESC [ params final
			.replace(/\x1b\[[0-?]*[ -/]*([@-~])/g, (_, final: string) =>
				final === "C" ? " " : /[ABEFGHJKSTdf]/.test(final) ? "\n" : "",
			)
			// Other two-character escapes (ESC 7, ESC 8, ESC M …)
			.replace(/\x1b[@-_]/g, "\n")
			// A pseudo-terminal turns "\r\n" into "\r\r\n": one line break however many carriage returns.
			.replace(/\r*\n|\r+/g, "\n")
			// Other control characters but tab and line feed
			.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
	);
}

/**
 * The last setup token in the output, joined back together where the terminal wrapped it: while a piece of the
 * token fills its line to the full width, the next line continues it when that line holds nothing but token
 * characters (inside the same box edges) and is no wider. Null when there is none.
 */
export function extractToken(output: string): string | null {
	const lines = plainText(output)
		.split("\n")
		.map(line => line.replace(EDGE, ""));
	let found: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const at = line.lastIndexOf(PREFIX);
		if (at === -1) continue;
		let end = at + PREFIX.length;
		while (end < line.length && TOKEN_CHARS.test(line[end]!)) end++;
		let token = line.slice(at, end);
		const width = line.length;
		let full = end === width;
		while (full && i + 1 < lines.length) {
			const more = lines[i + 1]!;
			const continues =
				more !== "" && more.length <= width && !more.includes(PREFIX) && [...more].every(ch => TOKEN_CHARS.test(ch));
			if (!continues) break;
			token += more;
			full = more.length === width;
			i++;
		}
		if (token.length >= PREFIX.length + 20) found = token;
	}
	return found;
}

/** Text with anything that looks like an Anthropic secret or a JWT (a ChatGPT sign-in's tokens) taken out, for every message the CLI shows. */
export function scrub(text: string): string {
	return text
		.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…")
		.replace(/eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)*/g, "eyJ…");
}

/** The longest end of `text` that could be the start of the token's prefix, held back until the next chunk. */
function prefixStart(text: string): number {
	for (let n = Math.min(PREFIX.length - 1, text.length); n > 0; n--) if (PREFIX.startsWith(text.slice(-n))) return n;
	return 0;
}

/**
 * What of Claude Code's output reaches the user's terminal. Its screens pass through as they come, so its prompts
 * work, until the token starts; from there the output is held. When it exits, `end` gives the held rest as plain
 * text with the token taken out, every wrapped piece of it too. The token comes last, so nothing interactive waits.
 */
export class TokenGate {
	private held = "";
	private rest: string[] = [];
	private stopped = false;

	/** The part of `chunk` to show now. */
	write(chunk: string): string {
		if (this.stopped) {
			this.rest.push(chunk);
			return "";
		}
		const text = this.held + chunk;
		const at = text.indexOf(PREFIX);
		if (at !== -1) {
			this.stopped = true;
			this.held = "";
			this.rest.push(text.slice(at));
			return text.slice(0, at);
		}
		const keep = prefixStart(text);
		this.held = text.slice(text.length - keep);
		return text.slice(0, text.length - keep);
	}

	/** What is left to show once the output has ended, with `token` (when one was read) removed. */
	end(token: string | null): string {
		if (!this.stopped) return this.held;
		const shown = plainText(this.rest.join(""))
			.split("\n")
			.filter(line => {
				const bare = line.replace(EDGE, "");
				return !(token && bare.length >= 8 && !bare.includes(PREFIX) && token.includes(bare));
			})
			.join("\n");
		return (
			"\x1b[0m" +
			scrub(shown)
				.replace(/sk-ant-…/g, "sk-ant-oat01-… (hidden)")
				.replace(/\n{3,}/g, "\n\n")
		);
	}
}
