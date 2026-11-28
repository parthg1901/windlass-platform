/**
 * Windlass in the Docker sandboxes. The turn itself is turn.ts, which knows no provider; here is what
 * is Docker's: where the image's Windlass is looked at, and what a turn's process is on this provider:
 *
 *   docker exec -i -w /workspace -e WINDLASS_WAKE=off -e WINDLASS_ACP_LOG=warn \
 *     -e WINDLASS_ACP_SCRIPT=/tmp/.wlp-script-<random>.json                     a scripted (demo) turn
 *     wlp-session-<id> wlp-run exec <tag> windlass acp
 *
 * Any other turn pays with a Settings key or a plan through a relay (token-file.ts). The server checks the image
 * version at startup.
 */

import { IMAGE } from "./docker.js";
import { windlassVersionProblem } from "../startup.js";
import { probeImage } from "./tokens.js";
import { SandboxWindlass, type TurnOptions, type WindlassHost } from "./turn.js";

export { START_TIMEOUT_MS } from "./turn.js";

export interface DockerWindlassOptions extends TurnOptions {
	/** The image whose Windlass `version()` and `problem()` are about. Default the server's. */
	image?: string;
}

/** The Windlass of a Docker image: sandboxes are made from it. */
export function dockerWindlassHost(image: string = IMAGE): WindlassHost {
	return {
		version: () => probeImage(image),
		problem: async () => windlassVersionProblem(await probeImage(image), "sandbox image " + image),
	};
}

export class DockerWindlass extends SandboxWindlass {
	constructor(options: DockerWindlassOptions = {}) {
		super(dockerWindlassHost(options.image ?? IMAGE), options);
	}
}
