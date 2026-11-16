# Starts the autoloop console without showing a console window (used by the scheduled task).
$dir = 'C:\Users\13694\WorkBuddy\spaces\2026_11_13_10-36-44\autoloop-console'
Start-Process -FilePath 'C:\Users\13694\nodejs\node.exe' -ArgumentList 'server.mjs' -WorkingDirectory $dir -WindowStyle Hidden
