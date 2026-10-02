Option Explicit
' Launches run-bridge.ps1 with NO visible window.
' Windows 11 delegates console windows to Windows Terminal, and "pwsh -WindowStyle Hidden"
' cannot hide that delegated window; wscript is a GUI-subsystem host, so Run(..., 0, ...)
' starts the launcher with SW_HIDE from the very beginning and no window is ever shown.
Dim fso, sh, root, pwsh, cmd, code
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
pwsh = sh.ExpandEnvironmentStrings("%ProgramFiles%\PowerShell\7\pwsh.exe")
If Not fso.FileExists(pwsh) Then pwsh = "pwsh.exe"
sh.CurrentDirectory = root
cmd = """" & pwsh & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & root & "\run-bridge.ps1"""
code = sh.Run(cmd, 0, True)
WScript.Quit code
