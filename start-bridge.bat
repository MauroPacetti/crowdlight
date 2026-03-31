@echo off
title CrowdLight ArtNet Bridge
echo ============================================
echo   CrowdLight ArtNet Bridge - Setup
echo ============================================
echo.

:: Configura qui i tuoi parametri
set CROWDLIGHT_URL=https://crowdlight.onrender.com
set CROWDLIGHT_PASS=crowdlight2024
set ARTNET_UNIVERSE=0
set ARTNET_START_CHANNEL=1

echo Server:     %CROWDLIGHT_URL%
echo Universe:   %ARTNET_UNIVERSE%
echo Start CH:   %ARTNET_START_CHANNEL%
echo.
echo Avvio bridge...
echo.

node artnet-bridge.js

pause
