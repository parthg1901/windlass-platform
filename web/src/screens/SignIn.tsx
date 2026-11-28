import type { LoginProvider } from "@contract";
import { useEffect, useRef, useState } from "react";
import { GitHubLogo, GoogleLogo } from "../components/AgentLogos";
import { WarnIcon } from "../components/Icons";
import { Loading, Skeleton } from "../components/ui";
import { linkProps, navigate, takeReturnAfterSignIn } from "../lib/router";
import { Landing, SignInShell } from "../site/Landing";
import type { Theme } from "../lib/theme";
import { useApp, useAuth } from "../state/app";

/**
 * Sign-in is the landing page with the live panel in its hero: "/" and "/signin" are one page for
 * someone signed out. "/signin?with=github" (the static page's buttons) starts that sign-in at once.
 */
export function SignIn({ onToggleTheme }: { theme?: Theme; onToggleTheme(): void }) {
	return <Landing onToggleTheme={onToggleTheme} signIn={<SignInPanel />} />;
}

function SignInPanel() {
	const { client, signIn, signedOutReason, platform, explain } = useApp();
	const [busy, setBusy] = useState<LoginProvider | "finish" | "demo" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const asked = useRef<string | null>(new URL(location.href).searchParams.get("with"));

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

	// The static landing's buttons: start the provider they named once the server says it is offered.
	useEffect(() => {
		const wanted = asked.current;
		if (!wanted || !platform.info) return;
		asked.current = null;
		history.replaceState(history.state, "", location.pathname);
		if (wanted === "github" && platform.info.github) void start("github");
		else if (wanted === "google" && platform.info.googleLogin) void start("google");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [platform.info]);

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

	const info = platform.info;
	const accounts = !!info && (info.github || info.googleLogin);
	return (
		<SignInShell>
			{signedOutReason ? (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>{signedOutReason}</span>
				</p>
			) : null}
			{info?.github && (
				<button
					type="button"
					className="lp-btn lp-btn-accent lp-btn-lg lp-signin-btn"
					onClick={() => void start("github")}
					disabled={busy !== null}
				>
					<GitHubLogo /> {busy === "github" ? "Opening GitHub…" : "Continue with GitHub"}
				</button>
			)}
			{info?.googleLogin && (
				<button
					type="button"
					className={`lp-btn ${info.github ? "lp-btn-line" : "lp-btn-accent"} lp-btn-lg lp-signin-btn`}
					onClick={() => void start("google")}
					disabled={busy !== null}
				>
					<GoogleLogo /> {busy === "google" ? "Opening Google…" : "Continue with Google"}
				</button>
			)}
			{info && !accounts && !info.demoEnabled && (
				<p className="lp-signin-note">Account sign-in is unavailable on this deployment.</p>
			)}
			{platform.loading ? (
				// Until the server says which sign-ins it offers: the two buttons it usually draws, as placeholders.
				<Loading label="Loading the ways to sign in" className="lp-signin-loading">
					<Skeleton width="100%" height={42} radius={10} />
					<Skeleton width="100%" height={42} radius={10} />
				</Loading>
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
			) : info?.demoEnabled ? (
				<>
					{accounts && (
						<span className="lp-signin-or" aria-hidden="true">
							or
						</span>
					)}
					<button
						type="button"
						className={`lp-btn ${accounts ? "lp-btn-line" : "lp-btn-accent"} lp-btn-lg lp-signin-btn`}
						onClick={demo}
						disabled={busy !== null}
					>
						{busy === "demo" ? "Starting the demo…" : "Try the demo"}
					</button>
					<p className="lp-signin-note">A scripted model with real tool calls. No account needed.</p>
				</>
			) : null}
			{busy === "finish" && (
				<p className="lp-signin-note" role="status">
					Finishing sign-in…
				</p>
			)}
			{error ? (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{error}</span>
				</p>
			) : null}
		</SignInShell>
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
