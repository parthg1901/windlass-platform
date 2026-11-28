/**
 * A repository's prepared environments, on its Saved settings (server/src/environments.ts): one row per place with
 * its state, when it was built and validated, how each saved check ended, the failing check's output when a build
 * failed, and Rebuild; and how often they are rebuilt. Read when shown, and again every few seconds while one builds.
 */
import {
	ENVIRONMENT_SCHEDULES,
	type EnvironmentBuild,
	type EnvironmentSchedule,
	type GithubId,
	type RepositoryEnvironment,
	type RepositoryEnvironments,
} from "@contract";
import { useCallback, useEffect, useId, useState } from "react";
import { absoluteTime, relativeTime } from "../lib/format";
import { useApp, useAuth } from "../state/app";
import { useNow } from "../state/hooks";
import { WarnIcon } from "./Icons";
import { Button } from "./ui/Button";
import { Loading, Select, SkeletonLines } from "./ui";

const SCHEDULE_WORDS: Record<EnvironmentSchedule, string> = {
	24: "Nightly",
	12: "Every 12 hours",
	6: "Every 6 hours",
	0: "Off",
};
const STATE_WORDS: Record<RepositoryEnvironment["state"], string> = {
	ready: "Ready",
	building: "Building",
	retrying: "Build interrupted — trying again",
	interrupted: "Build interrupted after two retries",
	failed: "Failed",
	stale: "Stale",
};
const DOT: Record<RepositoryEnvironment["state"], string> = {
	ready: "ok",
	building: "changed",
	retrying: "off",
	interrupted: "warn",
	failed: "warn",
	stale: "off",
};
const TRIGGER_WORDS: Record<EnvironmentBuild["trigger"], string> = {
	schedule: "on its schedule",
	push: "after a push",
	rebuild: "on Rebuild",
	change: "after a settings change",
	first_use: "for a first session",
	image: "after an image change",
};
const KIND_WORDS: Record<NonNullable<EnvironmentBuild["failure"]>["kind"], string> = {
	package_manager: "Environment problem: the image's package manager is not the one the repository pins",
	network: "Environment problem: a tool could not be fetched over the network",
	not_found: "Environment problem: the command was not found in the image",
	code: "The check failed on the base commit's code",
	setup: "The setup command failed",
	clone: "The repository could not be cloned",
	save: "The checks passed, but the prepared sandbox could not be kept there",
};

function checkWord(status: EnvironmentBuild["checks"][number]["status"]): string {
	return status === "passed"
		? "passed"
		: status === "timed_out"
			? "timed out"
			: status === "could_not_start"
				? "could not start"
				: status === "interrupted"
					? "stopped"
					: "failed";
}

function Checks({ build }: { build: EnvironmentBuild }) {
	if (!build.checks.length) return null;
	return (
		<ul className="env-checks">
			{build.checks.map(check => (
				<li key={check.name} className={`env-check env-check-${check.status === "passed" ? "ok" : "bad"}`}>
					<span className="env-check-name">{check.name}</span>
					<span className="env-check-status">
						{checkWord(check.status)}
						{check.environment ? " · environment" : check.status === "failed" ? " · code" : ""}
						{check.durationMs >= 1000 ? ` · ${Math.round(check.durationMs / 1000)}s` : ""}
					</span>
				</li>
			))}
		</ul>
	);
}

export function EnvironmentRow({
	env,
	now,
	busy,
	onRebuild,
}: {
	env: RepositoryEnvironment;
	now: number;
	busy: boolean;
	onRebuild(): void;
}) {
	const failure = env.state === "failed" ? (env.attempt?.failure ?? null) : null;
	const ready = env.ready;
	const validated = ready ? (ready.finishedAt ?? ready.startedAt) : null;
	return (
		<li className="env-row">
			<div className="env-head">
				<span className={`ui-dot ui-dot-${DOT[env.state]}`} aria-hidden="true" />
				<span className="env-place">{env.placeName}</span>
				<span className={`env-state env-state-${env.state}`}>
					{STATE_WORDS[env.state]}
					{env.state === "ready" && ready?.codeFailures?.length ? (
						<span className="env-red"> · main's checks fail: {ready.codeFailures.join(", ")}</span>
					) : null}
				</span>
				<Button size="sm" className="env-rebuild" disabled={busy || env.state === "building"} onClick={onRebuild}>
					Rebuild
				</Button>
			</div>
			<p className="env-meta">
				{env.state === "building" && env.attempt ? (
					<>
						Started {relativeTime(env.attempt.startedAt, now)} {TRIGGER_WORDS[env.attempt.trigger]}.{" "}
					</>
				) : null}
				{ready && validated !== null ? (
					<>
						{env.state === "ready" ? "Validated" : "Last validated"}{" "}
						<time dateTime={new Date(validated).toISOString()} title={absoluteTime(validated)}>
							{relativeTime(validated, now)}
						</time>
						{ready.commit ? (
							<>
								{" "}
								at <code>{ready.commit.slice(0, 10)}</code>
							</>
						) : null}
						{` · built ${TRIGGER_WORDS[ready.trigger]}`}
						{ready.snapshot ? null : " · setup is quick, so sessions start cold"}
					</>
				) : env.state !== "building" && !failure ? (
					"Never validated: sessions here start cold."
				) : null}
			</p>
			{env.note ? <p className="env-note">{env.note}</p> : null}
			{failure && env.attempt ? (
				<div className="env-failure" role="group" aria-label="Last build">
					<p className="env-failure-title">
						<WarnIcon size={14} />
						<span>
							{KIND_WORDS[failure.kind]}
							{failure.check ? (
								<>
									{" "}
									(<code>{failure.check}</code>)
								</>
							) : null}
							. Built {relativeTime(env.attempt.startedAt, now)} {TRIGGER_WORDS[env.attempt.trigger]}
							{ready ? "; sessions still start from the last validated environment." : "; sessions here start cold."}
						</span>
					</p>
					{failure.line ? (
						<p className="env-failure-line">
							<code>{failure.line}</code>
						</p>
					) : null}
					<Checks build={env.attempt} />
					{failure.excerpt ? (
						<details className="env-output">
							<summary>Output</summary>
							<pre className="output-text">{failure.excerpt}</pre>
						</details>
					) : null}
				</div>
			) : ready && env.state !== "building" ? (
				<Checks build={ready} />
			) : null}
		</li>
	);
}

export function EnvironmentSection({ repositoryId, labelledBy }: { repositoryId: GithubId; labelledBy: string }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const now = useNow(30_000);
	const scheduleId = useId();
	const [view, setView] = useState<RepositoryEnvironments | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [said, setSaid] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

	const load = useCallback(async () => {
		try {
			setView(await client.user(auth).repositoryEnvironments(repositoryId));
			setError(null);
		} catch (failure) {
			setError(explain(failure));
		}
	}, [client, auth, repositoryId, explain]);
	useEffect(() => {
		void load();
	}, [load]);
	const building = view?.environments.some(e => e.state === "building") ?? false;
	const polling = building || view?.environments.some(e => e.state === "retrying");
	useEffect(() => {
		if (!polling) return;
		const timer = setInterval(() => void load(), 3000);
		return () => clearInterval(timer);
	}, [polling, load]);

	const act = async (work: () => Promise<RepositoryEnvironments>, done: string) => {
		setBusy(true);
		setSaid(null);
		try {
			setView(await work());
			setSaid({ tone: "good", text: done });
		} catch (failure) {
			setSaid({ tone: "bad", text: explain(failure) });
		} finally {
			setBusy(false);
		}
	};
	const user = client.user(auth);

	if (error)
		return (
			<p className="field-note tone-bad" role="alert">
				{error}
			</p>
		);
	if (!view)
		return (
			<Loading label="Loading the environments">
				<SkeletonLines title={false} />
			</Loading>
		);
	return (
		<div className="repo-form" aria-labelledby={labelledBy}>
			{!view.available ? (
				<p className="env-note">{view.unavailableReason}</p>
			) : (
				<>
					<div className="env-controls">
						<label className="env-schedule" htmlFor={scheduleId}>
							<span>Rebuild</span>
							<Select<string>
								id={scheduleId}
								menuLabel="Rebuild"
								value={String(view.schedule)}
								disabled={busy}
								onChange={next =>
									void act(
										() => user.saveEnvironmentSchedule(repositoryId, Number(next) as EnvironmentSchedule),
										"Saved.",
									)
								}
								options={ENVIRONMENT_SCHEDULES.map(hours => ({
									value: String(hours),
									label: `${SCHEDULE_WORDS[hours]}${!view.scheduleChosen && hours === view.schedule ? " (default)" : ""}`,
								}))}
							/>
						</label>
						<span className="env-also">and after a push to the default branch</span>
						{view.environments.length > 1 ? (
							<Button
								size="sm"
								disabled={busy || building}
								onClick={() => void act(() => user.rebuildEnvironment(repositoryId), "Rebuilding.")}
							>
								Rebuild all
							</Button>
						) : null}
					</div>
					{view.environments.length ? (
						<ul className="env-rows">
							{view.environments.map(env => (
								<EnvironmentRow
									key={env.place}
									env={env}
									now={now}
									busy={busy}
									onRebuild={() => void act(() => user.rebuildEnvironment(repositoryId, env.place), "Rebuilding.")}
								/>
							))}
						</ul>
					) : (
						<p className="env-note">
							No environment yet. One is built where this repository's agents and work items run, after the first of
							them starts there.
						</p>
					)}
					{view.places.length ? (
						<p className="env-places">
							Build one on{" "}
							{view.places.map((place, index) => (
								<span key={place.place}>
									{index > 0 ? ", " : null}
									<button
										type="button"
										className="link"
										disabled={busy}
										onClick={() => void act(() => user.rebuildEnvironment(repositoryId, place.place), "Building.")}
									>
										{place.placeName}
									</button>
								</span>
							))}
						</p>
					) : null}
				</>
			)}
			{said ? (
				<p className={`field-note tone-${said.tone}`} role={said.tone === "bad" ? "alert" : "status"}>
					{said.text}
				</p>
			) : null}
		</div>
	);
}
