/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { dialog } from "electron";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

type DownloadableImage = {
    url: string;
    filename: string;
};

type DownloadImagesResult = {
    cancelled: boolean;
    folder?: string;
    saved: number;
    failures: number;
    errors: string[];
};

type DownloadImageResult = {
    cancelled: boolean;
    path?: string;
};

function sanitizeFilename(filename: string) {
    return filename.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
}

async function fetchImageBytes(url: string) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
    }

    return new Uint8Array(await response.arrayBuffer());
}

export async function downloadImage(_: Electron.IpcMainInvokeEvent, image: DownloadableImage): Promise<DownloadImageResult> {
    const defaultPath = sanitizeFilename(image.filename);
    const selection = await dialog.showSaveDialog({
        title: "Save image",
        defaultPath,
    });

    if (selection.canceled || !selection.filePath) {
        return {
            cancelled: true,
        };
    }

    const bytes = await fetchImageBytes(image.url);
    await writeFile(selection.filePath, bytes);

    return {
        cancelled: false,
        path: selection.filePath,
    };
}

export async function downloadImages(_: Electron.IpcMainInvokeEvent, images: DownloadableImage[]): Promise<DownloadImagesResult> {
    const selection = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: "Choose a folder for the downloaded images",
    });

    if (selection.canceled || selection.filePaths.length === 0) {
        return {
            cancelled: true,
            saved: 0,
            failures: 0,
            errors: [],
        };
    }

    const folder = selection.filePaths[0];
    await mkdir(folder, { recursive: true });

    const errors: string[] = [];
    let saved = 0;

    for (const image of images) {
        try {
            const outputPath = join(folder, sanitizeFilename(image.filename));
            await writeFile(outputPath, await fetchImageBytes(image.url));
            saved++;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`${image.url}: ${message}`);
        }
    }

    return {
        cancelled: false,
        folder,
        saved,
        failures: errors.length,
        errors,
    };
}
