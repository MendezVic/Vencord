/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import definePlugin, { PluginNative } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { Menu, showToast } from "@webpack/common";

const IMAGE_EXTENSIONS = /\.(apng|avif|bmp|gif|jpe?g|png|svg|webp)(?:\?|$)/i;

type AttachmentLike = {
    content_type?: string;
    contentType?: string;
    filename?: string;
    url?: string;
    width?: number | null;
};

type EmbedLike = {
    type?: string;
    image?: {
        url?: string;
    };
    thumbnail?: {
        url?: string;
    };
};

type DownloadableImage = {
    url: string;
    filename: string;
};

type QueuedMessage = {
    id: string;
    images: DownloadableImage[];
};

const Native = IS_DISCORD_DESKTOP
    ? VencordNative.pluginHelpers.DownloadAllImages as PluginNative<typeof import("./native")>
    : null;

const CustomAuthor = {
    name: "Custom",
    id: 0n,
    badge: false,
} as const;

const queuedMessages = new Map<string, QueuedMessage>();
const QUEUE_TIMEOUT_MS = 30_000;

let queueClearTimeout: ReturnType<typeof setTimeout> | null = null;

function isImageAttachment(attachment: AttachmentLike) {
    return Boolean(
        attachment.url && (
            attachment.content_type?.startsWith("image/")
            || attachment.contentType?.startsWith("image/")
            || attachment.width != null
            || IMAGE_EXTENSIONS.test(attachment.filename ?? attachment.url)
        )
    );
}

function collectMessageImages(message: Message) {
    const images = new Map<string, string | undefined>();

    const addImage = (url?: string, fallbackName?: string) => {
        if (!url || images.has(url)) return;
        images.set(url, fallbackName);
    };

    message.attachments?.forEach(attachment => {
        if (!isImageAttachment(attachment as AttachmentLike)) return;
        addImage(attachment.url, attachment.filename);
    });

    message.embeds?.forEach((embed: EmbedLike) => {
        addImage(embed.image?.url, `embed-image-${embed.type ?? "image"}.png`);
        addImage(embed.thumbnail?.url, `embed-thumbnail-${embed.type ?? "image"}.png`);
    });

    return Array.from(images, ([url, filename], index): DownloadableImage => ({
        url,
        filename: filename || `message-image-${index + 1}.png`,
    }));
}

function sanitizeFilename(filename: string) {
    return filename.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
}

function getExtensionFromUrl(url: string) {
    const match = url.match(IMAGE_EXTENSIONS);
    return match?.[1]?.toLowerCase() ?? "png";
}

function formatFilename(filename: string, url: string, index: number) {
    const hasExtension = /\.[a-z0-9]+$/i.test(filename);
    const numberedFilename = hasExtension
        ? filename
        : `${filename}.${getExtensionFromUrl(url)}`;

    return sanitizeFilename(
        `${String(index + 1).padStart(3, "0")}-${numberedFilename}`
    );
}

function prepareImagesForDownload(images: DownloadableImage[]) {
    return images.map((image, index) => ({
        ...image,
        filename: formatFilename(image.filename, image.url, index),
    }));
}

async function downloadImage({ url, filename }: DownloadableImage, index: number) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);

    try {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

async function downloadAllImages(images: DownloadableImage[]) {
    const preparedImages = prepareImagesForDownload(images);

    if (preparedImages.length === 1 && IS_DISCORD_DESKTOP && Native) {
        try {
            const result = await Native.downloadImage(preparedImages[0]);

            if (result.cancelled) return;

            showToast({ text: `Saved image to ${result.path}.`, variant: "success" });
        } catch (error) {
            console.error("[DownloadAllImages]", error);
            showToast({ text: "Failed to download the image.", variant: "critical" });
        }
        return;
    }

    if (preparedImages.length === 1) {
        try {
            await downloadImage(preparedImages[0], 0);
            showToast({ text: "Downloaded 1 image.", variant: "success" });
        } catch (error) {
            console.error("[DownloadAllImages]", error);
            showToast({ text: "Failed to download the image.", variant: "critical" });
        }
        return;
    }

    if (IS_DISCORD_DESKTOP && Native) {
        const result = await Native.downloadImages(preparedImages);

        if (result.cancelled) return;

        if (result.failures === 0) {
            showToast({ text: `Saved ${result.saved} image${result.saved === 1 ? "" : "s"} to ${result.folder}.`, variant: "success" });
            return;
        }

        console.error("[DownloadAllImages]", result.errors);
        showToast({ text: `Saved ${result.saved}/${preparedImages.length} images to ${result.folder}.`, variant: "critical" });
        return;
    }

    const failures: Array<{ image: DownloadableImage; error: unknown; }> = [];

    for (const [index, image] of preparedImages.entries()) {
        try {
            await downloadImage(image, index);
        } catch (error) {
            failures.push({ image, error });
        }
    }

    if (failures.length === 0) {
        showToast({ text: `Downloaded ${preparedImages.length} image${preparedImages.length === 1 ? "" : "s"}.`, variant: "success" });
        return;
    }

    console.error("[DownloadAllImages]", failures);
    showToast({ text: `Downloaded ${preparedImages.length - failures.length}/${preparedImages.length} images.`, variant: "critical" });
}

function getQueuedImages() {
    return Array.from(queuedMessages.values()).flatMap(message => message.images);
}

function clearQueueTimer() {
    if (queueClearTimeout == null) return;

    clearTimeout(queueClearTimeout);
    queueClearTimeout = null;
}

function clearQueuedMessages(showMessage = false) {
    clearQueueTimer();

    if (queuedMessages.size === 0) return;

    queuedMessages.clear();

    if (showMessage) {
        showToast({ text: "Cleared the image download queue." });
    }
}

function refreshQueueTimer() {
    clearQueueTimer();

    if (queuedMessages.size === 0) return;

    queueClearTimeout = setTimeout(() => {
        queuedMessages.clear();
        queueClearTimeout = null;
        showToast({ text: "Image download queue expired after 30 seconds." });
    }, QUEUE_TIMEOUT_MS);
}

function toggleQueuedMessage(message: Message, images: DownloadableImage[]) {
    if (queuedMessages.has(message.id)) {
        queuedMessages.delete(message.id);
        refreshQueueTimer();
        showToast({ text: "Removed message from image download queue." });
        return;
    }

    queuedMessages.set(message.id, {
        id: message.id,
        images,
    });
    refreshQueueTimer();
    showToast({ text: `Queued message with ${images.length} image${images.length === 1 ? "" : "s"}.`, variant: "success" });
}

async function downloadQueuedImages() {
    const images = getQueuedImages();
    if (images.length === 0) {
        showToast({ text: "No queued message images to download.", variant: "critical" });
        return;
    }

    await downloadAllImages(images);
    clearQueuedMessages();
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, { message }: { message?: Message; }) => {
    if (!message) return;

    const images = collectMessageImages(message);
    if (images.length === 0) return;
    const isQueued = queuedMessages.has(message.id);
    const queuedImages = getQueuedImages();

    children.push(
        <Menu.MenuItem
            id="vc-download-all-images"
            key="vc-download-all-images"
            label="Image Downloads"
        >
            <Menu.MenuItem
                id="vc-download-all-images-current"
                key="vc-download-all-images-current"
                label={`Download This Message (${images.length})`}
                action={() => void downloadAllImages(images)}
            />
            <Menu.MenuItem
                id="vc-download-all-images-queue-toggle"
                key="vc-download-all-images-queue-toggle"
                label={isQueued ? "Remove Message From Queue" : "Add Message To Queue"}
                action={() => toggleQueuedMessage(message, images)}
            />
            <Menu.MenuItem
                id="vc-download-all-images-queue-download"
                key="vc-download-all-images-queue-download"
                label={`Download Queued Messages (${queuedMessages.size} messages, ${queuedImages.length} images)`}
                action={() => void downloadQueuedImages()}
            />
        </Menu.MenuItem>
    );
};

export default definePlugin({
    name: "DownloadAllImages",
    description: "Adds a message context menu button to download all images in a message",
    authors: [CustomAuthor],
    tags: ["Images"],
    contextMenus: {
        message: messageContextMenuPatch,
    },
});
