/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, Guild } from "@vencord/discord-types";
import { ActiveJoinedThreadsStore, ChannelStore, Menu, RestAPI, showToast, UserStore } from "@webpack/common";

const settings = definePluginSettings({
    skipCreatedPosts: {
        type: OptionType.BOOLEAN,
        description: "Skip leaving forum posts that you created.",
        default: true
    },
    requestDelay: {
        type: OptionType.NUMBER,
        description: "Delay between leave requests in milliseconds.",
        default: 250
    },
    includeArchivedPosts: {
        type: OptionType.BOOLEAN,
        description: "Include archived forum posts when leaving.",
        default: false
    }
});

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getJoinedThreadIds(guildId: string) {
    const joinedThreads = ActiveJoinedThreadsStore.getActiveJoinedThreadsForGuild(guildId);
    const ids: Set<string> = new Set();

    for (const parentId of Object.keys(joinedThreads)) {
        const threads = joinedThreads[parentId];
        for (const threadId of Object.keys(threads || {})) {
            ids.add(threadId);
        }
    }

    return ids;
}

async function leaveForumPostsForGuild(guild: Guild) {
    const currentUserId = UserStore.getCurrentUser()?.id;
    const allThreads = ChannelStore.getAllThreadsForGuild(guild.id) ?? [];
    const joinedThreadIds = getJoinedThreadIds(guild.id);

    const threads = allThreads.filter((thread: Channel) => {
        if (!thread.isForumPost()) return false;
        if (!settings.store.includeArchivedPosts && thread.isArchivedThread()) return false;
        if (settings.store.skipCreatedPosts && currentUserId && thread.ownerId === currentUserId) return false;
        if (thread.member == null && !joinedThreadIds.has(thread.id)) return false;
        return true;
    });

    if (threads.length === 0) {
        showToast({ text: "No forum posts found to leave in this server.", position: "bottom" });
        return;
    }

    const delay = Math.max(0, settings.store.requestDelay ?? 0);
    showToast({ text: `Leaving ${threads.length} forum post${threads.length === 1 ? "" : "s"}...`, position: "bottom" });

    let successCount = 0;
    const failures: Array<{ id: string; name: string; error: unknown; retryCount: number; }> = [];

    async function leaveThread(thread: Channel) {
        let retryCount = 0;
        while (retryCount < 10) {
            try {
                await RestAPI.del({ url: `/channels/${thread.id}/thread-members/@me` });
                successCount++;
                return;
            } catch (error) {
                retryCount++;
                if (retryCount >= 10) {
                    failures.push({ id: thread.id, name: thread.name, error, retryCount });
                    return;
                }
                await sleep(delay);
            }
        }
    }

    for (const thread of threads) {
        await leaveThread(thread);
        if (delay > 0) {
            await sleep(delay);
        }
    }

    if (failures.length === 0) {
        showToast({ text: `Successfully left ${successCount} forum post${successCount === 1 ? "" : "s"}.`, variant: "success", position: "bottom" });
    } else {
        showToast({ text: `Left ${successCount}/${threads.length} forum posts. ${failures.length} failed after 10 retries.`, variant: "critical", position: "bottom" });
    }
}

const Patch: NavContextMenuPatchCallback = (children, { guild }: { guild: Guild; }) => {
    const group = findGroupChildrenByChildId("privacy", children);

    group?.push(
        <Menu.MenuItem
            id="vc-leave-all-forum-posts"
            label="Leave All Forum Posts"
            action={() => {
                leaveForumPostsForGuild(guild).catch(error => {
                    showToast({ text: `Error leaving forum posts: ${error}`, variant: "critical", position: "bottom" });
                });
            }}
        />
    );
};

export default definePlugin({
    name: "LeaveAllForumPosts",
    description: "Adds a guild context menu action to leave all forum posts in a server.",
    tags: ["Servers", "Utility"],
    authors: [Devs.castdrian],
    settings,
    contextMenus: {
        "guild-context": Patch
    }
});
