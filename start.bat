@echo off
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 22 is not installed.
  echo Install it from https://nodejs.org/ or use Docker Desktop instead. See README.md.
  pause
  exit /b 1
)

if not exist ".env" (
  echo Copy .env.example to .env first, then put in the same password as dogecoin.conf.
  pause
  exit /b 1
)

echo Starting the indexer. Leave this window open.
echo When it is ready, open http://127.0.0.1:8080/health in a browser.
node --disable-warning=ExperimentalWarning --experimental-sqlite --experimental-strip-types src/index.ts
pause
