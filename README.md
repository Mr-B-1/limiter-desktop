# Limiter

A small Windows desktop widget that shows how much is left of your Codex, Claude Code, Grok and Antigravity allowances, which of your projects used them this week, and free disk space.

## Download

Get the zip from the [latest release](https://github.com/Mr-B-1/limiter-desktop/releases/latest), unzip it anywhere, and run `Limiter.exe`. The included `README.txt` walks through setup.

| Your PC | Download |
|---|---|
| Most Windows 11 PCs (Intel or AMD) | `Limiter-<version>-windows-x64.zip` |
| ARM PCs (for example Snapdragon) | `Limiter-<version>-windows-arm64.zip` |

To check which one you have, open **Settings**, **System**, **About**, and read **System type**. The x64 zip does not run on an ARM PC; it says so and points you to the ARM64 zip. Each release has a `SHA256SUMS.txt` to check the download.

The app is not code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time. Select **More info**, then **Run anyway**.

## What it shows

| Row | Source |
|---|---|
| Codex | The account quota that your signed-in Codex CLI reports |
| Claude Code | Claude Code's own figures through the optional mod in this repository's `mods/limiter-usage` folder (not in the zip), or an estimate from local Claude Code logs |
| Grok | Your SuperGrok allowance through a signed-in grokcli folder (hidden until you set one) |
| Antigravity | Model-pool quota read from Antigravity's local language server while it is running (hidden when not installed) |
| Disk | Free space on this PC's system drive, plus an optional second disk read over SSH |
| Projects | Inside the Claude Code and Codex details: the top five projects of the current window, by share of price-weighted use |

## Settings

Open Settings with the dots button. You can set:

1. **Projects folder**: its first-level folders become project names. Without it, each session counts under its own folder name.
2. **grokcli folder**: shows the Grok row.
3. **Disk names** and a **remote SSH host** for a second disk row. Only a plain host name from your SSH config is accepted.
4. **Start with Windows**: adds a per-user sign-in entry.

## Privacy

Limiter reads local files on your PC and the quota reported by the Codex CLI, grokcli, and Antigravity's local language server on `127.0.0.1`. For Antigravity, it reads the loopback port and per-process request token from `~/.gemini/antigravity/daemon/hub_*.json` solely to query that local server; that token is never stored, logged, or sent elsewhere, and account profile fields in the reply are discarded. A remote disk, if you add one, is read with one read-only command over your own SSH setup. Limiter never reads, stores, or renews account sign-in tokens and sends no usage data anywhere.

## Build from source

Requires Windows 11 (x64 or ARM64) and Node 24. Each command targets your own PC type unless you add `--arch=x64` or `--arch=arm64`. A GitHub Actions workflow in `.github/workflows/windows.yml` builds, tests and smoke-tests the x64 build on a GitHub x64 runner.

```bash
node tools/build.mjs setup
```

```bash
node tools/build.mjs test
```

```bash
node tools/build.mjs package
```

```bash
node tools/packaged-smoke.mjs
```

## Licence

MIT, see [LICENSE](LICENSE).
