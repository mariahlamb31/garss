@echo off
chcp 65001 >nul
setlocal

set "ROOT_DIR=%~dp0"
cd /d "%ROOT_DIR%garss-studio" || exit /b 1

if not "%~1"=="" (
  call :run_action "%~1"
  exit /b %ERRORLEVEL%
)

:menu
echo GARSS
echo.
echo 1^) 启动
echo 2^) 关闭
echo 3^) 升级
echo 4^) 查看状态
echo 5^) 退出控制台（不关闭服务）
echo.
set /p "action=请选择操作 [1/2/3/4/5]: "
echo.

call :run_action "%action%"
set "exit_code=%ERRORLEVEL%"

if "%exit_code%"=="99" exit /b 0

echo.
if "%exit_code%"=="0" (
  echo 操作完成。
) else (
  echo 操作失败，请查看上面的错误信息。
)

echo.
pause
echo.
goto menu

:run_action
set "selected=%~1"

if /i "%selected%"=="1" goto do_start
if /i "%selected%"=="start" goto do_start
if "%selected%"=="启动" goto do_start

if /i "%selected%"=="2" goto do_stop
if /i "%selected%"=="stop" goto do_stop
if "%selected%"=="关闭" goto do_stop

if /i "%selected%"=="3" goto do_upgrade
if /i "%selected%"=="upgrade" goto do_upgrade
if "%selected%"=="升级" goto do_upgrade

if /i "%selected%"=="4" goto do_status
if /i "%selected%"=="status" goto do_status
if "%selected%"=="状态" goto do_status
if "%selected%"=="查看状态" goto do_status

if /i "%selected%"=="5" goto do_exit
if /i "%selected%"=="exit" goto do_exit
if /i "%selected%"=="quit" goto do_exit
if "%selected%"=="退出" goto do_exit
if "%selected%"=="退出控制台" goto do_exit

echo 未知操作: %selected%
echo 可用操作: start / stop / upgrade / status / exit
exit /b 1

:do_start
echo 正在启动 GARSS...
echo.
call npm run quick:start -- --open
exit /b %ERRORLEVEL%

:do_stop
echo 正在关闭 GARSS...
echo.
call npm run quick:stop
exit /b %ERRORLEVEL%

:do_upgrade
echo 正在升级 GARSS...
echo.
call npm run quick:upgrade -- --open
exit /b %ERRORLEVEL%

:do_status
echo 正在查看 GARSS 状态...
echo.
call npm run quick:status
exit /b %ERRORLEVEL%

:do_exit
echo 正在退出控制台，GARSS 服务不会被关闭。
exit /b 99
