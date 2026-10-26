@echo off
rem dsh-upgrade setup: unpack-and-run installation for a Windows machine.
rem ASCII only: cmd.exe reads this file in the console code page.
rem
rem usage: setup.cmd [root-dir]
rem   root-dir  parent directory that will hold deepseek-harness and dsh-slots.
rem             Defaults to the parent of this folder.
setlocal EnableDelayedExpansion
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "ROOT=%~1"
if "%ROOT%"=="" for %%I in ("%HERE%\..") do set "ROOT=%%~fI"
set "CONFIG=%HERE%\dsh-upgrade.json"
set "CLI=%HERE%\src\cli.ts"

echo dsh-upgrade setup
echo   tool   %HERE%
echo   root   %ROOT%
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [x] Node.js 24 or newer is required: https://nodejs.org
  exit /b 1
)
for /f "delims=" %%V in ('node -p "process.versions.node"') do set "NODEV=%%V"
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
  echo [x] Node.js 24 or newer is required; found !NODEV!
  exit /b 1
)
echo   node   !NODEV!

echo.
if not exist "%CONFIG%" (
  echo [1/4] creating the layout under %ROOT%
  node "%CLI%" --config "%CONFIG%" init --root "%ROOT%"
  if errorlevel 1 exit /b 1
) else (
  echo [1/4] keeping the existing configuration
  echo        %CONFIG%
)

echo.
echo [2/4] checking the machine
node "%CLI%" --config "%CONFIG%" doctor
if errorlevel 1 (
  echo [!] doctor reported a blocking problem. Fix it and run this file again.
  exit /b 1
)

echo.
echo [3/4] installing the gateway session plugin
node "%CLI%" --config "%CONFIG%" opencode-session install
if errorlevel 1 (
  echo [!] the plugin was not installed. Run "opencode-session install" after the first stage,
  echo     because it needs a built harness under the stable path.
)

echo.
echo [4/4] creating the desktop launchers
node "%CLI%" --config "%CONFIG%" shortcuts --install
if errorlevel 1 (
  echo [!] the launchers were not created; the CLI still works.
)

echo.
echo Done. Next steps:
echo   check          see whether a newer version exists
echo   stage          prepare it in the spare slot
echo   apply          switch to it
echo   task install   check for new versions every 20 minutes
echo   tray           open the tray companion
echo.
echo Every command takes --config "%CONFIG%" when run from another folder.
echo.
exit /b 0
