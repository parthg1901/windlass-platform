/**
 * Subscription plans a user connects and the connect command's wire. No imports: the CLI (`cli/`) bundles this
 * module on its own, so it stays dependency-free and browser-safe.
 */

/**
 * Subscription plans a user can connect, by the provider that serves them. The ChatGPT plan is the user's ChatGPT
 * sign-in (Windlass's own login), the one Windlass's unqualified models already run on.
 */
export const PLAN_PROVIDERS = ["anthropic", "openai"] as const;
export type PlanProvider = (typeof PLAN_PROVIDERS)[number];
export const PLAN_NAMES: Record<PlanProvider, string> = { anthropic: "Claude plan", openai: "ChatGPT plan" };

export function isPlanProvider(value: unknown): value is PlanProvider {
	return (PLAN_PROVIDERS as readonly unknown[]).includes(value);
}

/** A Claude plan is connected with the long-lived token `claude setup-token` prints. A ChatGPT plan has no such token: it is a sign-in. */
const PLAN_TOKEN_SHAPES: Partial<Record<PlanProvider, RegExp>> = { anthropic: /^sk-ant-oat01-[A-Za-z0-9_-]{20,400}$/ };

export function validPlanToken(provider: PlanProvider, token: unknown): token is string {
	return typeof token === "string" && (PLAN_TOKEN_SHAPES[provider]?.test(token) ?? false);
}

/**
 * The files of a ChatGPT sign-in, by their names in Windlass's data directory (`$XDG_DATA_HOME/windlass`):
 * server/src/signin/material.ts says what each holds. No other name is ever written, read back or uploaded.
 */
export const MATERIAL_FILES = ["auth.json", "host-id", "auth-pending.json"] as const;
export type MaterialFile = (typeof MATERIAL_FILES)[number];
/** More than any of these files holds by far (an `auth.json` is a few kilobytes): what is larger is not one. */
export const MAX_MATERIAL_FILE_BYTES = 64 * 1024;

/** What `connect codex` uploads of the sign-in Windlass saved on the user's computer: the finished sign-in, never a pending one. */
export const SIGN_IN_UPLOAD_FILES = ["auth.json", "host-id"] as const satisfies readonly MaterialFile[];
export interface SignInUpload {
	files: Partial<Record<(typeof SIGN_IN_UPLOAD_FILES)[number], string>>;
}

/**
 * The Windlass `connect codex` signs in with on the user's computer (`npx windlass-agent@<this> login`): the release
 * the platform runs (sandbox/fetch-windlass.sh `RELEASE`), so the files it saves are the ones the platform refreshes.
 */
export const SIGN_IN_WINDLASS_VERSION = "0.7.1";

/** Whether `value` is an upload's shape: only upload files, `auth.json` among them, each text of a sane size. */
export function validSignInUpload(value: unknown): value is SignInUpload {
	const files = (value as { files?: unknown } | null)?.files;
	if (typeof files !== "object" || files === null || Array.isArray(files)) return false;
	const entries = Object.entries(files);
	if (!entries.some(([name]) => name === "auth.json")) return false;
	return entries.every(
		([name, text]) =>
			(SIGN_IN_UPLOAD_FILES as readonly string[]).includes(name) &&
			typeof text === "string" &&
			new TextEncoder().encode(text).length <= MAX_MATERIAL_FILE_BYTES,
	);
}

/**
 * The connect command (`npx @windlassai/cli connect claude|codex`) over HTTP, without signing in: `start` opens a
 * request and answers `ConnectStart`; the user approves its code on the web page (`/connect?code=&plan=`); `poll`
 * answers `{ state }`; then the terminal posts to `connect` once, answered `{ account }`: `{ request, token }` for
 * a Claude plan, `{ request, signIn }` (a `SignInUpload`) for a ChatGPT plan.
 */
export const CONNECT_PATHS = {
	start: "/platform/connect/start",
	poll: "/platform/connect/poll",
	connect: "/platform/connect",
} as const;

export type ConnectRequestState = "pending" | "approved" | "denied" | "expired";

export interface ConnectStart {
	/** What the terminal shows and the page asks the user to compare, like KQ2M-8XF4. */
	userCode: string;
	/** The web page that approves it, with the code in its query. */
	approveUrl: string;
	/** The terminal's secret: it polls with it and hands the token over with it. Never shown. */
	request: string;
	expiresAt: number;
	/** How often to poll, in milliseconds. */
	interval: number;
}
