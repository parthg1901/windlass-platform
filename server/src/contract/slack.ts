/** Slack workspace connections and channel mappings. Member links are linked accounts (identity.ts). */

import type { GithubId } from "./github.js";

export interface SlackChannel {
	id: string;
	name: string;
}
export interface SlackMapping {
	channel: SlackChannel;
	repository: { id: GithubId; owner: string; name: string };
	/** Post plan and question content, which every channel member can read. Off: links and choice buttons only. */
	details: boolean;
}
export type SlackStatus =
	| { state: "off" }
	| { state: "disconnected" }
	| { state: "connected"; teamId: string; workspaceName: string; mappings: SlackMapping[] };

export interface SlackSettingsActions {
	slack(): Promise<SlackStatus>;
	slackConnect(input: { origin: string }): Promise<{ url: string }>;
	slackComplete(ticket: string): Promise<SlackStatus>;
	slackChannels(): Promise<SlackChannel[]>;
	saveSlackMapping(input: { channelId: string; repositoryId: GithubId }): Promise<SlackStatus>;
	removeSlackMapping(channelId: string): Promise<SlackStatus>;
	setSlackDetails(input: { channelId: string; details: boolean }): Promise<SlackStatus>;
	disconnectSlack(): Promise<SlackStatus>;
}
