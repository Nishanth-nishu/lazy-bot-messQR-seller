@echo off
rem Double-click to start the mess bot in its own window (auto-restarts, logs to logs\).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-bot.ps1"
