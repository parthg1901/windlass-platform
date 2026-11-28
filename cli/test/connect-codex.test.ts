/**
 * `connect codex` as a user runs it: the CLI against a stand-in platform, with a stand-in `windlass` (or `npx`) on
 * PATH that signs in the way Windlass does, by writing its files into `$XDG_DATA_HOME/windlass`.
 */
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PRIVATE_DIR_PREFIX, compatibleWindlass } from "../src/windlass-login.ts";
import { cli, platform, REQUEST } from "./stand-ins.ts";

// Assembled here so no token-shaped literal is committed for the secret scan to flag.
const part = (text: string) => Buffer.from(text).toString("base64url");
const ACCESS = [part('{"alg":"RS256"}'), part('{"sub":"access"}'), part("signature-access")].join(".");
const REFRESH = "rt_FAKE-REFRESH-not-a-real-token-" + "q".repeat(20);
const AUTH = JSON.stringify({
	account: { sub: "sub-a", email: "a@b.com" },
	accessToken: ACCESS,
	refreshToken: REFRESH,
	expiresAt: Date.now() + 3_600_000,
});

const root = mkdtempSync(join(tmpdir(), "windlassai-codex-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** What a run of the stand-in Windlass records: where it was pointed, and its arguments. */
const record = join(root, "record");
mkdirSync(record);
const login = `
printf '%s' "$XDG_DATA_HOME" > '${record}/data-home'
printf '%s' "$HOME" > '${record}/home'
printf '%s' "\${WINDLASS_ACCESS_TOKEN_FILE:-none}" > '${record}/token-file'
[ -n "$FAKE_WINDLASS_FAIL" ] && { echo 'Sign-in cancelled.' >&2; exit 1; }
mkdir -p "$XDG_DATA_HOME/windlass"
printf '%s' '${AUTH}' > "$XDG_DATA_HOME/windlass/auth.json"
printf 'host-1234' > "$XDG_DATA_HOME/windlass/host-id"
printf '{"pending":true}' > "$XDG_DATA_HOME/windlass/auth-pending.json"
echo 'Signed in to ChatGPT as a@b.com.'
`;

function script(dir: string, name: string, body: string) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), `#!/bin/sh\n${body}`);
	chmodSync(join(dir, name), 0o755);
}
// An installed Windlass, at the version FAKE_WINDLASS_VERSION names.
const installed = join(root, "installed");
script(
	installed,
	"windlass",
	`case "$1" in
--version) echo "Windlass \${FAKE_WINDLASS_VERSION:-0.7.1} (linux-x64)"; exit 0;;
login) [ "$#" -eq 1 ] || exit 64; touch '${record}/windlass-ran';;
*) exit 64;;
esac
${login}`,
);
// npx, which runs the pinned release when the installed one will not do.
script(
	installed,
	"npx",
	`printf '%s ' "$@" > '${record}/npx-args'
[ "$4 $5" = "windlass login" ] || exit 64
${login}`,
);

/** A run with its own temporary directory and a Windlass sign-in of the user's own in XDG_DATA_HOME. */
async function connect(env: Record<string, string>, decision: "approved" | "denied" = "approved") {
	rmSync(record, { recursive: true, force: true });
	mkdirSync(record);
	const tmp = mkdtempSync(join(root, "tmp-"));
	const userData = mkdtempSync(join(root, "user-data-"));
	mkdirSync(join(userData, "windlass"));
	writeFileSync(join(userData, "windlass", "auth.json"), "the user's own sign-in");
	const site = await platform({ decision, connect: 200, body: { account: "a@b.com · Plus" } });
	const run = await cli(installed, ["connect", "codex", "--no-browser"], {
		WINDLASS_PLATFORM: site.url,
		TMPDIR: tmp,
		XDG_DATA_HOME: userData,
		WINDLASS_ACCESS_TOKEN_FILE: join(root, "never-read"),
		...env,
	});
	const left = readdirSync(tmp).filter(name => name.startsWith(PRIVATE_DIR_PREFIX));
	const own = readdirSync(join(userData, "windlass"));
	const ownAuth = readFileSync(join(userData, "windlass", "auth.json"), "utf8");
	const said = (name: string) => (existsSync(join(record, name)) ? readFileSync(join(record, name), "utf8") : null);
	return { run, site, tmp, left, own, ownAuth, said, userData };
}

test("approve in the browser, then Windlass signs in here in a private directory and its files go to the platform", async () => {
	const { run, site, tmp, left, own, ownAuth, said, userData } = await connect({});
	assert.equal(run.code, 0, run.stderr);
	assert.match(run.stdout, /code KQ2M-8XF4/);
	assert.match(run.stdout, /connect\?code=KQ2M-8XF4&plan=openai/);
	assert.match(run.stdout, /Connected: a@b\.com · Plus/);
	assert.ok(said("windlass-ran") !== null, "the installed, compatible Windlass ran");
	assert.equal(said("npx-args"), null);
	assert.deepEqual(site.seen[0]!.body, { provider: "openai" });
	assert.deepEqual(site.seen.at(-1), {
		path: "/platform/connect",
		body: { request: REQUEST, signIn: { files: { "auth.json": AUTH, "host-id": "host-1234" } } },
	});
	// Windlass was pointed at a private directory under the temporary one, never at the user's own data, and got no token file.
	const dataHome = said("data-home")!;
	assert.ok(dataHome.startsWith(join(tmp, PRIVATE_DIR_PREFIX)), dataHome);
	assert.ok(said("home")!.startsWith(join(tmp, PRIVATE_DIR_PREFIX)));
	assert.notEqual(dataHome, userData);
	assert.equal(said("token-file"), "none");
	assert.deepEqual(left, [], "the private directory is gone");
	assert.ok(!existsSync(dataHome));
	assert.deepEqual([own, ownAuth], [["auth.json"], "the user's own sign-in"]);
	// Nothing of the sign-in on screen.
	for (const secret of [ACCESS, REFRESH, "host-1234", "eyJ"])
		assert.ok(!run.stdout.includes(secret) && !run.stderr.includes(secret), secret);
});

test("an installed Windlass of another release is not used: npx runs the pinned one", async () => {
	const { run, said, left } = await connect({ FAKE_WINDLASS_VERSION: "0.6.0" });
	assert.equal(run.code, 0, run.stderr);
	assert.equal(said("windlass-ran"), null);
	assert.equal(said("npx-args"), "-y -p windlass-agent@0.7.1 windlass login ");
	assert.deepEqual(left, []);
	assert.ok(compatibleWindlass("Windlass 0.7.3 (darwin-arm64)") && compatibleWindlass("windlass v0.7.1"));
	assert.ok(!compatibleWindlass("Windlass 0.8.0") && !compatibleWindlass("Windlass 0.7.0") && !compatibleWindlass(""));
});

test("a sign-in that does not finish connects nothing and leaves nothing behind", async () => {
	const { run, site, left, own, ownAuth, said } = await connect({ FAKE_WINDLASS_FAIL: "1" });
	assert.equal(run.code, 1);
	assert.match(run.stderr, /ChatGPT sign-in did not finish/);
	assert.ok(said("data-home") !== null, "Windlass ran");
	assert.ok(!site.seen.some(one => one.path === "/platform/connect"));
	assert.deepEqual(left, []);
	assert.deepEqual([own, ownAuth], [["auth.json"], "the user's own sign-in"]);
});

test("a refused sign-in reads as the platform means it, still without the files on screen", async () => {
	rmSync(record, { recursive: true, force: true });
	mkdirSync(record);
	const tmp = mkdtempSync(join(root, "tmp-"));
	const site = await platform({ decision: "approved", connect: 400, body: { code: "bad_sign_in", message: AUTH } });
	const run = await cli(installed, ["connect", "codex", "--no-browser"], { WINDLASS_PLATFORM: site.url, TMPDIR: tmp });
	assert.equal(run.code, 1);
	assert.match(run.stderr, /did not save a finished ChatGPT sign-in/);
	assert.ok(!run.stderr.includes(REFRESH) && !run.stdout.includes(REFRESH));
	assert.deepEqual(readdirSync(tmp), []);
});

test("a denied request runs no sign-in", async () => {
	const { run, said, site } = await connect({}, "denied");
	assert.equal(run.code, 1);
	assert.match(run.stderr, /denied in the browser/);
	assert.equal(said("data-home"), null);
	assert.ok(!site.seen.some(one => one.path === "/platform/connect"));
});
