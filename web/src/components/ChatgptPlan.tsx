import { useState } from "react";
import { useApp, useAuth } from "../state/app";
import { PROVIDERS_CHANGED, useChatgpt } from "../state/hooks";
import { PlanRow, usePlanConnect } from "./PlanConnect";

/**
 * The ChatGPT plan row, for any signed-in user: the command that, on the user's own computer, asks them to approve its
 * code here and then signs in with ChatGPT through Windlass, handing the sign-in to the platform. Where plans are on
 * (`allowed`, WLP_PLAN_USERS) the sign-in also pays for hosted Codex.
 */
export function ChatgptPlan() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const { status, error: statusError } = useChatgpt();
	const { allowed, loaded, error: plansError, plan, setPlan, waiting, wait, cancel } = usePlanConnect("openai", status);
	const [busy, setBusy] = useState(false);
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function connect() {
		setError(null);
		wait();
	}

	async function checkAgain() {
		setChecking(true);
		setError(null);
		try {
			setPlan(await client.user(auth).recheckModelPlan("openai"));
			window.dispatchEvent(new Event(PROVIDERS_CHANGED));
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setChecking(false);
		}
	}

	async function disconnect() {
		setBusy(true);
		setError(null);
		try {
			await client.user(auth).forgetChatgpt();
			setPlan(null);
			window.dispatchEvent(new Event(PROVIDERS_CHANGED));
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(false);
		}
	}

	const connected = Boolean(status?.connected);
	const account = plan?.account ?? status?.email;
	return (
		<PlanRow
			provider="openai"
			className="chatgpt-plan"
			dataProvider="chatgpt"
			title="ChatGPT plan"
			line={
				connected ? (account ? `Connected as ${account}` : "Connected") : "Use your ChatGPT Plus, Pro or Business plan"
			}
			extra={
				connected && allowed ? (
					<p className="plan-row-line chatgpt-plan-codex">
						<span>
							Also pays for hosted Codex
							{plan?.models?.length ? ` · ${plan.models.length} models` : " · agent default until its models are read"}
						</span>
						<button
							type="button"
							className="button button-quiet button-small"
							disabled={checking}
							onClick={() => void checkAgain()}
						>
							{checking ? "Checking…" : "Check again"}
						</button>
					</p>
				) : null
			}
			connected={connected}
			plan={plan}
			waiting={waiting}
			busy={busy}
			error={error || statusError || plansError || null}
			loading={(status === null && !statusError) || (!loaded && !plansError)}
			onConnect={connect}
			onCancel={cancel}
			onDisconnect={() => void disconnect()}
		/>
	);
}
