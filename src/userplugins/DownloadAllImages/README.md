# DownloadAllImages

Adds a `Download All Images` entry to the message right-click menu in Vencord.

When a message contains image attachments or embed images, the plugin collects them and downloads each one in sequence.

## Setup

Place the folder at `src/userplugins/DownloadAllImages` inside your cloned Vencord repo, then build Vencord normally.

The build entrypoint for this plugin is now `index.ts`, which is the format Vencord expects for `userplugins`.

## Usage

1. Right click a message that contains one or more images.
2. Click `Download All Images (N)`.
3. Vencord will download each image one by one.

## Development

- Main implementation: `index.ts`
- The plugin looks for image attachments plus image and thumbnail URLs from embeds.
- Downloads are fetched as blobs first so the saved files behave more like direct downloads.
- The plugin is built through Vencord's `src/userplugins` pipeline, not the standalone `manifest.json` format.

## Resources

- [Vencord Documentation](https://vencord.dev/docs/)
- [Plugin API Reference](https://vencord.dev/docs/plugins/)
