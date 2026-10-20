/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { ChannelStore, DraftType, SelectedChannelStore, showToast, UploadAttachmentStore, UploadHandler } from "@webpack/common";

const MAX_FILES_PER_MESSAGE = 10;
const UPLOAD_READY_TIMEOUT_MS = 15_000;
const UPLOAD_READY_POLL_MS = 100;

type QueuedUploadBatch = {
    channel: Channel;
    draftType: Number;
    batches: File[][];
};

const queuedUploads = new Map<string, QueuedUploadBatch>();

function chunkFiles(files: File[], size: number) {
    const chunks: File[][] = [];

    for (let i = 0; i < files.length; i += size) {
        chunks.push(files.slice(i, i + size));
    }

    return chunks;
}

function queueRemainingBatches(channel: Channel, draftType: Number, files: File[]) {
    if (files.length <= MAX_FILES_PER_MESSAGE) return files;

    const [firstBatch, ...remainingBatches] = chunkFiles(files, MAX_FILES_PER_MESSAGE);

    queuedUploads.set(channel.id, {
        channel,
        draftType,
        batches: remainingBatches,
    });

    showToast({ text: `Queued ${remainingBatches.length} extra batch${remainingBatches.length === 1 ? "" : "es"} for ${files.length} uploaded files.` });

    return firstBatch;
}

function getCurrentUploadTarget() {
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return null;

    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return null;

    return {
        channel,
        draftType: DraftType.ChannelMessage as unknown as Number,
    };
}

function getPendingUploads(channelId: string, draftType: Number) {
    return UploadAttachmentStore.getUploads(channelId, draftType as any);
}

function waitForUploads(channelId: string, draftType: Number, expectedCount: number) {
    return new Promise<void>((resolve, reject) => {
        const startedAt = Date.now();

        const interval = setInterval(() => {
            const uploads = getPendingUploads(channelId, draftType);

            if (uploads.length >= expectedCount) {
                clearInterval(interval);
                resolve();
                return;
            }

            if (Date.now() - startedAt > UPLOAD_READY_TIMEOUT_MS) {
                clearInterval(interval);
                reject(new Error("Timed out while waiting for queued uploads to be prepared."));
            }
        }, UPLOAD_READY_POLL_MS);
    });
}

async function stageNextBatch(channelId: string) {
    const queued = queuedUploads.get(channelId);
    if (!queued) return;

    try {
        const batch = queued.batches.shift();
        if (!batch) {
            queuedUploads.delete(channelId);
            showToast({ text: "All upload batches are ready.", variant: "success" });
            return;
        }

        UploadHandler.promptToUpload(batch, queued.channel, queued.draftType);
        await waitForUploads(channelId, queued.draftType, batch.length);

        if (queued.batches.length === 0) {
            queuedUploads.delete(channelId);
            showToast({ text: "Loaded the final upload batch into the composer.", variant: "success" });
            return;
        }

        showToast({ text: `Loaded the next upload batch. ${queued.batches.length} batch${queued.batches.length === 1 ? "" : "es"} remaining.` });
    } catch (error) {
        console.error("[SplitLargeUploads]", error);
        queuedUploads.delete(channelId);
        showToast({ text: "Failed while loading the next upload batch.", variant: "critical" });
    }
}

export default definePlugin({
    name: "SplitLargeUploads",
    description: "Splits uploads larger than 10 files into multiple messages automatically",
    authors: [{
        name: "Custom",
        id: 0n,
    }],
    patches: [
        {
            find: "Unexpected mismatch between files and file metadata",
            replacement: {
                match: /(?<=function \i\()(\i),(\i),(\i)(?=\)\{)/,
                replace: "$1,$2,$3"
            }
        },
        {
            find: "Unexpected mismatch between files and file metadata",
            replacement: {
                match: /(?<=function \i\(\i,\i,\i\)\{)/,
                replace: "$self.interceptInitialUpload(arguments);"
            }
        }
    ],

    start() {
        this.originalPromptToUpload = UploadHandler.promptToUpload;
        this.handleWindowDrop = (event: DragEvent) => {
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (files.length <= MAX_FILES_PER_MESSAGE) return;

            const target = getCurrentUploadTarget();
            if (!target) return;

            event.preventDefault();
            event.stopPropagation();

            const firstBatch = queueRemainingBatches(target.channel, target.draftType, files);
            this.originalPromptToUpload(firstBatch, target.channel, target.draftType);
        };
        this.handleFileInputChange = (event: Event) => {
            const input = event.target as HTMLInputElement | null;
            if (!input || input.tagName !== "INPUT" || input.type !== "file") return;

            const files = Array.from(input.files ?? []);
            if (files.length <= MAX_FILES_PER_MESSAGE) return;

            const target = getCurrentUploadTarget();
            if (!target) return;

            event.preventDefault();
            event.stopPropagation();
            (event as Event & { stopImmediatePropagation?: () => void; }).stopImmediatePropagation?.();

            const firstBatch = queueRemainingBatches(target.channel, target.draftType, files);

            // Clear the original input so Discord doesn't continue with the oversized selection.
            input.value = "";

            this.originalPromptToUpload(firstBatch, target.channel, target.draftType);
        };

        window.addEventListener("drop", this.handleWindowDrop, true);
        document.addEventListener("change", this.handleFileInputChange, true);

        UploadHandler.promptToUpload = (files: File[], channel: Channel, draftType: Number) => {
            if (files.length <= MAX_FILES_PER_MESSAGE) {
                return this.originalPromptToUpload(files, channel, draftType);
            }

            return this.originalPromptToUpload(
                queueRemainingBatches(channel, draftType, files),
                channel,
                draftType
            );
        };
    },

    stop() {
        if (this.handleWindowDrop) {
            window.removeEventListener("drop", this.handleWindowDrop, true);
        }

        if (this.handleFileInputChange) {
            document.removeEventListener("change", this.handleFileInputChange, true);
        }

        if (this.originalPromptToUpload) {
            UploadHandler.promptToUpload = this.originalPromptToUpload;
        }

        queuedUploads.clear();
    },

    async onBeforeMessageSend(channelId, _messageObj, options) {
        const queued = queuedUploads.get(channelId);
        if (!queued) return;

        if (!options.uploads?.length) return;

        setTimeout(() => {
            void stageNextBatch(channelId);
        }, 250);
    },

    interceptInitialUpload(args: IArguments | [File[], Channel, Number]) {
        const [files, channel, draftType] = args as unknown as [File[], Channel, Number];

        if (!Array.isArray(files) || files.length <= MAX_FILES_PER_MESSAGE) {
            return;
        }

        args[0] = queueRemainingBatches(channel, draftType, files);
    },

    handleWindowDrop: null as null | ((event: DragEvent) => void),
    handleFileInputChange: null as null | ((event: Event) => void),
    originalPromptToUpload: UploadHandler.promptToUpload,
});
