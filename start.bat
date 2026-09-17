@echo off
chcp 65001 >nul
cd /d %~dp0
echo ==============================================
echo   家庭医学存档 正在启动...
echo   关闭本窗口或按 Ctrl+C 即可停止服务
echo ==============================================
node server.js
pause
