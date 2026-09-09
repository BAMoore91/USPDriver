@echo off
setlocal
rem Build the AC-MXNET USP-CBOX driver package.
rem Runs from wherever this file lives, so it works from a double-click,
rem a shortcut, or a shell started in another directory.
cd /d "%~dp0"

if not exist "PackageDriver.exe" (
  echo ERROR: PackageDriver.exe not found in "%CD%".
  echo It must sit next to this script.
  echo.
  pause
  exit /b 1
)

echo Packaging AC-MXNET USP-CBOX driver...
echo Working directory: %CD%
echo.

PackageDriver.exe -o USPDRIVER.RTIDRIVER
set RC=%ERRORLEVEL%
echo.

if not "%RC%"=="0" (
  echo BUILD FAILED - PackageDriver exited with code %RC%.
  echo PackageDriver schema-validates every XML file and refuses to build on
  echo error; the messages above name the offending file.
  echo.
  pause
  exit /b %RC%
)

echo BUILD OK - USPDRIVER.RTIDRIVER written to %CD%
echo.
pause
exit /b 0
