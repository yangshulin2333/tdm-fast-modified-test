# TDM Fast 1.0.0 Modified Test Build

[中文](README.md) | English

An experimental, unofficial modified distribution of TDM Fast 1.0.0. This is not the complete source repository. The modification makes the local `LicenseManager.isActivated()` return `true`; it does not issue a server-side license or change remote authorization records. No ownership or relicensing rights over third-party software are claimed.

## Download

[Download the prerelease and SHA-256 checksum](https://github.com/yangshulin2333/tdm-fast-modified-test/releases/tag/v1.0.0-test.1)

Choose `TDM-Fast-1.0.0-modified-test.zip`. Read the known issues before use.

## Usage

1. Fully exit all TDM Fast processes, including the system tray app.
2. Extract the entire ZIP into a new writable folder. Do not overwrite the original installation or run directly inside the archive.
3. Run `Launch.cmd`. It stores a separate profile in `UserData`. Check the download destination on first launch.
4. Do not run the original and modified apps concurrently: both use local port `37651`.

### Optional Chrome extension

Open `chrome://extensions/`, enable Developer mode, select Load unpacked, and choose `resources/extension` inside the extracted folder. Start the desktop app and refresh the target page. The complete Chrome extension download workflow has not been tested.

### Restore the original build

Exit the app and run `Restore-original.cmd`. It restores the bundled original `app.asar`, including its activation requirement, while retaining profile and downloaded files. The original uninstaller is excluded.

## Validation and known issues

Results are from tests on September 9, 2026; they do not establish support for every website or environment.

| Check | Result |
| --- | --- |
| Modified Electron app startup | Passed |
| Local HTTP download of an 8 MiB file | Completed with matching SHA-256 |
| Pause/resume within one running process | Passed |
| Video parsing/download from a self-hosted page | Completed with matching hash |
| Local activation flag, settings and tasks after app restart | Retained |
| Restore original ASAR | Exact hash restored; original activation restriction restored |
| **Resume unfinished downloads after restarting the app** | **Failed: may falsely report completion and produce corrupt files. Also reproduced with the original engine. Start a fresh download instead.** |
| Simulated mandatory update | Window hidden but process remained after 10 seconds. Update logic remains; stability is unconfirmed. |

Windows reboot, public video sites, the complete Chrome extension workflow, long-duration operation, and future update compatibility were not verified. The archive includes a detailed Chinese report in `FULL_VERIFICATION.md`.

## Checksum

```powershell
Get-FileHash .\TDM-Fast-1.0.0-modified-test.zip -Algorithm SHA256
```

Expected SHA-256:

```text
af8f1dd47dd260de9e94a14b047312d575ebb164bff0657bed34b23fd1eda364
```

The archive contains runtime files, an isolated launcher, an original ASAR restore copy, modification differences and test records. It excludes the test user profile. Test records may contain local paths from the test machine.
