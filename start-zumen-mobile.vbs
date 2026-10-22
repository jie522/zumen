' Double-click: start ZUMEN mobile server in background and open the QR code page
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c node server.js > zumen-mobile.log 2>&1", 0, False
WScript.Sleep 3000
sh.Run "http://localhost:3457/connect.html"
