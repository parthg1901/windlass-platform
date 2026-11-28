/**
 * `GET /install.sh`: the one-line install of a machine, `curl -fsSL <platform>/install.sh | sh`
 * (docs/machines.md). A short POSIX sh script with this platform's address and its pinned runner
 * image put in. It checks that Docker is there and answers, pulls the image and runs the runner's
 * setup in a one-off container on the terminal. It writes nothing on the host outside Docker and
 * never asks for sudo. Without a terminal it prints the setup command instead.
 */
import { config } from "./config.js";
import { DOCKER_HELP, setupRunArgs } from "./contract/machine-setup.js";

export const INSTALL_SCRIPT_PATH = "/install.sh";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const word = (value: string) => (/^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : quote(value));
const fail = (message: string) => `fail ${quote(message)}`;
const { missing, stopped } = DOCKER_HELP;

/** The setup's `docker run`, from the definition the CLI shares, with the script's variables in place of the image and address. */
function setupCommand(platform: string, image: string): string {
	const args = setupRunArgs(image, platform, "terminal").map(arg =>
		arg === image ? '"$IMAGE"' : arg === platform ? '"$PLATFORM"' : word(arg),
	);
	return ["docker", ...args].join(" ");
}

/** The script for this platform address and runner image (both checked by config.ts: an origin, an image pinned by digest). */
export function installScript(platform: string, image: string): string {
	return `#!/bin/sh
# Installs the Windlass runner on this machine for ${platform}.
# It needs Docker, and runs the runner's setup in a one-off container. It changes
# nothing else here: no sudo, no files outside Docker. Read it before you run it:
#   curl -fsSL ${platform}/install.sh
set -eu

PLATFORM=${quote(platform)}
IMAGE=${quote(image)}

say() { printf '%s\\n' "$*"; }
fail() { printf 'windlass: %s\\n' "$*" >&2; exit 1; }
# Under curl | sh standard input is this script: questions are asked on the terminal.
has_terminal() { (: </dev/tty) 2>/dev/null; }

os=$(uname -s 2>/dev/null || echo unknown)
wsl=false
case "$os" in
  Linux) if grep -qi microsoft /proc/version 2>/dev/null; then wsl=true; fi ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  case "$os" in
    Darwin) ${fail(missing.darwin)} ;;
    Linux)
      if [ "$wsl" = true ]; then ${fail(missing.wsl)}; fi
      ${fail(missing.linux)} ;;
    MINGW*|MSYS*|CYGWIN*) ${fail(missing["windows-shell"])} ;;
    *) ${fail(missing.other)} ;;
  esac
fi

if ! problem=$(docker info --format '{{.ServerVersion}}' 2>&1 >/dev/null); then
  case "$problem" in
    *"permission denied"*) ${fail(DOCKER_HELP.denied)} ;;
  esac
  case "$os" in
    Darwin) ${fail(stopped.darwin)} ;;
    Linux)
      if [ "$wsl" = true ]; then ${fail(stopped.wsl)}; fi
      ${fail(stopped.linux)} ;;
    *) ${fail(stopped.other)} ;;
  esac
fi

say "Fetching the Windlass runner..."
docker pull "$IMAGE" || ${fail(DOCKER_HELP.pull(image))}

# Docker keeps no log of this container: the setup's sign-ins happen in it.
set -- ${setupCommand(platform, image)}

if has_terminal; then
  exec "$@" </dev/tty
fi
say "There is no terminal here to answer the setup's questions. Run this in a terminal on this machine:"
say ""
say "  $*"
`;
}

const headers = {
	"content-type": "text/plain; charset=utf-8",
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
};

/** The script, or a script that says why there is none; 404 where this platform takes no machines. */
export function installScriptResponse(request: Request): Response {
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response("Method not allowed\n", { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
	const machines = config.machines;
	if (!machines) return new Response("Not found\n", { status: 404, headers });
	const body = machines.runnerImage
		? installScript(machines.publicUrl, machines.runnerImage)
		: "#!/bin/sh\necho 'windlass: this platform has not published a runner yet, so there is nothing to install.' >&2\nexit 1\n";
	return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}
