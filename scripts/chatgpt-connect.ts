import { CONNECT_PATHS, type SignInUpload } from "../server/src/contract.js";

/** The user's own actor, as far as approving a connect code goes. */
interface Approver {
	approvePlanConnect(userCode: string, provider: "openai"): Promise<void>;
}

/**
 * Connects a ChatGPT plan the way `npx @windlassai/cli connect codex` does (cli/src/connect.ts): start a request,
 * approve its code as the signed-in user, then hand over the sign-in's files. Answers the connect route's `account`.
 */
export async function connectChatgpt(api: string, user: Approver, signIn: SignInUpload): Promise<string | null> {
	const post = async (path: string, body: unknown) => {
		const response = await fetch(api + path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		if (!response.ok)
			throw Object.assign(new Error(`${path} answered ${response.status} ${String(answer.code ?? "")}`), {
				code: answer.code,
			});
		return answer;
	};
	const started = (await post(CONNECT_PATHS.start, { provider: "openai" })) as { userCode: string; request: string };
	await user.approvePlanConnect(started.userCode, "openai");
	const connected = await post(CONNECT_PATHS.connect, { request: started.request, signIn });
	return typeof connected.account === "string" ? connected.account : null;
}
