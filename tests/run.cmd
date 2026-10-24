@echo off
chcp 65001 >nul
setlocal

rem =====================================================================
rem  wxapp 测试入口
rem ---------------------------------------------------------------------
rem  需要一个可执行的 Node 运行时。本机没有独立安装 Node 时，
rem  直接用微信开发者工具内嵌的 Electron（它有完整的 Node 22 运行时）。
rem  换机器时把 WB_NODE 指向任意 node.exe 即可，脚本逻辑不变。
rem =====================================================================

if not defined WB_NODE set "WB_NODE=D:\DownloadsD\微信web开发者工具\微信开发者工具.exe"

if not exist "%WB_NODE%" (
  echo [错误] 找不到 Node 运行时："%WB_NODE%"
  echo         请设置环境变量 WB_NODE 指向 node.exe 或微信开发者工具主程序。
  exit /b 1
)

set "ELECTRON_RUN_AS_NODE=1"
set "NODE_OPTIONS="
"%WB_NODE%" "%~dp0run.mjs" %*
set "CODE=%ERRORLEVEL%"
endlocal & exit /b %CODE%
