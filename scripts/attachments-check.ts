/** cd server && npx tsx ../scripts/attachments-check.ts
 * Offline by default. --docker runs the shell protocol in the sandbox image with networking disabled.
 * --bucket exercises an explicitly configured loopback S3 test service, never a deployment bucket.
 */
import { imageId } from "./check-image.js";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { crc32, deflateSync } from "node:zlib";
import {
	ATTACHMENT_LIMITS,
	attachmentKey,
	pngHeader,
	shotRequest,
	type ShotRequest,
} from "../server/src/factory/attachments.js";
import { S3ObjectStore } from "../server/src/bucket/s3.js";
import { StandInObjectStore } from "../server/src/bucket/stand-in.js";
import { noSpend } from "../server/src/factory/budget.js";
import { commitScript } from "../server/src/github/git.js";
import type { SandboxHandle } from "../server/src/sandbox/api.js";
import type { ItemsCtx } from "../server/src/actors/user-items.js";
import type { ItemSummary, SessionSummary } from "../server/src/contract.js";
import type { AttachmentLedger } from "../server/src/sandbox/attach.js";

const root = mkdtempSync(join(tmpdir(), "wlp-shots-check-"));
const docker = process.argv.includes("--docker");
const digest = (body: Buffer | string) => createHash("sha256").update(body).digest("hex");
const name = ".wlp-shots/home.png";
const shot: ShotRequest = { file: name, caption: "Home", page: null, shows: null };
const one = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII=",
	"base64",
);
function png1280() {
	const chunk = (name: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(name), data]);
		const length = Buffer.alloc(4),
			crc = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.from(one.subarray(16, 29));
	header.writeUInt32BE(1280);
	header.writeUInt32BE(800, 4);
	header[9] = 0;
	return Buffer.concat([
		one.subarray(0, 8),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.alloc(1281 * 800))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
let failed = 0;
async function check(title: string, test: () => unknown) {
	try {
		await test();
		console.log("PASS", title);
	} catch {
		console.error("FAIL", title);
		failed++;
	}
}
function run(bin: string, args: string[], cwd = root, input = "", env: NodeJS.ProcessEnv = {}) {
	const result = spawnSync(bin, args, {
		cwd,
		input,
		env: { PATH: process.env.PATH, HOME: root, ...env },
		encoding: "utf8",
		timeout: 45_000,
	});
	assert.ok(result.status === 0, "fixture command failed");
	return result.stdout.trim();
}

async function cases() {
	const big = png1280();
	await check("real PNG and 33-byte header", () => {
		assert.deepEqual(pngHeader(big), { width: 1280, height: 800 });
		assert.deepEqual(pngHeader(one.subarray(0, 33)), { width: 1, height: 1 });
	});
	const header = (offset: number, value: number, wide = false) => {
		const copy = Buffer.from(one.subarray(0, 33));
		if (wide) copy.writeUInt32BE(value, offset);
		else copy[offset] = value;
		if (offset < 29) copy.writeUInt32BE(crc32(copy.subarray(12, 29)), 29);
		return copy;
	};
	const square = header(16, 20000, true);
	square.writeUInt32BE(20000, 20);
	const pixels = header(16, 3840, true);
	pixels.writeUInt32BE(8640, 20);
	for (const dimensions of [square, pixels]) dimensions.writeUInt32BE(crc32(dimensions.subarray(12, 29)), 29);
	for (const [label, bytes] of Object.entries({
		JPEG: Buffer.concat([Buffer.from([255, 216, 255]), one]),
		GIF: Buffer.concat([Buffer.from("GIF89a"), one]),
		"IHDR second": Buffer.concat([header(12, 65), one.subarray(8)]),
		"wrong chunk length": header(8, 14, true),
		"20000 square": square,
		"17M tall": header(20, 17_000_000, true),
		"pixel limit": pixels,
		"zero width": header(16, 0, true),
		"depth 3": header(24, 3),
		"colour 5": header(25, 5),
		"invalid depth for colour": header(24, 1),
		compression: header(26, 1),
		filter: header(27, 1),
		interlace: header(28, 2),
		checksum: header(29, 0),
		short: one.subarray(0, 32),
	}))
		await check("refuses " + label, () => assert.ok("problem" in pngHeader(bytes)));
	const raw = { file: name, caption: "Home" };
	for (const [label, value] of Object.entries({
		parent: [{ ...raw, file: "../a.png" }],
		absolute: [{ ...raw, file: "/workspace/" + name }],
		uppercase: [{ ...raw, file: ".wlp-shots/A.PNG" }],
		jpg: [{ ...raw, file: ".wlp-shots/a.jpg" }],
		five: Array.from({ length: 5 }, (_, i) => ({ ...raw, file: `.wlp-shots/${i}.png` })),
		caption: [{ ...raw, caption: "a".repeat(201) }],
		line: [{ ...raw, caption: "a\u2028b" }],
		duplicate: [raw, raw],
		label: [{ ...raw, shows: "inside" }],
		page: [{ ...raw, page: "p".repeat(301) }],
		shape: {},
		extra: [{ ...raw, url: "x" }],
	}))
		await check("refuses request " + label, () => assert.ok("problems" in shotRequest(value)));
	await check("clean caption and key segments", () => {
		assert.deepEqual(shotRequest([{ ...raw, caption: "value\u0001   " }]), [{ ...shot, caption: "value" }]);
		assert.equal(attachmentKey("test/", "u", "i", "a"), "test/attachments/u/i/a.png");
		for (const part of ["", "..", "x/y", "."]) assert.throws(() => attachmentKey("", part, "i", "a"));
	});

	const store = new StandInObjectStore();
	const settings = {
		endpoint: "https://storage.invalid",
		bucket: "test",
		region: "auto",
		style: "path" as const,
		accessKeyId: "fixture",
		secretAccessKey: "fixture",
	};
	const signed = new S3ObjectStore(settings, {
		fetch: async (_url, init) => {
			const h = new Headers(init?.headers);
			assert.equal(h.get("range"), "bytes=0-32");
			assert.ok(h.get("authorization")?.includes("host;range;"));
			return new Response(one.subarray(0, 33), { status: 206 });
		},
	});
	await check("S3 signs length and type, both response overrides and the range request", async () => {
		const put = new URL(
			(await signed.linkToPut("pic", { size: one.length, ttlMs: 60000, contentType: "image/png" })).url,
		);
		assert.ok(put.searchParams.get("X-Amz-SignedHeaders") === "content-length;content-type;host");
		const get = new URL(
			(await signed.linkToGet("pic", { ttlMs: 60000, contentType: "image/png", disposition: "inline" })).url,
		);
		assert.ok(
			get.searchParams.get("response-content-type") === "image/png" &&
				get.searchParams.get("response-content-disposition") === "inline",
		);
		assert.deepEqual(Buffer.from((await signed.readStart("pic", 33))!), one.subarray(0, 33));
	});
	const put = await store.linkToPut("pic", { size: one.length, ttlMs: 60000, contentType: "image/png" });
	for (const [label, body, type] of [
		["missing header", one, ""],
		["HTML header", one, "text/html"],
		["extra byte", Buffer.concat([one, Buffer.alloc(1)]), "image/png"],
	] as const)
		await check("PUT rejects " + label, () =>
			assert.equal(store.use(put.url, "PUT", body, type ? { "content-type": type } : {}).status, 403),
		);
	await check("GET overrides stored HTML, bounded prefix, missing object", async () => {
		const html = await store.linkToPut("pic", { size: one.length, ttlMs: 60000, contentType: "text/html" });
		assert.equal(store.use(html.url, "PUT", one, { "content-type": "text/html" }).status, 200);
		const get = await store.linkToGet("pic", { ttlMs: 60000, contentType: "image/png", disposition: "inline" });
		const response = store.use(get.url, "GET");
		assert.equal(response.headers?.get("content-type"), "image/png");
		assert.equal(response.headers.get("content-disposition"), "inline");
		assert.equal((await store.readStart("pic", 33))!.length, 33);
		assert.equal(await store.readStart("gone", 33), null);
	});
	const { backupConfig, config } = await import("../server/src/config.js");
	if (process.argv.includes("--bucket")) {
		const { bucket } = backupConfig();
		assert.ok(
			bucket && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(bucket.endpoint).hostname),
			"Configure a loopback S3 test bucket.",
		);
		const local = new S3ObjectStore(bucket);
		const key = "attachments-check/" + randomBytes(12).toString("hex");
		try {
			const url = (await local.linkToPut(key, { size: one.length, ttlMs: 60000, contentType: "image/png" })).url;
			for (const [body, type] of [
				[one, ""],
				[one, "text/html"],
				[Buffer.concat([one, Buffer.alloc(1)]), "image/png"],
			] as const)
				assert.equal(
					(await fetch(url, { method: "PUT", body, headers: type ? { "content-type": type } : {} })).status,
					403,
				);
			const html = (await local.linkToPut(key, { size: one.length, ttlMs: 60000, contentType: "text/html" })).url;
			assert.ok((await fetch(html, { method: "PUT", body: one, headers: { "content-type": "text/html" } })).ok);
			const get = (await local.linkToGet(key, { ttlMs: 60000, contentType: "image/png", disposition: "inline" })).url;
			assert.equal((await fetch(get)).headers.get("content-type"), "image/png");
			assert.equal((await local.readStart(key, 33))?.length, 33);
		} finally {
			await local.remove(key);
		}
		assert.equal(await local.readStart(key, 33), null);
	}
	const { ATTACH_PACK, ATTACH_CLEAN, ATTACH_UPLOAD, attachmentStore, uploadShots } = await import(
		"../server/src/sandbox/attach.js"
	);
	const top = join(root, "clone"),
		dir = join(top, ".wlp-shots");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(top, name), one);
	symlinkSync("/etc/passwd", join(dir, "outside.png"));
	symlinkSync("home.png", join(dir, "link.png"));
	mkdirSync(join(dir, "dir.png"));
	writeFileSync(join(dir, "large.png"), Buffer.alloc(3 * 1024 * 1024));
	const names = ["home", "outside", "link", "dir", "large", "missing"].map(s => ".wlp-shots/" + s + ".png");
	const prefix = docker ? "/tmp/.wlp-attach-" : join(root, ".wlp-attach-");
	const scriptEnv = {
		WLP_ATTACH_TOP: top,
		WLP_ATTACH_FILES: names.join("\n"),
		WLP_ATTACH_COPY: prefix + "a".repeat(24),
		WLP_ATTACH_MAX: String(ATTACHMENT_LIMITS.bytes),
	};
	const container = docker
		? run("docker", [
				"run",
				"--rm",
				"--network",
				"none",
				"--user",
				`${process.getuid!()}:${process.getgid!()}`,
				"-d",
				"-v",
				root + ":" + root,
				await imageId(process.env.WLP_SHOT_CHECK_IMAGE ?? "windlass-platform-sandbox:shots"),
				"sleep",
				"600",
			])
		: "";
	const dockerExec = (env: Record<string, string>, script: string) => [
		"exec",
		"-i",
		...Object.entries(env).flatMap(([k, v]) => ["-e", k + "=" + v]),
		container,
		"bash",
		"-c",
		script,
	];
	const sh = (script: string, env: Record<string, string> = {}, input = "") =>
		docker
			? run("docker", dockerExec(env, script), root, input)
			: run("bash", ["-c", script.replaceAll("/tmp/.wlp-attach-", prefix)], root, input, env);
	try {
		const pack = () => sh(ATTACH_PACK, scriptEnv).split("\n");
		const clean = () => {
			sh(ATTACH_CLEAN);
			assert.equal(sh(`compgen -G '${prefix}*' || true`), "");
		};
		const packed = pack();
		for (const [i, why] of ["file", "outside", "not_regular", "not_regular", "too_large", "missing"].entries())
			await check("shell " + names[i], () =>
				i
					? assert.equal(packed[i], `refused ${i} ${why}`)
					: assert.ok(packed[i].startsWith(`file 0 ${one.length} ${digest(one)} `)),
			);
		await check("shell uploads private copy after original changes; hash mismatch and cleanup", async () => {
			const path = scriptEnv.WLP_ATTACH_COPY + "-0.png";
			const env = { WLP_ATTACH_PATH: path, WLP_ATTACH_SHA: digest(one) };
			writeFileSync(join(top, name), big);
			// Real curl, with the disk socket substituting for a TCP listener. The signer stays in this process.
			const socket = join(root, "bucket.sock");
			const signed = await store.linkToPut("snapshot", { size: one.length, ttlMs: 60000, contentType: "image/png" });
			const original = new URL(signed.url);
			const server = createServer(async (request, response) => {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const target = "wlp-stand-in://bucket" + request.url;
				const type = request.headers["content-type"] ?? "";
				response
					.writeHead(
						request.method === "PUT"
							? store.use(target, "PUT", Buffer.concat(chunks), { "content-type": type }).status
							: 403,
					)
					.end();
			});
			await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socket, resolve));
			try {
				const script =
					`curl() { [ "$1" = -q ] || return 1; shift; command curl -q --unix-socket "${socket}" "$@"; }\n` +
					ATTACH_UPLOAD;
				const call = promisify(execFile)(
					docker ? "docker" : "bash",
					docker ? dockerExec(env, script) : ["-c", script],
					{
						cwd: root,
						env: docker ? process.env : { PATH: process.env.PATH, HOME: root, ...env },
						timeout: 30000,
					},
				);
				call.child.stdin!.end(`url = "http://localhost${original.pathname}${original.search}"\n`);
				assert.ok((await call).stdout.trim() === "http 200");
				const downloaded = store.use((await store.linkToGet("snapshot", { ttlMs: 1000 })).url, "GET");
				assert.ok(downloaded.body?.equals(one));
			} finally {
				await new Promise<void>(resolve => server.close(() => resolve()));
			}
			assert.equal(sh(`test ! -e "${path}" && echo gone`), "gone");
			pack();
			assert.equal(sh(ATTACH_UPLOAD, env), "changed");
			clean();
		});
		clean();
	} finally {
		if (container) run("docker", ["stop", "-t", "1", container]);
	}

	// The same fake sandbox, user actions and tables that the factory runs.
	config.sandbox = "fake";
	config.items = true;
	process.env.WLP_FAKE_BACKUP_DIR = join(root, "store");
	const signing = randomBytes(32);
	process.env.WLP_FAKE_BUCKET_SIGNING_SECRET = signing.toString("hex");
	const bucket = attachmentStore() as StandInObjectStore;
	const { createFakeSandboxLayer } = await import("../server/src/sandbox-fake.js");
	const layer = createFakeSandboxLayer({ signIns: "memory" });
	const uid = "owner",
		itemId = "i_fixture",
		sessionId = "s_fixture",
		key = itemId + ":1:build:1";
	const id = await layer.sandboxes.create({ uid, sessionId, profile: layer.sandboxes.profiles()[0].id });
	const handle = (await layer.sandboxes.connect(id))! as SandboxHandle & {
		sandbox: { shots: Map<string, Buffer | "outside" | "not_regular">; copies: Map<string, Buffer> };
	};
	const { ITEM_TABLES, itemActions, loadItems } = await import("../server/src/actors/user-items.js");
	const { serviceParams } = await import("../server/src/auth.js");
	const { issueServiceToken, issueUserToken } = await import("../server/src/tokens.js");
	const sql = new DatabaseSync(":memory:");
	ITEM_TABLES.forEach(q => sql.exec(q));
	type Query = { execute<T>(q: string, ...args: SQLInputValue[]): Promise<T[]> };
	const db = {
		async execute<T>(q: string, ...args: SQLInputValue[]) {
			return sql.prepare(q).all(...args) as T[];
		},
		async transaction<T>(fn: (tx: Query) => Promise<T>): Promise<T> {
			sql.exec("BEGIN");
			try {
				const result = await fn(db);
				sql.exec("COMMIT");
				return result;
			} catch (e) {
				sql.exec("ROLLBACK");
				throw e;
			}
		},
	};
	const state = await loadItems(db as never);
	// The live feed groups items by repository and source (item-pages.ts), so the summary carries both.
	const summary = {
		id: itemId,
		sessionId,
		state: "working",
		revision: 1,
		updatedAt: Date.now(),
		createdAt: Date.now(),
		spent: noSpend(),
		source: "web",
		repository: { provider: "github", id: 7101, owner: "ada", name: "harbor", branch: "main" },
	} as ItemSummary;
	state.items.set(itemId, summary);
	const alarms = new Set<string>();
	const c = {
		vars: {
			tokenGen: 0,
			items: state,
			sessions: new Map([[sessionId, { id: sessionId, item: { id: itemId } } as SessionSummary]]),
		},
		db,
		key: [uid],
		conn: { params: serviceParams() },
		schedule: {
			at: async () => {
				const id = randomBytes(8).toString("hex");
				alarms.add(id);
				return id;
			},
			cancel: async (id: string) => alarms.delete(id),
		},
		broadcast() {},
		log: { warn() {}, error() {} },
	} as unknown as ItemsCtx;
	const ledger: AttachmentLedger = {
		internalReserveAttachment: v => itemActions.internalReserveAttachment(c, v),
		internalRecordAttachment: v => itemActions.internalRecordAttachment(c, v),
		internalSettleAttachments: v => itemActions.internalSettleAttachments(c, v),
		internalReleaseAttachment: id => itemActions.internalReleaseAttachment(c, id),
		internalDeleteItemAttachments: id => itemActions.internalDeleteItemAttachments(c, id),
	};
	const file = (shots = [shot]) =>
		uploadShots(handle, handle.cwd, shots, { by: "builder", uid, itemId, sessionId, key }, ledger, bucket);
	const { fileReport, reportBlocks, itemComment } = await import("../server/src/factory/review.js");
	const { platformTools } = await import("../server/src/agent-publish.js");
	await check("report schema, 180 seconds, checked refusals preserve filing, storage-off reply", async () => {
		const tool = platformTools({ publish: false, push: false, report: true }, 1000).find(t => t.name === "report")!;
		assert.equal(tool.timeoutSeconds, 180);
		assert.ok(JSON.stringify(tool.inputSchema).includes("screenshots"));
		let taken = 0;
		const take = (r: import("../server/src/agent-publish.js").AgentReport) => {
			assert.deepEqual(r.screenshots, []);
			taken++;
		};
		const answer = await fileReport({ title: "Keep", screenshots: [raw] }, { text: s => s }, take, null);
		assert.ok(answer.includes("your report was filed without them"));
		assert.equal(taken, 1);
		const refused = await fileReport(
			{ title: "", screenshots: [{ ...raw, file: "../a.png" }] },
			{ text: s => s },
			take,
			null,
		);
		assert.ok(refused.includes("title") && refused.includes("screenshots[0].file"));
		assert.equal(taken, 1);
	});
	const settle = (keep: string[]) => ledger.internalSettleAttachments({ sessionId, key, keep });
	const rows = () =>
		sql.prepare("SELECT * FROM attachments").all() as Array<{ id: string; key: string; state: string; at: number }>;
	const reset = () => {
		sql.exec("DELETE FROM attachments");
		handle.sandbox.shots.clear();
		handle.sandbox.shots.set(name, one);
	};
	await check("accepted PNG, deduplication on another filing, replaced report discards its object", async () => {
		reset();
		const a = await file(),
			b = await file();
		assert.equal(a.screenshots[0]?.width, 1);
		assert.equal(b.screenshots[0]?.id, a.screenshots[0].id);
		assert.equal(rows().length, 1);
		const alias = ".wlp-shots/alias.png";
		handle.sandbox.shots.set(alias, one);
		const sameReport = await file([shot, { ...shot, file: alias }]);
		assert.equal(sameReport.screenshots.length, 1);
		assert.ok(sameReport.problems[0].includes(alias));
		assert.equal(readdirSync(join(root, "store", "attachments", uid, itemId)).length, 1);
		assert.equal(handle.sandbox.copies.size, 0);
		const [abandoned] = await settle([]);
		assert.equal(abandoned.id, a.screenshots[0].id);
		await ledger.internalReleaseAttachment(abandoned.id);
		assert.equal(rows()[0].state, "discarded");
		assert.equal(await bucket.size(abandoned.key), null);
	});
	await check("signed-in item links, scoped API link, and page-only GitHub comment", async () => {
		reset();
		const { screenshots } = await file();
		await settle(screenshots.map(s => s.id));
		const profile = { uid, email: null, demo: false };
		c.vars.profile = profile;
		c.conn!.params = { token: issueUserToken(profile, 0) };
		try {
			const [link] = await itemActions.itemAttachmentLinks(c, itemId);
			assert.ok(link.expiresAt > Date.now() + 590_000 && bucket.use(link.url, "GET").status === 200);
			const { createApiToken } = await import("../server/src/api-tokens.js");
			const read = await createApiToken(c.db, uid, { name: "read", scopes: ["items:read"] }, Date.now());
			const write = await createApiToken(c.db, uid, { name: "write", scopes: ["items:create"] }, Date.now());
			c.conn!.params = { token: issueServiceToken("api") };
			const ask = (token: string, attachment = screenshots[0].id) =>
				itemActions.internalApiItemAttachment(c, { id: itemId, attachment, token });
			await assert.rejects(
				() => ask(write.secret),
				(e: unknown) => (e as { code: string }).code === "missing_scope",
			);
			const url = await ask(read.secret);
			assert.ok(
				bucket.use(url, "GET").status === 200 &&
					Math.abs(Number(new URL(url).searchParams.get("expires")) - Date.now() - 60000) < 1000,
			);
			await assert.rejects(
				() => ask(read.secret, "a_0000000000000000"),
				(e: unknown) => (e as { code: string }).code === "item_not_found",
			);
			const verdict = {
				result: "pass",
				item: itemId,
				head: "a".repeat(40),
				flags: [],
				acceptance: [],
				ci: { state: "none" },
				said: { ci: "", flags: [] },
			} as unknown as import("../server/src/contract.js").Verdict;
			const blocks = reportBlocks({ title: "Report", lookAt: "", concerns: "", description: "Done", screenshots });
			assert.deepEqual(blocks[1], { kind: "screenshot", attachment: screenshots[0].id });
			const comment = itemComment(verdict, "Ready", {
				by: "builder",
				key,
				run: 1,
				sessionId,
				head: verdict.head,
				at: 0,
				title: "Report",
				screenshots,
				blocks,
				records: [],
			});
			assert.ok(
				comment.endsWith(
					`[View 1 screenshot on the work item](${config.origins[0]}/items/${itemId}) (opens for the item's owner only)`,
				) && !/!\[|wlp-stand-in|X-Amz-/.test(comment),
			);
		} finally {
			c.conn!.params = serviceParams();
		}
	});
	for (const [label, body] of [
		["outside", "outside"],
		["inside symlink", "not_regular"],
		["directory", "not_regular"],
		["oversize", Buffer.alloc(3 * 1024 * 1024)],
		["invalid PNG", Buffer.alloc(100)],
	] as const)
		await check("fake refuses " + label, async () => {
			reset();
			handle.sandbox.shots.set(name, body);
			const r = await file();
			assert.equal(r.screenshots.length, 0);
			assert.ok(r.problems[0].includes(name));
			assert.equal(handle.sandbox.copies.size, 0);
			assert.ok(rows().every(r => r.state === "discarded"));
		});
	await check("expired link returns 403, releases reservation, cleans copy", async () => {
		reset();
		const original = bucket.linkToPut.bind(bucket);
		const expired = new StandInObjectStore({ secret: signing, now: () => Date.now() - 600_000 });
		bucket.linkToPut = (...args) => expired.linkToPut(...args);
		try {
			const r = await file();
			assert.equal(r.screenshots.length, 0);
			assert.ok(r.problems[0].includes(name));
			assert.equal(rows()[0].state, "discarded");
			assert.equal(handle.sandbox.copies.size, 0);
		} finally {
			bucket.linkToPut = original;
		}
	});
	await check("missing stored object and malformed header both release their reservations", async () => {
		reset();
		const orig = bucket.size.bind(bucket);
		bucket.size = async () => null;
		try {
			const r = await file();
			assert.equal(r.screenshots.length, 0);
			assert.equal(rows()[0].state, "discarded");
		} finally {
			bucket.size = orig;
		}
	});
	const reserve = (n: number, bytes: number) =>
		ledger.internalReserveAttachment({ itemId, sessionId, key, sha256: digest(String(n)), bytes });
	await check("40 admitted, 41st file named and dropped, same item cannot consume more concurrently", async () => {
		reset();
		const results = await Promise.all(Array.from({ length: 40 }, (_, i) => reserve(i, 1)));
		assert.ok(results.every(r => "id" in r));
		const r = await file();
		assert.ok(r.problems[0].includes(name) && r.problems[0].includes("item"));
		assert.equal(r.screenshots.length, 0);
		let kept = false;
		const reply = await fileReport(
			{ title: "At capacity", screenshots: [raw] },
			{ text: s => s },
			report => {
				kept = report.title === "At capacity" && !report.screenshots.length;
			},
			file,
		);
		assert.ok(kept && reply.includes(name) && reply.includes("item has reached"));
		assert.deepEqual(await reserve(41, 1), { refused: "item" });
		assert.equal(alarms.size, 1);
	});
	await check("account at 1 GiB minus one byte refuses, including reservations on other items", async () => {
		reset();
		await reserve(1, 1);
		sql.prepare("UPDATE attachments SET item='other',bytes=?").run(1_073_741_823);
		assert.deepEqual(await reserve(2, 2), { refused: "account" });
		assert.ok("id" in (await reserve(3, 1)));
	});
	const sweep = async (at: number) => {
		const active = [...alarms][0];
		alarms.delete(active);
		c.scheduledFire = { id: active, scheduledAt: at, firedAt: at };
		await itemActions.internalAttachmentSweep(c);
		delete c.scheduledFire;
	};
	const day = 86_400_000;
	const cleanupDelay = 60_000 + 5 * 60_000;
	// Observe the signer directly. Exercise the object-store contract without exposing a URL in the check output.
	const signedFiling = async () => {
		let url = "";
		let ttlMs = 0;
		let expiresAt = 0;
		const sign = bucket.linkToPut.bind(bucket);
		bucket.linkToPut = async (key, options) => {
			const link = await sign(key, options);
			({ url, expiresAt } = link);
			ttlMs = options.ttlMs;
			return link;
		};
		try {
			const result = await file();
			assert.ok(url);
			const putAgain = (body: Buffer, now: number) => {
				const peer = new StandInObjectStore({ secret: signing, dir: join(root, "store"), now: () => now });
				return peer.use(url, "PUT", body, { "content-type": "image/png" }).status;
			};
			return { result, ttlMs, expiresAt, putAgain };
		} finally {
			bucket.linkToPut = sign;
		}
	};
	await check("screenshot PUT is signed for 60 seconds", async () => {
		reset();
		const { ttlMs, expiresAt, putAgain } = await signedFiling();
		assert.equal(ttlMs, 60_000);
		assert.equal(putAgain(one, expiresAt - 1), 200);
		assert.equal(putAgain(one, expiresAt), 403);
	});
	await check("sweep removes a re-PUT after discard and preserves a same-digest retry", async () => {
		reset();
		const bad = Buffer.alloc(one.length);
		handle.sandbox.shots.set(name, bad);
		const { result, expiresAt, putAgain } = await signedFiling();
		assert.equal(result.screenshots.length, 0);
		const [discarded] = rows();
		assert.equal(await bucket.size(discarded.key), null);
		assert.equal(putAgain(bad, expiresAt - 1), 200);
		await sweep(discarded.at + cleanupDelay - 1);
		assert.equal(rows()[0].state, "discarded");
		assert.equal(await bucket.size(discarded.key), bad.length);
		const retry = await ledger.internalReserveAttachment({
			itemId,
			sessionId,
			key,
			sha256: digest(bad),
			bytes: bad.length,
		});
		assert.ok("id" in retry && retry.id !== discarded.id);
		await sweep(discarded.at + cleanupDelay);
		assert.equal(await bucket.size(discarded.key), null);
		assert.equal(rows().find(r => r.id === discarded.id)?.state, "removed");
		assert.equal(rows().find(r => r.id === retry.id)?.state, "reserved");
	});
	await check("discarded bytes stay charged until a successful final deletion", async () => {
		reset();
		const limit = config.factory.attachments.accountBytes;
		const remove = bucket.remove.bind(bucket);
		config.factory.attachments.accountBytes = 10;
		try {
			const held = await reserve(1, 10);
			assert.ok("id" in held);
			bucket.remove = async () => {
				throw Error("offline");
			};
			await ledger.internalReleaseAttachment(held.id);
			assert.deepEqual(await reserve(2, 1), { refused: "account" });
			const due = rows()[0].at + cleanupDelay;
			await sweep(due);
			assert.equal(rows()[0].state, "discarded");
			assert.deepEqual(await reserve(2, 1), { refused: "account" });
			bucket.remove = remove;
			await sweep(due + 1);
			assert.ok("id" in (await reserve(2, 10)));
		} finally {
			bucket.remove = remove;
			config.factory.attachments.accountBytes = limit;
		}
	});
	await check(
		"retrying an unfinished reservation protects the newly issued PUT from the stale-reservation sweep",
		async () => {
			reset();
			const first = await ledger.internalReserveAttachment({
				itemId,
				sessionId,
				key,
				sha256: digest(one),
				bytes: one.length,
			});
			assert.ok("id" in first);
			sql.prepare("UPDATE attachments SET at=? WHERE id=?").run(Date.now() - 3 * 3600_000, first.id);
			const { result } = await signedFiling();
			assert.equal(result.screenshots[0]?.id, first.id);
			await sweep(Date.now());
			const [retried] = rows();
			assert.equal(retried.state, "reserved");
			assert.equal(await bucket.size(retried.key), one.length);
		},
	);
	await check("deleting an item keeps its recently signed key sweepable", async () => {
		reset();
		try {
			const { result, expiresAt, putAgain } = await signedFiling();
			await settle([result.screenshots[0].id]);
			await ledger.internalDeleteItemAttachments(itemId);
			const [discarded] = rows();
			assert.equal(discarded.state, "discarded");
			assert.equal(await bucket.size(discarded.key), null);
			assert.equal(putAgain(one, expiresAt - 1), 200);
			await sweep(discarded.at + cleanupDelay - 1);
			assert.equal(await bucket.size(discarded.key), one.length);
			await sweep(discarded.at + cleanupDelay);
			assert.equal(await bucket.size(discarded.key), null);
			assert.equal(rows()[0].state, "removed");
		} finally {
			state.items.set(itemId, summary);
		}
	});
	await check("3-hour reservation, 179/181-day ended item, owner-only links and deletion retry", async () => {
		reset();
		await file();
		let row = rows()[0];
		sql.prepare("UPDATE attachments SET at=?").run(Date.now() - 3 * 3600_000);
		await sweep(Date.now());
		assert.equal(await bucket.size(row.key), null);
		assert.equal(rows()[0].state, "removed");
		const filed = await file();
		row = rows().find(r => r.id === filed.screenshots[0].id)!;
		await settle([row.id]);
		const end = Date.now();
		await itemActions.internalItemChanged(c, { ...summary, state: "done", revision: 2, updatedAt: end });
		assert.deepEqual(await reserve(3, 1), { refused: "item_ended" });
		await sweep(end + 179 * day);
		assert.equal(rows().find(r => r.id === row.id)?.state, "kept");
		const profile = { uid, email: null, demo: false };
		c.conn!.params = { token: issueUserToken(profile, 0) };
		assert.equal((await itemActions.itemAttachmentLinks(c, itemId)).length, 1);
		c.conn!.params = { token: issueUserToken({ ...profile, uid: "other" }, 0) };
		await assert.rejects(async () => itemActions.itemAttachmentLinks(c, itemId));
		c.conn!.params = serviceParams();
		const remove = bucket.remove.bind(bucket);
		let deletes = 0;
		bucket.remove = async () => {
			deletes++;
			throw Error("offline");
		};
		try {
			await sweep(end + 181 * day);
			assert.equal(deletes, 1);
			assert.equal(rows().find(r => r.id === row.id)?.state, "kept");
		} finally {
			bucket.remove = remove;
		}
		await sweep(end + 181 * day + 1);
		assert.equal(await bucket.size(row.key), null);
		assert.equal(rows().find(r => r.id === row.id)?.state, "removed");
		c.conn!.params = { token: issueUserToken(profile, 0) };
		assert.equal((await itemActions.itemAttachmentLinks(c, itemId)).length, 0);
		c.conn!.params = serviceParams();
		state.items.set(itemId, summary);
		const again = await file();
		const fresh = rows().find(r => r.id === again.screenshots[0].id)!;
		await settle([fresh.id]);
		await ledger.internalDeleteItemAttachments(itemId);
		assert.equal(await bucket.size(fresh.key), null);
		assert.equal(rows().find(r => r.id === fresh.id)?.state, "discarded");
		await sweep(fresh.at + day);
		assert.equal(rows().find(r => r.id === fresh.id)?.state, "removed");
	});
	sql.close();
	await check("commit excludes new and previously staged screenshots", () => {
		const repo = join(root, "git");
		mkdirSync(repo);
		run("git", ["init", "--quiet", "-b", "work"], repo);
		run(
			"git",
			["-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-qm", "Base", "--allow-empty"],
			repo,
		);
		const baseSha = run("git", ["rev-parse", "HEAD"], repo);
		mkdirSync(join(repo, ".wlp-shots"));
		writeFileSync(join(repo, name), one);
		writeFileSync(join(repo, "normal"), "change");
		run("git", ["add", "--", name], repo);
		writeFileSync(join(repo, ".wlp-shots/new.png"), one);
		const sessionId = "r2-test-" + randomBytes(8).toString("hex");
		const handover = "/tmp/wlp-git-attempt-" + sessionId;
		try {
			run(
				"bash",
				[
					"-c",
					commitScript({
						sessionId,
						branch: "work",
						baseSha,
						pushed: null,
						author: { name: "test", email: "test@example.org" },
					}),
				],
				repo,
				"normal change\n",
			);
			assert.equal(
				run("git", ["--git-dir=" + join(handover, "repo"), "ls-tree", "-r", "--name-only", "HEAD"], repo),
				"normal",
			);
			assert.ok(existsSync(join(repo, name)));
		} finally {
			rmSync(handover, { recursive: true, force: true });
		}
	});
}
try {
	await cases();
} finally {
	rmSync(root, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
