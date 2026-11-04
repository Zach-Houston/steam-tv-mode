@echo off
setlocal
rem Commit and push TV Mode changes to Zach-Houston/steam-tv-mode.
rem Uses your own git/GitHub login. Commits use GitHub's no-reply address, not your email.
rem Pulls in anything changed on GitHub first (e.g. README edits made there).
rem Usage: push.cmd ["commit summary"]
cd /d "%~dp0"
where git >nul 2>&1 || (echo Git is not installed: https://git-scm.com/download/win & pause & exit /b 1)
set "MSG=%~1"
if "%MSG%"=="" set "MSG=Update TV Mode"
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
