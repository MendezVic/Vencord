/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Margins } from "@utils/margins";
import definePlugin, { OptionType } from "@utils/types";
import type { Guild } from "@vencord/discord-types";
import { ChannelStore, Forms, GuildStore, MessageActions, ReadStateStore, SearchableSelect, SelectedChannelStore, useMemo } from "@webpack/common";

interface ChannelSelectEvent {
    type: "CHANNEL_SELECT";
    channelId: string | null;
    guildId: string | null;
}

type ChannelWithLastMessageId = {
    guild_id?: string | null;
    guildId?: string | null;
    lastMessageId?: string | null;
    last_message_id?: string | null;
};

function ServerSelectSetting({ setValue }: { setValue(value: string): void; }) {
    const selectedServerId = settings.use(["serverId"]).serverId;

    const options = useMemo(
        () => [
            { label: "Disabled", value: "" },
            ...Object.values(GuildStore.getGuilds() as Record<string, Guild>)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(guild => ({
                    label: guild.name,
                    value: guild.id
                }))
        ],
        []
    );

    return (
        <section className={Margins.bottom16}>
            <Forms.FormTitle tag="h3">Server</Forms.FormTitle>
            <Forms.FormText className={Margins.bottom8}>
                Only auto-jump in this server.
            </Forms.FormText>

            <SearchableSelect
                options={options}
                value={options.find(option => option.value === selectedServerId)?.value}
                placeholder="Select a server"
                maxVisibleItems={5}
                closeOnSelect={true}
                onChange={value => setValue(value)}
            />
        </section>
    );
}

const settings = definePluginSettings({
    serverId: {
        type: OptionType.COMPONENT,
        component: ServerSelectSetting,
        default: ""
    },
    initialDelay: {
        type: OptionType.NUMBER,
        description: "Delay before jumping after opening a channel, in milliseconds.",
        default: 350
    },
    retryCount: {
        type: OptionType.NUMBER,
        description: "Extra jump attempts while Discord is still loading the channel.",
        default: 4
    },
    retryDelay: {
        type: OptionType.NUMBER,
        description: "Delay between retry attempts, in milliseconds.",
        default: 450
    }
});

let jumpGeneration = 0;
const pendingTimeouts = new Set<number>();

function clearPendingJumps() {
    for (const timeout of pendingTimeouts) {
        clearTimeout(timeout);
    }

    pendingTimeouts.clear();
}

function schedule(ms: number, callback: () => void) {
    const timeout = window.setTimeout(() => {
        pendingTimeouts.delete(timeout);
        callback();
    }, Math.max(0, ms));

    pendingTimeouts.add(timeout);
}

function getLatestMessageId(channelId: string) {
    const readStateLastMessageId = ReadStateStore.lastMessageId(channelId);
    if (readStateLastMessageId) return readStateLastMessageId;

    const channel = ChannelStore.getChannel(channelId) as ChannelWithLastMessageId | null | undefined;
    return channel?.lastMessageId ?? channel?.last_message_id ?? null;
}

function getChannelGuildId(channelId: string, selectedGuildId: string | null) {
    if (selectedGuildId) return selectedGuildId;

    const channel = ChannelStore.getChannel(channelId) as ChannelWithLastMessageId | null | undefined;
    return channel?.guild_id ?? channel?.guildId ?? null;
}

function shouldJumpInChannel(channelId: string, selectedGuildId: string | null) {
    const serverId = settings.store.serverId.trim();
    if (!serverId) return false;

    return getChannelGuildId(channelId, selectedGuildId) === serverId;
}

function jumpToLatest(channelId: string, generation: number, attemptsLeft: number) {
    if (generation !== jumpGeneration) return;
    if (SelectedChannelStore.getChannelId() !== channelId) return;

    const messageId = getLatestMessageId(channelId);

    if (messageId) {
        MessageActions.jumpToMessage({
            channelId,
            messageId,
            flash: false,
            jumpType: "INSTANT"
        });
    }

    if (attemptsLeft <= 0) return;

    schedule(settings.store.retryDelay, () => {
        jumpToLatest(channelId, generation, attemptsLeft - 1);
    });
}

function queueJumpToLatest(channelId: string) {
    clearPendingJumps();

    const generation = ++jumpGeneration;
    const initialDelay = settings.store.initialDelay;
    const retryCount = Math.max(0, settings.store.retryCount);

    schedule(initialDelay, () => {
        jumpToLatest(channelId, generation, retryCount);
    });
}

export default definePlugin({
    name: "AutoJumpToLatest",
    description: "Automatically jumps to the newest message when opening a channel or forum post.",
    tags: ["Chat", "Utility"],
    authors: [Devs.castdrian],
    settings,

    stop() {
        clearPendingJumps();
        jumpGeneration++;
    },

    flux: {
        CHANNEL_SELECT({ channelId, guildId }: ChannelSelectEvent) {
            if (!channelId || !shouldJumpInChannel(channelId, guildId)) {
                clearPendingJumps();
                jumpGeneration++;
                return;
            }

            queueJumpToLatest(channelId);
        }
    }
});
