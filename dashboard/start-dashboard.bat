@echo off
:: Start TV Dashboard via PM2 — runs at Windows startup
:: If PM2 is already running the dashboard, resurrect will restore it.
cd /d "C:\Users\admin\tradingview-mcp-jackson"
pm2 resurrect
timeout /t 2 /nobreak >nul
pm2 status
