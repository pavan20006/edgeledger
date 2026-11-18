@echo off
title Ledger - trading journal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found on this computer.
  echo Install Node.js 22.5 or newer from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

node server.js --open
if errorlevel 1 (
  echo.
  echo The journal stopped. Read the message above, then close this window.
  pause
)
