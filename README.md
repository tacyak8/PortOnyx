# Port Onyx

A walled launcher for local apps. Port Onyx is a small Windows desktop app that puts your local tools (ComfyUI, KoboldCpp, or anything that serves a page on localhost) behind one dark home screen, each in its own isolated browser profile.

<!-- Add a screenshot here, for example docs/screenshot.png -->

## What it does

- **One tile per app.** Click a tile and Port Onyx starts the program (an `.exe`, `.bat` or `.cmd`), waits for its local address to answer, and opens it in a tab.
- **Isolated profiles.** Every app gets its own cookies, storage and cache. Clear cache, cookies, local storage, or everything, per app, without touching the others.
- **Localhost-only tabs.** Pages in the tabs can only talk to `127.0.0.1` and `localhost`. Links and requests to anywhere else are blocked.
- **Add apps without code.** The **+** tile takes a name, launch file, arguments, working folder, URL, icon and highlight color.
- **Start and stop.** Each tile shows its status, and Stop ends the program and everything it started.
- **Notes.** A built-in plain-text notes tab with categories (plain folders), search, autosave and a trash folder.
- **Password gate.** A password at startup, a Lock button, and auto-lock after 15 minutes idle.

## Requirements

- Windows 10 or 11
- [Node.js](https://nodejs.org) (LTS)

## Install and run

```
npm install
npm start
```

If npm reports that Electron's install script was blocked, run this once, then start again:

```
node node_modules/electron/install.js
npm start
```

You choose a password on first launch. `start-portonyx.bat` is a double-click launcher.

## Adding an app

Use the **+** tile. What you fill in decides the tile type:

- **URL only:** opens the address in a tab.
- **Launch file only:** starts the program and tracks it.
- **Both:** starts the program, waits for the URL to answer, then opens the tab.

Each app is stored as `apps/<name>/app.json`:

```json
{
  "name": "KoboldCpp",
  "launch": "C:\\Tools\\KoboldCpp\\koboldcpp.exe",
  "url": "http://127.0.0.1:5001",
  "accent": "#6ea8ff",
  "icon": "icon.png"
}
```

Output from `.bat` and `.cmd` launches is written to `apps/<name>/launch.log`.

## Security notes

- The localhost wall applies to the **browser tabs only**. Programs that Port Onyx launches (and anything they install or download) have normal network access. Use a firewall for those.
- The password gate keeps casual access out. It does not encrypt anything. Use BitLocker or an encrypted vault such as Cryptomator for data at rest. The notes folder can be pointed at a vault drive.
- Port Onyx contains no telemetry and no update checks of its own. Electron bundles its own Chromium, so run `npm update electron` now and then.

## Your data stays local

`userdata/` (password hash, browser profiles, settings), `notes/` and `apps/` are created next to the app and are excluded by `.gitignore`.

## Status

A personal project built for one setup. It is Windows only and may have rough edges.
