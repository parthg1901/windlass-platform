// Bundles the CLI into one file with no runtime dependencies: `dist/windlassai.mjs`, the package's bin.
import { build } from "esbuild";

await build({
	entryPoints: [new URL("src/main.ts", import.meta.url).pathname],
	outfile: new URL("dist/windlassai.mjs", import.meta.url).pathname,
	bundle: true,
	platform: "node",
	target: "node18",
	format: "esm",
	banner: { js: "#!/usr/bin/env node" },
	sourcemap: false,
});
