@echo off
rem Publish TV Mode to GitHub as Zach-Houston/steam-tv-mode (private).
rem Uses your own git/GitHub login. Commits use GitHubs no-reply address, not your email.
cd /d "%~dp0"
where git >nul 2>&1 || (echo Git is not installed: https://git-scm.com/download/win & pause & exit /b 1)
if not exist .git git init -b main
git add -A
echo.
echo Files that will be committed:
git diff --cached --name-only
echo.
git -c user.name="Zach-Houston" -c user.email="Zach-Houston@users.noreply.github.com" commit -q -m "TV Mode: locked-down Big Picture for the TV (Millennium plugin)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01JgyaRQjxq1QaBpEJLZz5Yk" || echo Nothing new to commit.
where gh >nul 2>&1 || goto manual
gh auth status >nul 2>&1 || gh auth login
git remote get-url origin >nul 2>&1 && (git push -u origin main) || (gh repo create Zach-Houston/steam-tv-mode --private --source . --remote origin --push)
echo.
echo Done: https://github.com/Zach-Houston/steam-tv-mode
pause
exit /b 0
:manual
echo.
echo GitHub CLI not found. Create an empty PRIVATE repo named steam-tv-mode at https://github.com/new
echo (no README/license), then run:
echo   git remote add origin https://github.com/Zach-Houston/steam-tv-mode.git
echo   git push -u origin main
pause
