@echo off
title Smoky
cd /d "%~dp0"
if not exist "node_modules\.bin\electron.cmd" (
  echo Electron is not installed yet - running npm install...
  call npm install
)
start "" "node_modules\.bin\electron.cmd" .
