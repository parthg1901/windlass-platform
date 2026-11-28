import { githubApp } from "../github/app.js";
import { gitlabApp } from "../gitlab/connect.js";
import { gitlabCodeHost, type GitlabConnection } from "../gitlab/host.js";
import { githubCodeHost } from "./github.js";

export type { CodeHost } from "./types.js";

/** GitHub remains the default. GitLab credentials belong to the selected connection, not the deployment. */
export function resolveCodeHost(provider?: "github"): ReturnType<typeof githubCodeHost> | null;
export function resolveCodeHost(
	provider: "gitlab",
	connection: GitlabConnection,
): ReturnType<typeof gitlabCodeHost> | null;
export function resolveCodeHost(provider: "github" | "gitlab" = "github", connection?: GitlabConnection) {
	if (provider === "gitlab") {
		const app = gitlabApp();
		return app && connection ? gitlabCodeHost(app, connection) : null;
	}
	const app = githubApp();
	return app && githubCodeHost(app);
}
