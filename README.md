# TV Mode for Steam Big Picture

<img width="3840" height="2160" alt="image" src="https://github.com/user-attachments/assets/9ef36076-30d0-446e-8004-10917ba7991e" />

**Your whole library on your PC. Just the good stuff on your TV.**

TV Mode is a [Millennium](https://steambrew.app) plugin that turns Steam Big
Picture into a clean, curated living-room console. You decide what the TV shows
from your desk using ordinary Steam collections — the couch gets a tidy carousel
of exactly those games, and nothing else.

It runs on **your own Steam account**, so every achievement you unlock on the TV
counts toward your profile.

---

## Who it's for

**You're tired of scrolling.** Hundreds of games, demos, tools and that one
puzzle game from a 2019 bundle — Big Picture shows all of it. TV Mode shows a
handful of games you actually want to play on the couch.

**You want to control what's on the TV.** Maybe it's a shared living room,
maybe it's the kids' gaming time, maybe you just don't want the store, the
friends feed and your 400-hour grind on the big screen. You pick the games;
everything else is out of reach.

**You still want your achievements.** Separate "TV accounts" and family-sharing
tricks mean progress lands on the wrong profile. TV Mode doesn't change
accounts — it changes what Big Picture shows.

---

## How it works

1. **On your PC**, create Steam collections whose names start with `TV`
   — for example `TV - Singleplayer`, `TV - Co-op`, `TV - Backlog`.
2. **On the TV**, open Big Picture. TV Mode replaces the home screen with a
   carousel of just those collections.
3. **Add or remove games from your PC whenever you like.** The TV picks up the
   changes automatically.

---

## Features

### A home screen built for the couch
- One row per TV collection; **left/right** through games, **up/down** between
  collections.
- The focused game's artwork fills the background with a slow, subtle drift.
- Achievement progress under each game, with a gold treatment for 100% games.
- Remembers where you were when you come back from a game.

### A calmer game page
- Game logo, a big **Play** button, and quick access to **controller layout**,
  **properties** and the developer's **latest updates**.
- An achievements card that opens Steam's own achievements page.
- No playtime, no "last played", no friend activity, no community feed.

### Locked down, not dumbed down
- Home, Store, Community, Friends, search and any game outside your TV
  collections simply bounce back to the TV home.
- **Settings** is trimmed to what a TV needs: System, Internet, Storage,
  Display, Audio, Controller, Keyboard, Customization and Accessibility.
- The **Steam button menu** is trimmed to Downloads, Settings and Power.
- Big Picture's top and bottom bars are hidden. Only the time remains, with a
  small warning icon if the internet or controller drops.

### Desktop lock (optional)
- While TV Mode is on, desktop Steam shows a lock screen until an unlock code is
  entered — so the TV PC can't wander back into the full library.
- You set the code the first time it appears. Only a hash of it is stored.

---

## Requirements

- Windows with the Steam desktop client (Big Picture)
- [Millennium](https://steambrew.app) 3.4 or newer
- [Bun](https://bun.sh) to build the plugin

---

## Installation

```powershell
git clone https://github.com/Zach-Houston/steam-tv-mode.git
cd steam-tv-mode
bun install
bun run build    # builds and installs into Millennium automatically
```

Then open Millennium's settings in Steam, enable **TV Mode** under **Plugins**,
and restart Steam.

> **Folder location:** the plugin's backend currently expects the project at
> `<Steam>\millennium\themes\steam-tv-mode` for its log file, saved icons and
> lock-reset file. If you clone it elsewhere, update the paths in
> `backend/log_file.lua`.

**Developing?** `reload.cmd` closes Steam, rebuilds the plugin and reopens
straight into Big Picture.

---

## FAQ

**Do achievements still count?**
Yes. TV Mode runs on your normal account; it only controls what Big Picture
displays.

**Can someone get around the lockdown?**
TV Mode keeps the TV experience tidy and on-rails, but it's not a security
product. Anyone with access to the PC's keyboard and your unlock code — or the
ability to disable Millennium — can reach the full client.

**I forgot my unlock code.**
Create an empty file named `reset-lock` in the project folder and restart Steam.
You'll be asked to set a new code.

**Where do the Steam-style icons come from?**
The achievement, controller and settings glyphs are copied from your own Steam
client the first time they appear on screen and saved locally in `icons/`.
They're not distributed with this repository.

**Something looks off after a Steam update.**
TV Mode relies on Steam's internal, undocumented UI, so updates can occasionally
break parts of it. A runtime log is written to `tvmode.log` in the project
folder — it's the first place to look.

**How do I turn it off?**
Disable **TV Mode** in Millennium's plugin settings and restart Steam.

---

## Contributing

Issues and pull requests are welcome. Please include the relevant lines from
`tvmode.log` (check them for anything personal first — the log can include game
names and your PC's hostname).

---

*Not affiliated with or endorsed by Valve Corporation. Steam and Steam Big
Picture are trademarks of Valve Corporation.*
