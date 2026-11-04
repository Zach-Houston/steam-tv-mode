@echo off
setlocal
rem Commit and push TV Mode changes to Zach-Houston/steam-tv-mode.
rem Uses your own git/GitHub login. Commits use GitHub's no-reply address, not your email.
rem Pulls in anything changed on GitHub first (e.g. README edits made there).
rem Usage: push.cmd ["commit summary"]
cd /d "%~dp0"
where git >nul 2>&1 || (echo Git is not installed: https://git-scm.com/download/win & pause & exit /b 1)
set "MSG=%~1"
if "%MSG%"=="" set "MSG=Install/download states, running screen, achievements restyle, Steam menu and Updates fixes"
set "AUTHOR=-c user.name=Zach-Houston -c user.email=Zach-Houston@users.noreply.github.com"

git fetch -q origin
git add -A

rem Everything not yet on GitHub (earlier unpushed commits plus new changes) goes out as one commit.
for /f %%b in ('git merge-base HEAD origin/main') do set "BASE=%%b"
git reset -q --soft %BASE%
echo.
echo Files changed since the last push:
git diff --cached --name-status
echo.
git diff --cached --quiet
if errorlevel 1 (
	git %AUTHOR% commit -q -m "%MSG%" ^
 -m "- Game page: Install button (outline) for games not installed on this PC, download progress (queued/downloading/paused/installing), Launching/Playing state, Steam's install pop-up without its game page behind it" ^
 -m "- Carousel: status line for downloads / Not Installed / Playing, wrap-around between collections, faster camera, instant return to the last game, TV prefix dropped from collection names" ^
 -m "- Game page: smaller achievements card without View all; Updates with images, remembered position, B closes panels and returns focus to Updates" ^
 -m "- Steam achievements page (Big Picture and in-game overlay): TV styling, rarity colours, no Compare to / search boxes / avatar / playtime, controller can't reach hidden boxes" ^
 -m "- Steam menu: in-game entry reachable, game options trimmed (View game details, Guides, Notes, Game Recording); hidden text boxes disabled so the keyboard can't pop up" ^
 -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" ^
 -m "Claude-Session: https://claude.ai/code/session_01JgyaRQjxq1QaBpEJLZz5Yk"
) else (
	echo Nothing new to commit.
)

git %AUTHOR% pull -q --rebase origin main || (echo. & echo Could not merge the GitHub changes automatically. Run: git status & pause & exit /b 1)
git push origin main || (echo. & echo Push failed. If GitHub asks you to sign in, run: gh auth login & pause & exit /b 1)
echo.
echo Done: https://github.com/Zach-Houston/steam-tv-mode
pause
