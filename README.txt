Limiter, quick start
--------------------

Limiter is a small widget that sits on your Windows desktop. It shows how much is left of your
Codex, Claude Code, Grok and Antigravity allowances, which of your projects used them this week, and free disk space.

What you need
1. Windows 10 or 11 (64-bit). Download the zip that matches your PC:
   - "x64" for standard Windows PCs (Intel or AMD, "x64-based processor" in Settings > System > About)
   - "arm64" for ARM Windows PCs (for example Snapdragon, "ARM-based processor")
   The x64 zip does not start on an ARM PC; it shows where to download the ARM64 zip instead.
2. For the Codex tile: the Codex CLI installed and signed in (Limiter finds codex.exe; you can also pick it in Settings).
3. For the Claude Code tile: Claude Code used on this PC. Its local logs are read; nothing is sent anywhere.
4. Optional, for the Grok tile: a signed-in grokcli folder and Python on the PATH.
5. Optional, for Antigravity tiles: Antigravity installed and running on this PC (hidden automatically otherwise).
   Each model group shows weekly quota on the outer ring and 5-hour quota on the inner ring.
6. Optional, for a second disk tile: an SSH host you already use, set up in your SSH config with a trusted host key.

Install
1. Unzip this folder anywhere you like, for example in your Documents folder. Keep every file together.
2. Double-click Limiter.exe.
3. Windows may say "Windows protected your PC" because the app is not signed. Select "More info", then "Run anyway".
4. Limiter opens Settings the first time. Set your projects folder, and your grokcli folder if you use Grok.
5. To start Limiter when you sign in to Windows, tick "Start with Windows" in Settings.

Use
1. Select any ring tile to see details, such as exact percentages, reset times, and the top five projects of the week.
2. Drag the title bar to move the widget, or drag any edge or corner to resize; the rings scale with the window.
3. Select the dots button (top right) for Settings.
4. Limiter lives behind your open windows. Press Windows+D to see it, or double-click its tray icon.
5. Quit from the tray icon menu.

Privacy
Limiter reads local files on this PC (Claude Code and Codex logs), the quota that the Codex CLI and grokcli report,
and Antigravity's local language server on 127.0.0.1 (using the port and per-process request token from
~/.gemini/antigravity/daemon/hub_*.json; that token is never stored, logged or sent elsewhere, and the quota summary
carries no account profile fields).
If you add a remote disk, it runs one read-only disk-space command on that host over your own SSH setup.
It never reads, stores or renews your account sign-in tokens and sends no usage data anywhere.

Uninstall
1. Quit Limiter from the tray icon, and turn off "Start with Windows" first if you turned it on.
2. Delete the Limiter folder you unzipped.
3. Delete the folder %USERPROFILE%\.local\share\Limiter to remove its settings.
4. Delete the shortcut %APPDATA%\Microsoft\Windows\Start Menu\Programs\Limiter.lnk, which Limiter adds so Windows can show its alerts.
