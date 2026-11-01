@echo off
cd /d "%~dp0"
chcp 65001 >nul
where node >nul 2>nul || (echo Please install Node.js first: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (call npm install --omit=dev)
node server.js
pause
