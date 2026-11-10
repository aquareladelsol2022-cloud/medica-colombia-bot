@echo off
cd /d "%~dp0"
echo ======================================================
echo   MEDICA COLOMBIA S.A.S. - BOT DE WHATSAPP IA (2026)
echo   Simulador Web: http://localhost:3085
echo ======================================================
start http://localhost:3085
npm run dev
pause
