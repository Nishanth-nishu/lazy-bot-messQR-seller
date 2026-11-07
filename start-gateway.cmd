@echo off
rem Starts the self-hosted UPI Gateway used by PAYMENT_GATEWAY=upi_gateway:
rem   1. MariaDB (portable, ..\tools) on 127.0.0.1:3307, if it isn't running yet
rem   2. the gateway (..\upi-gateway) on http://127.0.0.1:8000
rem Both only listen on this PC. Close this window to stop the gateway.
setlocal
set "ROOT=%~dp0.."
set "MARIADB=%ROOT%\tools\mariadb-11.4.8-winx64\bin\mariadbd.exe"
set "MYINI=%ROOT%\tools\mariadb-data\my.ini"
set "PHP=%LOCALAPPDATA%\Microsoft\WinGet\Packages\PHP.PHP.NTS.8.3_Microsoft.Winget.Source_8wekyb3d8bbwe\php.exe"

tasklist /FI "IMAGENAME eq mariadbd.exe" | find /I "mariadbd.exe" >nul
if errorlevel 1 (
    echo Starting MariaDB...
    start "" /B "%MARIADB%" --defaults-file="%MYINI%"
    timeout /t 4 /nobreak >nul
)

cd /d "%ROOT%\upi-gateway"
echo UPI Gateway on http://127.0.0.1:8000  (dashboard: http://127.0.0.1:8000/login)
"%PHP%" artisan serve --host=127.0.0.1 --port=8000
