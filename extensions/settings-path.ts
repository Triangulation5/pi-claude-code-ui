import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Pi's own settings file (`<agentDir>/settings.json`, by default `~/.pi/agent/settings.json`). */
export function getUserSettingsPath(): string {
	return `${getAgentDir()}/settings.json`;
}
