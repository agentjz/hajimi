@echo off
setlocal EnableExtensions

set "DRY_RUN=0"
if /I "%~1"=="--dry-run" set "DRY_RUN=1"

echo.
echo Hajimi Global Cleanup
echo ===========================
echo.

call :remove_dir "%APPDATA%\hajimi"
call :remove_dir "%LOCALAPPDATA%\hajimi"

call :remove_file "%APPDATA%\npm\hajimi"
call :remove_file "%APPDATA%\npm\hajimi.cmd"
call :remove_file "%APPDATA%\npm\hajimi.ps1"

call :remove_dir "%APPDATA%\npm\node_modules\@jun133\hajimi"
call :remove_dir "%APPDATA%\npm\node_modules\hajimi"

echo.
if "%DRY_RUN%"=="1" (
  echo [dry-run] No files were deleted.
) else (
  echo [done] Hajimi global state and global install remnants were removed.
)
echo.
echo Notes:
echo - This script clears global config, sessions, changes, cache, and global npm shims.
echo - If you still want to use Hajimi afterward, run npm install -g ^@jun133/hajimi or npm link again.
echo - This script does not touch your current project's source files.
echo.
exit /b 0

:remove_dir
set "TARGET=%~1"
if not exist "%TARGET%" (
  echo [skip] dir  "%TARGET%"
  exit /b 0
)

if "%DRY_RUN%"=="1" (
  echo [dry-run] dir  "%TARGET%"
  exit /b 0
)

rmdir /s /q "%TARGET%"
if exist "%TARGET%" (
  echo [warn] dir  "%TARGET%" was not fully removed
) else (
  echo [removed] dir  "%TARGET%"
)
exit /b 0

:remove_file
set "TARGET=%~1"
if not exist "%TARGET%" (
  echo [skip] file "%TARGET%"
  exit /b 0
)

if "%DRY_RUN%"=="1" (
  echo [dry-run] file "%TARGET%"
  exit /b 0
)

del /f /q "%TARGET%"
if exist "%TARGET%" (
  echo [warn] file "%TARGET%" was not fully removed
) else (
  echo [removed] file "%TARGET%"
)
exit /b 0
