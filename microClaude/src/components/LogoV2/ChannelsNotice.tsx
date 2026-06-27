// Conditionally require()'d in LogoV2.tsx behind feature('KAIROS') ||
// feature('KAIROS_CHANNELS'). No feature() guard here; the whole file
// tree-shakes via the require pattern when both flags are false (see
// docs/feature-gating.md). Do not import this module statically from
// unguarded code.

import * as React from 'react';
import { useState } from 'react';
import {
  type ChannelEntry,
  getAllowedChannels,
  getHasDevChannels,
} from '../../bootstrap/state.js';
import { Box, Text } from '../../ink.js';
import { isChannelsEnabled } from '../../services/mcp/channelAllowlist.js';
import { getEffectiveChannelAllowlist } from '../../services/mcp/channelNotification.js';
import { getMcpConfigsByScope } from '../../services/mcp/config.js';
import {
  getClaudeAIOAuthTokens,
  getSubscriptionType,
} from '../../utils/auth.js';
import { loadInstalledPluginsV2 } from '../../utils/plugins/installedPluginsManager.js';
import { getSettingsForSource } from '../../utils/settings/settings.js';

type Unmatched = {
  entry: ChannelEntry;
  why: string;
};

type NoticeState = {
  channels: ChannelEntry[];
  disabled: boolean;
  noAuth: boolean;
  policyBlocked: boolean;
  list: string;
  unmatched: Unmatched[];
};

export function ChannelsNotice(): React.ReactNode {
  // Snapshot all reads at mount. This notice enters scrollback immediately
  // after the logo; any later rerender would force a full terminal redraw.
  const [{ channels, disabled, noAuth, policyBlocked, list, unmatched }] =
    useState<NoticeState>(() => {
      const channels = getAllowedChannels();
      if (channels.length === 0) {
        return {
          channels,
          disabled: false,
          noAuth: false,
          policyBlocked: false,
          list: '',
          unmatched: [],
        };
      }

      const list = channels.map(formatEntry).join(', ');
      const subscriptionType = getSubscriptionType();
      const managed =
        subscriptionType === 'team' || subscriptionType === 'enterprise';
      const policy = getSettingsForSource('policySettings');
      const allowlist = getEffectiveChannelAllowlist(
        subscriptionType,
        policy?.allowedChannelPlugins,
      );

      return {
        channels,
        disabled: !isChannelsEnabled(),
        noAuth: !getClaudeAIOAuthTokens()?.accessToken,
        policyBlocked: managed && policy?.channelsEnabled !== true,
        list,
        unmatched: findUnmatched(channels, allowlist),
      };
    });

  if (channels.length === 0) {
    return null;
  }

  const hasNonDevChannels = channels.some(channel => !channel.dev);
  const flag =
    getHasDevChannels() && hasNonDevChannels
      ? 'Channels'
      : getHasDevChannels()
        ? '--dangerously-load-development-channels'
        : '--channels';

  if (disabled) {
    return (
      <Box paddingLeft={2} flexDirection="column">
        <Text color="error">
          {flag} ignored ({list})
        </Text>
        <Text dimColor>Channels are not currently available</Text>
      </Box>
    );
  }

  if (noAuth) {
    return (
      <Box paddingLeft={2} flexDirection="column">
        <Text color="error">
          {flag} ignored ({list})
        </Text>
        <Text dimColor>
          Channels require claude.ai authentication - run /login, then restart
        </Text>
      </Box>
    );
  }

  if (policyBlocked) {
    return (
      <Box paddingLeft={2} flexDirection="column">
        <Text color="error">
          {flag} blocked by org policy ({list})
        </Text>
        <Text dimColor>Inbound messages will be silently dropped</Text>
        <Text dimColor>
          Have an administrator set channelsEnabled: true in managed settings to
          enable
        </Text>
        {unmatched.map(unmatchedEntry => (
          <Text
            key={`${formatEntry(unmatchedEntry.entry)}:${unmatchedEntry.why}`}
            color="warning"
          >
            {formatEntry(unmatchedEntry.entry)} - {unmatchedEntry.why}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box paddingLeft={2} flexDirection="column">
      <Text color="error">Listening for channel messages from: {list}</Text>
      <Text dimColor>
        Experimental - inbound messages will be pushed into this session, this
        carries prompt injection risks. Restart Claude Code without {flag} to
        disable.
      </Text>
      {unmatched.map(unmatchedEntry => (
        <Text
          key={`${formatEntry(unmatchedEntry.entry)}:${unmatchedEntry.why}`}
          color="warning"
        >
          {formatEntry(unmatchedEntry.entry)} - {unmatchedEntry.why}
        </Text>
      ))}
    </Box>
  );
}

function formatEntry(entry: ChannelEntry): string {
  return entry.kind === 'plugin'
    ? `plugin:${entry.name}@${entry.marketplace}`
    : `server:${entry.name}`;
}

function findUnmatched(
  entries: readonly ChannelEntry[],
  allowlist: ReturnType<typeof getEffectiveChannelAllowlist>,
): Unmatched[] {
  const scopes = ['enterprise', 'user', 'project', 'local'] as const;
  const configuredServerNames = new Set<string>();

  for (const scope of scopes) {
    for (const name of Object.keys(getMcpConfigsByScope(scope).servers)) {
      configuredServerNames.add(name);
    }
  }

  const installedPluginIds = new Set(
    Object.keys(loadInstalledPluginsV2().plugins),
  );
  const { entries: allowedEntries, source } = allowlist;

  const unmatched: Unmatched[] = [];

  for (const entry of entries) {
    if (entry.kind === 'server') {
      if (!configuredServerNames.has(entry.name)) {
        unmatched.push({
          entry,
          why: 'no MCP server configured with that name',
        });
      }

      if (!entry.dev) {
        unmatched.push({
          entry,
          why: 'server: entries need --dangerously-load-development-channels',
        });
      }

      continue;
    }

    if (!installedPluginIds.has(`${entry.name}@${entry.marketplace}`)) {
      unmatched.push({
        entry,
        why: 'plugin not installed',
      });
    }

    if (
      !entry.dev &&
      !allowedEntries.some(
        allowed =>
          allowed.plugin === entry.name &&
          allowed.marketplace === entry.marketplace,
      )
    ) {
      unmatched.push({
        entry,
        why:
          source === 'org'
            ? "not on your org's approved channels list"
            : 'not on the approved channels allowlist',
      });
    }
  }

  return unmatched;
}
