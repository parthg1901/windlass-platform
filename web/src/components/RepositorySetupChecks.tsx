import { useEffect, useRef, useState } from "react";
import { offered } from "../../../server/src/factory/readiness-track";
import { readinessCriteria, readinessItem, type CriterionId } from "../../../server/src/factory/readiness";
import { absoluteTime, percent, plural } from "../lib/format";
import { linkProps } from "../lib/router";
import type { RepositoryPage } from "../screens/Repository";
import { useApp, useAuth } from "../state/app";
import { Select } from "./ui";

export function RepositorySetupChecks({ page, offersItems }: { page: RepositoryPage; offersItems: boolean }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState<"offer" | "run" | "notes" | "weekly" | "guides" | CriterionId | number | null>(null);
	const [error, setError] = useState("");
	const [filed, setFiled] = useState<Record<string, string>>({});
	const data = page.view?.readiness;
	const [paste, setPaste] = useState("");
	const [excluded, setExcluded] = useState<string[]>([]);
	const [answers, setAnswers] = useState<Record<string, "" | "keep" | "drop">>({});
	const upload = useRef<HTMLInputElement>(null);
	const { notes = [], publication } = page.view?.knowledge ?? {};
	const check = page.view?.guideCheck;
	const questions = notes.filter(n => n.decision?.question);
	const selected = notes.filter(n => !excluded.includes(n.id)).map(n => n.id);
	const selectedAnswers: Record<string, "keep" | "drop"> = {};
	for (const { id } of questions) {
		const answer = answers[id];
		if (answer && selected.includes(id)) selectedAnswers[id] = answer;
	}
	const report = data?.latest;
	const running = data?.run === "running";
	const reload = page.reload;
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		if (!running) return;
		const timer = window.setInterval(reload, 5000);
		return () => window.clearInterval(timer);
	}, [running, reload]);
	async function submit(action: NonNullable<typeof busy>, work: () => Promise<void>) {
		setBusy(action);
		setError("");
		try {
			await work();
		} catch (err) {
			setError(explain(err));
		} finally {
			setBusy(null);
		}
	}
	if (!data) return null;
	const disabled = busy !== null || page.access.state !== "usable";
	const checking = busy === "run" || running;
	const pending = report?.findings.filter(f => f.pass === null).length ?? 0;
	const ci = report?.ci;
	function fileButton(criterion: CriterionId | number, label: string) {
		if (!report || !offersItems) return null;
		const task = readinessItem(page.id, report, criterion);
		const key = task.idempotencyKey!;
		return filed[key] ? (
			<a className="link" {...linkProps({ name: "item", id: filed[key]! })}>
				Open work item
			</a>
		) : (
			<button
				className="link"
				type="button"
				disabled={disabled}
				onClick={() =>
					submit(criterion, async () => {
						const made = await client.user(auth).createItem(task);
						setFiled(old => ({ ...old, [key]: made.id }));
					})
				}
			>
				{busy === criterion ? "Filing…" : label}
			</button>
		);
	}
	return (
		<section id="repo-setup" className="usage-section ws-section repo-setup" aria-labelledby="setup-title">
			<header className="ws-list-head">
				<h2 id="setup-title" className="ws-section-title">
					Repo setup
				</h2>
				<button
					className="button button-outline button-small"
					type="button"
					disabled={disabled || running}
					onClick={() =>
						submit("run", async () => {
							const next = await client.user(auth).runReadiness(page.id, selected);
							if (mounted.current) page.replace(next);
						})
					}
				>
					{checking ? "Checking…" : data.run === "finished" ? "Run again" : "Finish setup"}
				</button>
			</header>
			{report && (
				<div className="setup-summary">
					<p>
						<strong>
							Setup {report.passed} of {readinessCriteria.length}
						</strong>
						{pending > 0 && ` · ${pending} pending`} · Level: <strong>{report.level}</strong>
					</p>
					<p>
						<strong>Track record:</strong> {report.record.verified} verified · {report.record.sentBack} sent back ·{" "}
						{plural(report.record.reverts, "revert")}
					</p>
					<p>{report.record.progress}</p>
					{offered(report.record, page.view!.defaults).map(offer => (
						<label key={offer} className="check setup-weekly">
							<input
								type="checkbox"
								role="switch"
								checked={false}
								disabled={disabled}
								onChange={() =>
									submit("offer", async () => {
										await client.user(auth).saveRepositoryDefaults(page.id, { offer });
										reload();
									})
								}
							/>
							{offer === "Small plans"
								? "This repo earned Small plans — turn on auto-approve for small plans?"
								: `This repo earned merge for ${offer} — turn on auto-merge for ${offer} items?`}
						</label>
					))}
					<details>
						<summary>Track record details</summary>
						<p>
							{report.record.firstTry} verified first try · {report.record.verified - report.record.firstTry} after
							fixes · {report.record.ciPassed} passed CI · {report.record.flaky} had a check fail on the base branch too
							· {report.record.merged} merged · {report.record.closed} closed without merging
							{data.builds &&
								` · ${data.builds.passed} of ${data.builds.total} recorded builds passed · setup succeeded in ${data.builds.setupPassed}`}
						</p>
					</details>
					<p>
						<strong>CI history (30 days):</strong>{" "}
						{ci ? (
							<>
								{ci.checked
									? `${percent(ci.green / ci.checked)} green on ${ci.branch}`
									: ci.hasCi
										? `No finished checks on ${ci.branch}`
										: "No CI to read"}
								{ci.hasCi && ` · ${plural(ci.flaky.length, "flaky job")}`}
								{!!ci.flaky.length && ": " + ci.flaky.map(job => `${job.name} (${job.count}×)`).join(", ")}
								{` · ${plural(ci.reverts, "revert")}`}
								{ci.redMerges > 0 && ` · ${plural(ci.redMerges, "red commit")} after a merge`}
							</>
						) : (
							"Could not read CI history from GitHub"
						)}
					</p>
					{ci && (
						<p className="usage-note">
							{data.ciReadFailed && "Could not refresh CI history from GitHub. "}Last read {absoluteTime(ci.at)}
						</p>
					)}
					{ci?.flaky.map((job, i) => (
						<div key={job.name}>{fileButton(i, "File as work item: fix intermittent failures in " + job.name)}</div>
					))}
				</div>
			)}
			<p className="usage-note">
				Draft contributor guides and skills from the repository and its latest build. A second reviewer checks the files
				before the pull request opens.
			</p>
			{check && (
				<label className="check setup-weekly">
					<input
						role="switch"
						type="checkbox"
						checked={check.enabled}
						disabled={disabled}
						onChange={e =>
							submit("guides", async () =>
								page.replace(await client.user(auth).setGuideCheck(page.id, e.target.checked)),
							)
						}
					/>{" "}
					Check pull requests for broken guide references
				</label>
			)}
			{publication && (
				<div className="setup-result">
					<a className="link" href={publication.pull.url} target="_blank" rel="noreferrer">
						Review guide changes in pull request #{publication.pull.number}
					</a>
					<p>
						{publication.files.join(" · ")} · {publication.pull.state}
					</p>
					{check?.result && (
						<p>
							<a className="link" href={check.result.url} target="_blank" rel="noreferrer">
								windlass/guides
							</a>{" "}
							· {check.result.conclusion === "failure" ? "Failed" : "Passed"} · {check.result.title}
						</p>
					)}
					{questions.map(n => {
						const text = n.text.trim().replace(/\s+/g, " ");
						return (
							<div key={n.id} className="setup-question">
								<strong>
									“{text.slice(0, 60)}
									{text.length > 60 && "…"}”
								</strong>{" "}
								{n.decision?.question}{" "}
								<Select<"" | "keep" | "drop">
									className="setup-answer"
									aria-label={`Decision on “${text.slice(0, 60)}”`}
									menuLabel="Decision"
									value={answers[n.id] ?? ""}
									onChange={next => setAnswers({ ...answers, [n.id]: next })}
									options={[
										{ value: "", label: "Leave out for now" },
										{ value: "keep", label: "Keep if verified" },
										{ value: "drop", label: "Drop" },
									]}
								/>
							</div>
						);
					})}
					{questions.length > 0 && (
						<button
							className="button button-outline button-small"
							disabled={disabled || checking || !Object.keys(selectedAnswers).length}
							onClick={() =>
								submit("run", async () => {
									page.replace(await client.user(auth).runReadiness(page.id, selected, selectedAnswers));
									setAnswers({});
								})
							}
						>
							Apply answers
						</button>
					)}
				</div>
			)}
			{data.diagnosis?.skills && (
				<details className="setup-result">
					<summary>Skill filings · {data.diagnosis.skills.kept} kept after review</summary>
					{!data.diagnosis.skills.filings.length && <p>No skill filing was received.</p>}
					{data.diagnosis.skills.filings.map((f, i) => (
						<div key={i}>
							<p>
								{f.phase === "draft" ? "Draft" : "Revision"} filing {i + 1} · {f.proposed} proposed ·{" "}
								{f.staticallyRejected.length} rejected by static checks · {f.smokeTested} smoke-tested ·{" "}
								{f.droppedBySmoke.length} failed smoke checks · {f.kept} kept
							</p>
							{f.refused && <p>Filing refused. {f.refused}</p>}
							{f.refusedLines?.map(r => (
								<p key={r.path + ":" + r.line}>
									<code>
										{r.path}:{r.line}
									</code>{" "}
									· {r.reason} <code>{r.text}</code>
								</p>
							))}
							{f.proposals
								? f.proposals.map((p, j) => (
										<div key={j}>
											<p>
												<strong>{p.path}</strong> · {p.outcome} · {p.reason}
											</p>
											{p.description && <p>{p.description}</p>}
											{p.body && <p>{p.body}</p>}
										</div>
									))
								: [...f.staticallyRejected, ...f.droppedBySmoke].map((drop, j) => (
										<p key={j}>
											{drop.path} · {drop.reason}
										</p>
									))}
						</div>
					))}
					{data.diagnosis.skills.filings.some(f => !f.proposals) &&
						data.diagnosis.skills.droppedByReview.map(drop => (
							<p key={drop.path}>
								{drop.path} · {drop.reason}
							</p>
						))}
				</details>
			)}
			{!!data.diagnosis?.leftOut?.length && (
				<div className="setup-result">
					<strong>Left out</strong>
					<ul>
						{data.diagnosis.leftOut.map(note => (
							<li key={note}>{note}</li>
						))}
					</ul>
				</div>
			)}
			<details className="setup-notes" open={!notes.length}>
				<summary>
					<strong>Notes from your agents{notes.length > 0 && ` (${notes.length})`}</strong>
				</summary>
				<div className="setup-note-fields">
					<textarea
						className="input textarea"
						aria-label="Add a note"
						id="setup-note"
						rows={3}
						value={paste}
						placeholder="Paste repository notes…"
						onChange={e => setPaste(e.target.value)}
					/>
					<div className="setup-actions">
						<button
							className="button button-outline button-small"
							disabled={disabled || !paste.trim()}
							onClick={() =>
								submit("notes", async () => {
									if (new Blob([paste]).size > 262144) throw Error("Use up to 256 KB of notes.");
									page.replace(
										await client.user(auth).addSetupNotes(page.id, [{ label: "Pasted note.md", text: paste }]),
									);
									setPaste("");
								})
							}
						>
							Add note
						</button>
						<button className="link" disabled={disabled} onClick={() => upload.current?.click()}>
							Upload files
						</button>
						<input
							hidden
							type="file"
							multiple
							accept=".md,.mdc"
							aria-label="Upload Markdown notes"
							ref={upload}
							onChange={e => {
								const files = Array.from(e.target.files ?? []);
								e.target.value = "";
								if (files.length)
									void submit("notes", async () => {
										if (files.length > 20 || files.reduce((n, f) => n + f.size, 0) > 262144)
											throw Error("Choose up to 20 Markdown files and 256 KB.");
										page.replace(
											await client
												.user(auth)
												.addSetupNotes(
													page.id,
													await Promise.all(files.map(async f => ({ label: f.name, text: await f.text() }))),
												),
										);
									});
							}}
						/>
					</div>
					<p className="usage-note">
						Only you can see saved notes. They are deleted after 30 days or when their pull request closes.
					</p>
					{notes.map(n => {
						const decision = n.decision;
						const lines = new Set(decision?.uses.map(u => u.path + ":" + u.line)).size;
						const details = [];
						if (lines) details.push(plural(lines, "line") + " used");
						if (decision?.question) details.push("1 question");
						if (decision && !details.length)
							details.push("Left out: " + (decision.verdict === "question" ? "needs an answer" : decision.verdict));
						return (
							<div className="setup-note-row" key={n.id}>
								<label className="check">
									<input
										type="checkbox"
										checked={!excluded.includes(n.id)}
										onChange={e =>
											setExcluded(e.target.checked ? excluded.filter(id => id !== n.id) : [...excluded, n.id])
										}
									/>
									{n.label}
								</label>
								<button
									className="link"
									disabled={busy !== null}
									onClick={() =>
										submit("notes", async () => page.replace(await client.user(auth).deleteSetupNote(page.id, n.id)))
									}
								>
									Delete
								</button>
								<details>
									<summary>{details.join(" · ") || "View note"}</summary>
									<p>{n.text}</p>
									{decision && (
										<>
											<p>
												{decision.reason} {decision.verdict === "secret" && "Replace this secret."}
											</p>
											{decision.question && <p>{decision.question}</p>}
											{decision.uses.map((u, i) => (
												<p key={i}>
													{u.path}:{u.line} · {u.evidence}
												</p>
											))}
										</>
									)}
								</details>
							</div>
						);
					})}
				</div>
			</details>
			<label className="check setup-weekly">
				<input
					role="switch"
					type="checkbox"
					checked={data.weekly}
					disabled={busy !== null || (!data.weekly && page.access.state !== "usable")}
					onChange={event =>
						submit("weekly", async () => {
							await client.user(auth).setSetupWeekly(page.id, event.target.checked);
							if (mounted.current) reload();
						})
					}
				/>{" "}
				Run setup checks weekly
			</label>
			{report ? (
				<>
					<div className="readiness-group">
						<ul>
							{readinessCriteria.map(c => {
								const row = report.findings.find(f => f.id === c.id)!;
								return (
									<li key={c.id}>
										<span className={row.pass === false ? "tone-warn" : "tone-dim"}>
											{row.pass === null ? "Pending" : row.pass ? "Pass" : "Fail"}
										</span>
										<div>
											<strong>{c.title}</strong>
											<p>{row.reason}</p>
										</div>
										{row.pass === false && fileButton(c.id, "File as work item")}
									</li>
								);
							})}
						</ul>
					</div>
				</>
			) : (
				<p className="usage-empty">
					{page.access.state === "usable"
						? "Waiting for the default branch checks."
						: "Connect this repository to see its setup checks."}
				</p>
			)}
			{(error || data.error) && (
				<p role="alert" className="usage-note">
					{error || data.error}
				</p>
			)}
		</section>
	);
}
