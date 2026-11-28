import { useState } from "react";
import { useApp, useAuth } from "../state/app";
import { PROVIDERS_CHANGED } from "../state/hooks";
import { PlanRow, usePlanConnect } from "./PlanConnect";

/**
 * The Claude plan row: the command that, on the user's own computer, asks them to approve its code here and then
 * hands the token `claude setup-token` prints to the platform. After Connect the row watches for the plan to arrive.
 */
export function ClaudePlan() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const { allowed, plan, setPlan, waiting, wait, cancel } = usePlanConnect("anthropic");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!allowed) return null;

	function connect() {
		setError(null);
		wait();
	}

	async function disconnect() {
		setBusy(true);
		setError(null);
		try {
			await client.user(auth).removeModelPlan("anthropic");
			setPlan(null);
			window.dispatchEvent(new Event(PROVIDERS_CHANGED));
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(false);
		}
	}

	const connected = plan?.ok === true;
	return (
		<PlanRow
			provider="anthropic"
			className="claude-plan"
			dataProvider="claude-plan"
			title="Claude plan"
			line={connected ? `Connected as ${plan.account ?? "your Claude account"}` : "Use your Claude Pro or Max plan"}
			connected={connected}
			plan={plan}
			waiting={waiting}
			busy={busy}
			error={error}
			onConnect={connect}
			onCancel={cancel}
			onDisconnect={() => void disconnect()}
		/>
	);
}
