import assert from "node:assert/strict";
import { test } from "node:test";
import { extractToken, plainText, scrub, TokenGate } from "../src/token.ts";

const TOKEN = "sk-ant-oat01-" + "Ab3_x-9".repeat(13) + "QQAA";
const wrap = (text: string, width: number) => text.match(new RegExp(`.{1,${width}}`, "g"))!;

test("reads the token off plain output", () => {
	const output = `Your OAuth token (valid for 1 year):\r\n\r\n${TOKEN}\r\n\r\nStore this token securely.\r\n`;
	assert.equal(extractToken(output), TOKEN);
});

test("reads a token wrapped at the terminal's width, inside a box and between colours", () => {
	const pieces = wrap(TOKEN, 38);
	const box = pieces.map(piece => `\x1b[2m│\x1b[22m \x1b[1m${piece.padEnd(38)}\x1b[22m \x1b[2m│\x1b[22m`);
	const output = [
		"\x1b[?25l\x1b[2K\x1b[1A\x1b[2K\x1b[G╭────────────────────────────────────────╮",
		"│ \x1b[32m✓ Long-lived authentication token created\x1b[39m │",
		...box,
		"│                                        │",
		"│ Store this token securely.             │",
		"╰────────────────────────────────────────╯\x1b[?25h",
	].join("\r\r\n");
	assert.equal(extractToken(output), TOKEN);
});

test("does not run the token into the words after it", () => {
	const pieces = wrap(TOKEN, 40);
	const output = [...pieces, "Store", "this token securely."].join("\n");
	// The last piece is shorter than the width, so the wrap ends there.
	assert.equal(extractToken(output), TOKEN);
	const flush = wrap(TOKEN.slice(0, 120), 40);
	assert.equal(extractToken([...flush, "Use it with CLAUDE_CODE_OAUTH_TOKEN"].join("\n")), TOKEN.slice(0, 120));
});

test("redraws: cursor moves separate frames, and the last full token wins", () => {
	const partial = TOKEN.slice(0, 30);
	const output = `${partial}\x1b[1A\x1b[2K${TOKEN}\x1b[1C\x1b[0m`;
	assert.equal(plainText("a\x1b[1Cb\x1b[2Kc\x1b]8;;https://x\x07link\x1b]8;;\x07"), "a b\nclink");
	assert.equal(extractToken(output), TOKEN);
});

test("finds nothing where there is no token", () => {
	assert.equal(extractToken(""), null);
	assert.equal(extractToken("Error: Authentication cancelled.\r\n"), null);
	assert.equal(extractToken("sk-ant-oat01-short\n"), null);
	assert.equal(extractToken("sk-ant-api03-" + "x".repeat(80)), null);
});

test("scrubs Anthropic secrets and JWTs (a ChatGPT sign-in's tokens) out of messages", () => {
	assert.equal(scrub(`refused ${TOKEN} and sk-ant-api03-abc`), "refused sk-ant-… and sk-ant-…");
	assert.equal(scrub("bad token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln: no"), "bad token eyJ…: no");
});

test("the token never reaches the screen, even split across chunks and wrapped in a box", () => {
	const pieces = wrap(TOKEN, 38);
	const output = [
		"Open this link to sign in: https://claude.ai/oauth/authorize?code=true",
		"Paste code here if prompted >",
		"\x1b[32m✓ Long-lived authentication token created\x1b[39m",
		...pieces.map(piece => `│ ${piece.padEnd(38)} │`),
		"Store this token securely.",
	].join("\r\r\n");
	for (const size of [1, 3, 7, 64, output.length]) {
		const gate = new TokenGate();
		let shown = "";
		for (let i = 0; i < output.length; i += size) shown += gate.write(output.slice(i, i + size));
		shown += gate.end(extractToken(output));
		assert.ok(shown.includes("Paste code here if prompted"), "the prompts pass through");
		assert.ok(shown.includes("Store this token securely."), "the words after the token are shown");
		assert.ok(shown.includes("(hidden)"), "the user is told it was hidden");
		for (const piece of pieces) assert.ok(!shown.includes(piece), `piece shown at chunk size ${size}`);
		assert.ok(!shown.includes(TOKEN.slice(13, 25)));
	}
	const quiet = new TokenGate();
	assert.equal(quiet.write("no token here sk-ant") + quiet.end(null), "no token here sk-ant");
});
