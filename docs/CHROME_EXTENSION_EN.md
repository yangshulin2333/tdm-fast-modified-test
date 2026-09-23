# Chrome extension installation and usage

[中文](CHROME_EXTENSION.md) · [Home](../README_EN.md)

## Download and extract

[Download the standalone extension ZIP](https://github.com/yangshulin2333/tdm-fast-modified-test/releases/download/v1.0.0-test.1/TDM-Fast-Chrome-extension-4.0.0.zip)

The extension is named **TDM Fast 资源嗅探**, version **4.0.0**. The desktop app has a separate version, 1.0.0. These unchanged extension files are extracted from the published desktop archive. The extension interface remains Chinese; this guide provides English button explanations.

If you already have the full desktop archive, use its `resources/extension` folder. The extension requires the running desktop application to receive downloads.

Extract the ZIP to a permanent writable location. Keep the `extension` folder; do not load directly from the ZIP or delete/move the folder after installation.

```text
extension/              ← Select this directory
├── manifest.json
├── background.js
├── content.js
├── inject.js
├── popup.html
├── popup.js
└── icons/
```

## Install in Chrome

1. Enter `chrome://extensions/` in the address bar.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the directory directly containing `manifest.json` (not the ZIP or its parent).
5. Check that the **TDM Fast 资源嗅探**, version **4.0.0**, card is enabled.
6. Open the puzzle-piece Extensions menu and pin the extension to the toolbar.

## First download

1. Exit other TDM Fast instances and start the desktop package using `Launch.cmd`.
2. Refresh a regular webpage. For videos, start playback before opening the extension.
3. Open the extension, select a detected resource and click **下载所选** (Download selected).
4. Check the desktop app for the task and its result. A sent notification does not prove a successful download.

Alternatively, right-click a link and choose **使用 TDM Fast 下载此链接** (Download this link with TDM Fast).

**接管浏览器下载** means automatic browser download takeover. Disable it if you prefer manual operation. The gear button configures file types, minimum file size and website exclusions.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Missing manifest / cannot load | Extract first, select the folder containing manifest.json, and retain all scripts and icons |
| No Load unpacked button | Enable Developer mode; managed browsers may restrict extension installation |
| Empty resource list | Refresh a normal webpage and start playback; internal browser pages are unsuitable; not every site is supported |
| Send failed | Start the desktop app; the extension sends tasks to `127.0.0.1:37651/capture`; avoid multiple app instances |
| Unwanted automatic takeover | Uncheck 接管浏览器下载 in the popup |
| Errors after moving files | Remove the old extension entry and load again from the new location |

## Update or remove

To update, extract the new files to the permanent location, reload the extension on `chrome://extensions/`, and refresh webpages. To uninstall, click **Remove** on its card; then delete the folder if desired.

## Permissions and validation

The manifest requests access to all websites, web requests, downloads, tabs, storage, notifications, context menus and navigation for resource detection and download takeover. This is an unpacked extension, not a Chrome Web Store package; no CRX is required.

File equality against the published desktop archive, ZIP integrity and manifest file references were verified. **Installation in the current Chrome version and the complete browser-to-desktop download workflow have not been tested.** Website compatibility is not guaranteed. The desktop app's known resume-after-restart issue remains.
