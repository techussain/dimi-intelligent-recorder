# Privacy notice

_Dimi Intelligent Recorder · last updated November 2026_

Everything happens on your computer. The app has no account, analytics, telemetry or tracking,
and your recordings are never uploaded.

## What the app stores

- **Recordings folder:** your recordings, merged clips and exports, as normal files. By default
  `Videos\Dimi Intelligent Recorder` (Windows) or `Movies/Dimi Intelligent Recorder` (macOS).
- **App data folder:** working copies of media, projects and autosaves, recent projects, the
  speech model, settings, and local logs and crash reports.
- **Files you save yourself** (`.irproj`, `.irbundle`) go wherever you choose. An `.irbundle`
  contains all of a project's media, so share it with the same care as the recordings.

## When the app goes online

1. **Speech model, once.** The first time you transcribe, the app asks before downloading the
   Whisper model (about 77 MB) from Hugging Face (`huggingface.co`, `hf.co`). Like any download,
   this shows Hugging Face your IP address and the app's user agent. No audio, transcript or
   project data is sent. ([Hugging Face privacy policy](https://huggingface.co/privacy))
2. **Update checks** (installed app only). The app checks GitHub Releases for new versions. This
   shows GitHub your IP address and the app's user agent, and nothing about your recordings.
   ([GitHub privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement))

There are no other network connections.

## Logs and crash reports

Logs and crash reports stay in the app data folder (**Help → Open Logs Folder**). They are only
sent if you attach them to a bug report yourself. A crash report can contain fragments of file
names or on-screen text, so check it before you send it.

## Permissions

Screen, microphone and camera access are used only to record what you choose. You can turn
them off in your system's privacy settings at any time.

## Deleting your data

- **Recordings:** delete the recordings folder and any project files or exports you saved.
- **App data:** uninstall the app, then delete its data folder:
  Windows `%APPDATA%\Dimi Intelligent Recorder`,
  macOS `~/Library/Application Support/Dimi Intelligent Recorder`,
  Linux `~/.config/Dimi Intelligent Recorder`.

## Changes and contact

If this notice changes, the date above and the release notes will say so. Questions: open an
issue at <https://github.com/techussain/dimi-intelligent-recorder/issues>, or for anything sensitive,
[report it privately](https://github.com/techussain/dimi-intelligent-recorder/security/advisories/new).
