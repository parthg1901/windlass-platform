import type { LoginProvider } from "@contract";
import { useEffect, useRef, useState } from "react";
import { InfoIcon, Mark, WarnIcon } from "../components/Icons";
import { ThemeToggle, Wordmark } from "../components/TopBar";
import { linkProps, navigate, takeReturnAfterSignIn } from "../lib/router";
import type { Theme } from "../lib/theme";
import { useApp, useAuth } from "../state/app";

export function SignIn({ theme, onToggleTheme }: { theme: Theme; onToggleTheme(): void }) {
	const { client, signIn, signedOutReason, platform, explain } = useApp();
	const [busy, setBusy] = useState<LoginProvider | "finish" | "demo" | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const url = new URL(location.href);
		if (!url.searchParams.has("code") && !url.searchParams.has("error")) return;
		history.replaceState(history.state, "", url.pathname);
		setBusy("finish");
		client.login
			.finish(url.href)
			.then(signIn)
			.catch(failure => setError(explain(failure)))
			.finally(() => setBusy(null));
	}, [client, explain, signIn]);

	const start = async (provider: LoginProvider) => {
		setBusy(provider);
		setError(null);
		try {
			const started = await client.login.start(provider);
			location.assign(started.url);
		} catch (failure) {
			setError(explain(failure));
			setBusy(null);
		}
	};

	const demo = async () => {
		setBusy("demo");
		setError(null);
		try {
			signIn(await client.login.demo());
			navigate({ name: "home" }, { replace: true });
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="signin">
			<div className="signin-bar">
				<Wordmark />
				<div className="signin-bar-end">
					<a className="topbar-docs" {...linkProps({ name: "docs", slug: "" })}>
						Docs
					</a>
					<ThemeToggle theme={theme} onToggle={onToggleTheme} />
				</div>
			</div>

			<main className="signin-main">
				<section className="signin-pitch" aria-labelledby="pitch">
					<Mark size={132} className="signin-mark" />
					<h1 id="pitch" className="display">
						Put an agent to work, and watch every turn.
					</h1>
					<p className="signin-lede">
						Windlass is a coding agent for the terminal. Here it runs in a sandbox you choose, and you see each file it
						reads, each command it runs and what the work cost.
					</p>
					<ul className="signin-points">
						<li>
							<span className="signin-point-key">sandbox</span>
							Hosted or on your machine, locked down by default.
						</li>
						<li>
							<span className="signin-point-key">trace</span>
							Every step live, as it happens.
						</li>
						<li>
							<span className="signin-point-key">changes</span>
							The diff of the workspace after every turn.
						</li>
					</ul>
				</section>

				<section className="signin-card" aria-label="Sign in">
					{signedOutReason ? (
						<p className="callout callout-warn" role="status">
							<WarnIcon />
							<span>{signedOutReason}</span>
						</p>
					) : null}

					<h2 className="signin-title">Sign in</h2>
					{platform.info?.github && (
						<button
							type="button"
							className="button button-primary button-large signin-primary"
							onClick={() => void start("github")}
							disabled={busy !== null}
						>
							Continue with GitHub
						</button>
					)}
					{platform.info?.googleLogin && (
						<button
							type="button"
							className="button button-outline button-large signin-primary"
							onClick={() => void start("google")}
							disabled={busy !== null}
						>
							Continue with Google
						</button>
					)}
					{platform.info?.github && (
						<details className="signin-aside">
							<summary>GitHub rejected the callback URL?</summary>
							Add {location.origin}/signin to the GitHub App's callback URLs.
						</details>
					)}
					{busy === "finish" && <p role="status">Finishing sign-in…</p>}
					{platform.info && !platform.info.github && !platform.info.googleLogin && (
						<p className="signin-aside">Account sign-in is unavailable on this deployment.</p>
					)}
					{platform.loading ? (
						<p className="signin-aside signin-aside-quiet">Asking the server what it offers…</p>
					) : platform.error ? (
						<p className="callout callout-bad" role="alert">
							<WarnIcon />
							<span>
								The server did not answer: {platform.error}{" "}
								<button type="button" className="link" onClick={platform.reload}>
									Try again
								</button>
							</span>
						</p>
					) : platform.info?.demoEnabled ? (
						<div className="signin-demo">
							{(platform.info.github || platform.info.googleLogin) && (
								<span className="signin-or" aria-hidden="true">
									or
								</span>
							)}
							<button type="button" className="button button-outline" onClick={demo} disabled={busy !== null}>
								{busy === "demo" ? "Starting the demo…" : "Try the demo"}
							</button>
							<p className="signin-aside">The demo runs a scripted model with real tool calls and needs no account.</p>
						</div>
					) : null}
					{error ? (
						<p className="callout callout-bad" role="alert">
							<WarnIcon />
							<span>{error}</span>
						</p>
					) : null}

					{client.kind === "mock" ? (
						<p className="signin-foot">
							<InfoIcon size={14} />
							Mock backend: the sign-in page is a stand-in and nothing leaves this browser.
						</p>
					) : null}
				</section>
			</main>
		</div>
	);
}

export function LinkCallback() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const handled = useRef(false);
	const [error, setError] = useState("");
	useEffect(() => {
		if (handled.current) return;
		handled.current = true;
		const callback = new URL(location.href);
		if (!callback.searchParams.has("code") && !callback.searchParams.has("error")) {
			navigate(takeReturnAfterSignIn() ?? { name: "home" }, { replace: true });
			return;
		}
		history.replaceState(history.state, "", callback.pathname);
		client.login
			.finish(callback.href, auth)
			.then(() => navigate({ name: "settings" }, { replace: true }))
			.catch(failure => setError(explain(failure)));
	}, [auth, client, explain]);
	return (
		<main className="state state-page">
			{error ? (
				<>
					<p role="alert">{error}</p>
					<a className="link" {...linkProps({ name: "settings" })}>
						Back to Settings
					</a>
				</>
			) : (
				<p role="status">Linking login method…</p>
			)}
		</main>
	);
}
