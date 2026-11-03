# TV Mode for Steam Big Picture

A [Millennium](https://steambrew.app) plugin that turns Steam Big Picture into a
locked-down, couch-friendly "TV mode". You curate what the TV shows from your PC
using ordinary Steam collections; the TV only ever shows those games.

## What it does

- **TV home** — a custom carousel of your `TV …` collections (one row per
  collection, up/down to switch). The focused game's hero art fills the
  background. No playtime or last-played anywhere.
- **TV game page** — logo, Play, controller layout, properties and the game's
  official updates, plus an achievements card that opens Steam's own
  achievements page. Completed games get a gold treatment.
- **Lockdown** — Home, Store, Community, Friends, search and every game outside
  your TV collections redirect back to the TV home. Settings is trimmed to
  System, Internet, Storage, Display, Audio, Controller, Keyboard,
  Customization and Accessibility. The Steam button menu is trimmed to
  Downloads, Settings and Power.
- **Clean chrome** — Big Picture's top and bottom bars are hidden; only the time
  shows (top-right), with an icon when there's no internet or no controller.
- **Desktop lock** — while TV mode is on, desktop Steam shows a lock screen until
  an unlock code is entered (set on first use; only a hash is stored).

Achievements stay on your own account — this runs on your account, it just
controls what Big Picture shows.

## Setup

1. Install [Millennium](https://steambrew.app) (≥ 3.4) and [Bun](https://bun.sh).
2. In Steam on your PC, create collections whose names start with `TV`
   (e.g. `TV - Singleplayer`, `TV - Backlog`). Dynamic collections work too.
3. Build and install:

   ```powershell
   bun install
   bun run build      # installs into Millennium automatically
   ```

4. Enable **TV Mode** in Millennium's plugin settings and restart Steam.

`reload.cmd` (Windows) closes Steam, rebuilds and reopens straight into
Big Picture — handy while iterating.

> The backend currently expects the project folder at
> `<Steam>/millennium/themes/steam-tv-mode` (for its log file, saved icons and
> the lock-reset file). Adjust the paths in `backend/log_file.lua` if you keep
> it elsewhere.

## Notes

- Steam's own achievement/controller/settings glyphs are copied from your
  local Steam client at runtime into `icons/` (git-ignored); they are not
  distributed with this repo.
- Forgot the unlock code? Create an empty file named `reset-lock` in the project
  folder and restart Steam.
- Runtime log: `tvmode.log` in the project folder (git-ignored).
- This relies on Steam's internal, undocumented UI; Steam updates can break
  parts of it.

Not affiliated with or endorsed by Valve. Steam and Steam Big Picture are
trademarks of Valve Corporation.
