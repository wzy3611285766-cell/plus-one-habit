@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================================
echo   PLus one habit 小程序 - 提交并推送到 GitHub
echo   仓库：plus-one-habit
echo   目录：%~dp0
echo ============================================================
echo.

rem ---- 1. 代理探活（remote 和 post-commit 钩子都走 127.0.0.1:7897）----
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',7897);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
if errorlevel 1 (
  echo [警告] 本地代理 127.0.0.1:7897 连不上，GitHub 大概率推不上去。
  echo        请先打开 Clash 等代理软件，再双击本快捷方式。
  echo.
  set /p "GOON= 还是继续试一次？输入 y 回车继续，直接回车退出： "
  if /i not "!GOON!"=="y" goto :end
  echo.
)

rem ---- 2. 当前分支 ----
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set BRANCH=%%b
if "!BRANCH!"=="" (
  echo [错误] 这个目录不是 Git 仓库，或者 git 命令不可用。
  goto :end
)
echo 当前分支：!BRANCH!
echo.

rem ---- 3. 有改动就先提交 ----
set HASCHANGE=0
for /f "delims=" %%l in ('git status --porcelain') do set HASCHANGE=1

if "!HASCHANGE!"=="1" (
  echo 本次要提交的改动：
  git status --short
  echo.
  set /p "MSG= 提交说明（直接回车＝自动写成「更新 日期 时间」）： "
  if "!MSG!"=="" (
    for /f "delims=" %%t in ('powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm'"') do set MSG=更新 %%t
  )
  echo.
  echo [1/2] 提交中…
  git add -A
  git commit -m "!MSG!"
  if errorlevel 1 (
    echo.
    echo [错误] 提交没成功，本地文件没被动过。把上面几行发给助手看看。
    goto :end
  )
  echo.
) else (
  echo 没有新的改动，只检查有没有还没推上去的提交…
  echo.
)

rem ---- 4. 推送 ----
echo [2/2] 推送到 origin !BRANCH! …
git push origin "!BRANCH!"
if errorlevel 1 (
  echo.
  echo [失败] 推送没成功，但本地提交都在，不会丢。
  echo        常见原因：代理没开、网络抖动、或远程有别人的新提交。
  echo        如果是远程有新提交，先执行 git pull --rebase 再双击一次。
  goto :end
)

rem ---- 5. 核对结果 ----
for /f "delims=" %%i in ('git rev-list --count "origin/!BRANCH!..HEAD" 2^>nul') do set AHEAD=%%i
echo.
echo ============================================================
if "!AHEAD!"=="0" (
  echo  已同步：本地和 GitHub 上都是最新。
  echo  最新提交：
  git --no-pager log --oneline -1
) else (
  echo  注意：还有 !AHEAD! 个提交没推上去，请把窗口内容发给助手。
)
echo ============================================================

:end
echo.
pause
