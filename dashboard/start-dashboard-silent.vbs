' Start TradingView Dashboard silently on Windows startup
' Runs PM2 resurrect to restore the tv-dashboard process
Dim oShell
Set oShell = CreateObject("WScript.Shell")
oShell.Run "cmd /c pm2 resurrect", 0, False
Set oShell = Nothing
