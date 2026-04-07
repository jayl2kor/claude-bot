/**
 * Channel plugin registry.
 * Reference: OpenClaw src/channels/plugins/registry.ts
 */

import type { ChannelPlugin } from "./types.js";

const plugins = new Map<string, ChannelPlugin>();

export function registerPlugin(plugin: ChannelPlugin): void {
	plugins.set(plugin.id, plugin);
}

export function getPlugin(id: string): ChannelPlugin | undefined {
	return plugins.get(id);
}

export function listPlugins(): ChannelPlugin[] {
	return [...plugins.values()];
}
