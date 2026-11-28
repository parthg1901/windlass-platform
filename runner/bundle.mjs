import { copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const [pin, outfile, ...pins] = process.argv.slice(2);
const imagePin = /^([a-z0-9][a-z0-9./:_-]*@)?sha256:[0-9a-f]{64}$/;
const shotsPin = pins[0] && imagePin.test(pins[0]) ? pins.shift() : undefined;
if (!outfile || !imagePin.test(pin))
	throw new Error("Pass an immutable sandbox image digest and the bundle output path.");
const harnessImages = {};
for (const entry of pins) {
	const [id, image, extra] = entry.split("=");
	if (!["claude", "opencode", "codex"].includes(id) || !imagePin.test(image) || extra !== undefined)
		throw new Error("Pass a harness image as <harness>=<immutable image digest>.");
	harnessImages[id] = image;
}
const relay = await build({
	entryPoints: [fileURLToPath(new URL("../sandbox/relay/opencode.cjs", import.meta.url))],
	bundle: true,
	platform: "node",
	format: "cjs",
	write: false,
});
const windlassRelay = await build({
	entryPoints: [fileURLToPath(new URL("../sandbox/relay/windlass.cjs", import.meta.url))],
	bundle: true,
	platform: "node",
	format: "cjs",
	write: false,
});
const claudeRelay = await build({
	entryPoints: [fileURLToPath(new URL("../sandbox/relay/server.cjs", import.meta.url))],
	bundle: true,
	platform: "node",
	format: "cjs",
	write: false,
});
// These two public sandbox conventions also occur in the shared server implementation.
// Ship them as explicit image configuration, so the executable scan can reject any host
// home path or secret marker without an exception for arbitrary strings in the bundle.
const layout = { dataDirectory: "/home/agent/.local/share/windlass", secretAlias: "WLP_SECRET_" };
const sandboxLayout = {
	name: "sandbox-layout",
	setup(builder) {
		builder.onLoad({ filter: /[/\\]server[/\\]src[/\\]sandbox[/\\](provider|sandboxes)\.ts$/ }, async ({ path }) => {
			const text = await readFile(path, "utf8");
			const [variable, key] = path.endsWith("provider.ts")
				? ["DATA_DIR", "dataDirectory"]
				: ["SECRET_ALIAS", "secretAlias"];
			const declaration = `const ${variable} = ${JSON.stringify(layout[key])};`;
			if (!text.includes(declaration)) throw new Error(`Review the runner layout after changing ${variable}.`);
			return {
				contents: text.replace(declaration, `const ${variable} = require("./sandbox-layout.json").${key};`),
				loader: "ts",
			};
		});
	},
};
await writeFile(join(dirname(outfile), "sandbox-layout.json"), JSON.stringify(layout));
await build({
	entryPoints: [fileURLToPath(new URL("src/main.ts", import.meta.url))],
	outfile,
	plugins: [sandboxLayout],
	external: ["./sandbox-layout.json"],
	sourcemap: false,
	banner: { js: "#!/usr/bin/env node" },
	bundle: true,
	platform: "node",
	target: "node22",
	format: "cjs",
	define: {
		PRIVATE_GIT_SOURCE: JSON.stringify(
			await readFile(new URL("../server/src/github/private-git.py", import.meta.url), "utf8"),
		),
		EGRESS_SOURCE: JSON.stringify(await readFile(new URL("src/egress-proxy.mjs", import.meta.url), "utf8")),
		"import.meta.dirname": "__dirname",
		BUNDLED_SECCOMP_FILE: JSON.stringify("seccomp-bwrap.json"),
		SANDBOX_IMAGE: JSON.stringify(pin),
		SHOTS_IMAGE_PIN: JSON.stringify(shotsPin ?? ""),
		HARNESS_IMAGES: JSON.stringify(harnessImages),
		WINDLASS_RELAY_SCRIPT: JSON.stringify(windlassRelay.outputFiles[0].text),
		// The plan relay's modules as the loader reads them (server/src/sandbox/plan-relay.ts `planRelaySources`).
		PLAN_RELAY_SOURCES: JSON.stringify(
			JSON.stringify(
				Object.fromEntries(
					await Promise.all(
						["server.cjs", "wires.cjs", "windlass.cjs", "plan.cjs"].map(async name => [
							name,
							await readFile(new URL(`../sandbox/relay/${name}`, import.meta.url), "utf8"),
						]),
					),
				),
			),
		),
		OPENCODE_RELAY_SCRIPT: JSON.stringify(relay.outputFiles[0].text),
		CLAUDE_RELAY_SCRIPT: JSON.stringify(claudeRelay.outputFiles[0].text),
	},
});
await copyFile(new URL("../sandbox/seccomp-bwrap.json", import.meta.url), join(dirname(outfile), "seccomp-bwrap.json"));
await copyFile(
	new URL("../sandbox/seccomp-bwrap.LICENSE", import.meta.url),
	join(dirname(outfile), "seccomp-bwrap.LICENSE"),
);
