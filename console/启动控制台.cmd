@echo off
title Agent Autoloop 控制台
cd /d "%~dp0"
echo 正在启动控制台，浏览器马上打开...
start "" http://127.0.0.1:3360
"C:\Users\13694\nodejs\node.exe" server.mjs
pause
