# Humble Library

**Your bundles. Your keys. All in one place.**

An unofficial Windows desktop client for your Humble Bundle library. Browse purchased bundles, reveal and copy keys, and export them to TXT or CSV. Supports the platforms returned by Humble, including games, software and asset licenses.

[Project website](https://merrygrim.github.io/HumbleLibrary/) · [Download for Windows](https://github.com/MerryGrim/HumbleLibrary/releases/latest) · [Report an issue](https://github.com/MerryGrim/HumbleLibrary/issues)

**По-русски:** клиент библиотеки Humble Bundle для Windows. Бандлы с обложками, раскрытие и копирование ключей, экспорт в TXT/CSV. В приложении и установщике доступны русский и ещё восемь языков. Скачать установщик или portable-версию можно в [релизах](https://github.com/MerryGrim/HumbleLibrary/releases/latest).

## Get started

1. Download **HumbleLibrary-0.2.2-Setup-Windows-x64.exe** from the [latest release](https://github.com/MerryGrim/HumbleLibrary/releases/latest), or extract the portable ZIP to its own folder.
2. Run the installer or `HumbleLibrary.exe`. The MiraUI installer works for the current Windows user without administrator privileges. A desktop shortcut is optional.
3. Choose **Sign in to Humble**. A separate window opens the official Humble website. Complete your usual sign-in, including two-factor authentication or CAPTCHA if requested.
4. After sign-in is confirmed, the window closes and your library refreshes. Closing it early cancels the attempt without reopening the window.

Requires **Windows 10 version 2004 (build 19041) or later, x64, and Microsoft Edge WebView2 Runtime**. Development tools are not needed to use the app.

## What it does

- A single library of purchased bundles, with available cover art fitted without cropping.
- Search and persistent sorting by purchase date or title. Newest purchases appear first by default.
- Every key platform returned by Humble, not only Epic/Fab.
- Reveal one key or a bundle, copy individual keys, or export a selection.
- TXT for plain key lists; CSV for names, platforms, values, states and instructions.
- Separate official sign-in window with user-controlled 2FA/CAPTCHA.
- Light and dark themes, keyboard navigation and dismissible notifications with a copy-text action.
- Nine languages in both the app and installer: **Русский, English, Deutsch, Italiano, Español, Français, 简体中文, 日本語, 한국어**. System-language selection is also available.
- Signed updates delivered through GitHub, for installed and portable copies.

The [website](https://merrygrim.github.io/HumbleLibrary/) includes an interactive illustration with fictional bundles. It contains no account data or real keys.

## Keys and exports

Open a bundle to see its items. Reveal keys individually or use **Reveal all**. **Reveal and export** handles keys that have not been revealed yet. Stopping a queue prevents subsequent reveals; completed results remain in the library.

| Format | Contents |
| --- | --- |
| TXT | Revealed key values, one per line, without names or exact duplicates. Leading and trailing whitespace is removed; case and internal characters are preserved. |
| CSV | All selected items, with names, platforms, original key values, states and instructions. Structured licenses are preserved as compact JSON. |

**Revealed does not mean activated.** The app does not activate keys on other platforms or infer whether they have been redeemed. Items requiring a publisher website retain their instructions and link.

For Unreal Manager, export only compatible Epic/Fab keys. Its TXT import accepts up to 100 unique keys at a time; a mixed-platform TXT export is an archive, not a universal activation file.

A reveal request with an uncertain network result is not retried automatically. Refresh the library before trying again.

## Privacy & data

Your Humble session and library data stay on your computer. Sign-in takes place on Humble's official website in a dedicated window, which may navigate to `auth.humblebundle.com` for authentication. Passwords and two-factor codes are entered on that website; the application does not provide its own credential form. Privileged app operations (IPC) are enabled only on `www.humblebundle.com`; the authentication host is not permitted to run library, key or export commands. Session files use a dedicated WebView2 profile. The local library cache, including cached keys, is protected with Windows DPAPI for the current Windows user.

| Edition | Local data location |
| --- | --- |
| Installed | `%LOCALAPPDATA%\HumbleLibrary\Data` |
| Portable | `Data` beside `HumbleLibrary.exe` |

Exports are ordinary local files saved where you choose. They contain your keys; keep them private. Do not share the `Data` folder. Release archives contain application files only, without account data or signing secrets.

Uninstalling preserves local user data. Updates preserve the library, session and settings.

A cached library is not proof of an active session. The app distinguishes an unverified session, a confirmed connection and an authentication failure. Ordinary network errors do not sign you out.

## Updates

The default channel is **MerryGrim/HumbleLibrary** on GitHub. Automatic checking runs at startup at most once per day; manual checking is available in Settings. A saved disabled setting or custom repository is preserved. **Download and install** remains a user action.

Before installing, the app verifies an ECDSA P-256/SHA-256 manifest signature, the release version and repository, file sizes and SHA-256 hashes. The updater replaces only the executable and its three accompanying documents. User data and installer files are preserved; a failed restart triggers rollback.

Do not rename `HumbleLibrary.exe` or remove its installation marker. Installing an update is unavailable during an active operation or sign-in.

## Navigation

**All bundles**, **Alt+Left**, or the app title returns to the library. **Escape** closes menus and dialogs. **Tab/Shift+Tab** navigates controls. Returning from a bundle restores focus to its tile.

Static text is not selectable. Revealed keys have a dedicated copy action and context menu, also accessible with **Shift+F10**. Notifications close after eight seconds; hovering or focusing pauses their timer. Each notification has a close button and a copy-text action.

## Build from source

The application uses **Tauri 2, Rust, React, TypeScript and Vite**. On Windows, install Node.js, Rust with the MSVC toolchain, Visual Studio C++ Build Tools, the Windows SDK and WebView2 Runtime.

```powershell
cd source
npm ci
npm run tauri -- build --no-bundle -- --locked
```

The native executable is produced in `source/src-tauri/target/release/`. The repository's `Build-HumbleLibrary.cmd` and `source/BUILD-ENV.ps1` are maintainer conveniences configured for tools under `D:\AI\Tools`; adjust those paths for your machine or use the commands above.

The MiraUI setup additionally requires **PowerShell 7 and Inno Setup 7**. See [installer/README.md](installer/README.md) for packaging and isolated installer checks. The GitHub Pages site in `docs/` is static HTML/CSS/JavaScript and requires no build.

### Checks

From the repository root:

```powershell
node verification/test-key-export.cjs
node verification/test-humble-protocol.cjs
cargo test --release --locked --offline --lib --manifest-path source/src-tauri/Cargo.toml
```

The offline Rust command requires dependencies to have been fetched by a prior build. Browser tests use synthetic preview data, separated from production profiles. `verification/test-library-ui.cjs` accepts the local Vite URL as its first argument. Preview mode (`?preview=1`) is available in an ordinary browser and is disabled in the native application.

Release preparation uses `source/PACKAGE-PORTABLE.ps1`, `installer/build-installer.ps1`, `source/PREPARE-UPDATE.ps1` and `verification/Package-Source.ps1`. Signing material in `.release-secrets/` is private and excluded from Git and release archives. `CREATE-UPDATE-KEY.ps1` is only for the initial creation of a new application's signing key; do not replace an existing key when preparing an update.

## Status & license

Humble Library is an **independent, unofficial project**, not affiliated with or endorsed by Humble Bundle. Humble may change its website or access requirements. Platform names and trademarks belong to their owners.

Licensed under [MIT](LICENSE). Dependency and installer notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
