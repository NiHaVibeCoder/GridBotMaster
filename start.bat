@echo off
title Grid Bot Backtester
cd /d "%~dp0"
set PORT=8080

where python >nul 2>&1
if errorlevel 1 (
    echo Python nicht gefunden - oeffne index.html direkt im Browser.
    start "" "%~dp0index.html"
    exit /b
)

echo Grid Bot Backtester laeuft auf http://localhost:%PORT%
echo Dieses Fenster schliessen, um den Server zu beenden.
echo.

rem Browser kurz verzoegert oeffnen, damit der Server bereit ist.
start "" /b cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%"

python server.py %PORT%
