Option Explicit
' Hidden launcher for the DSH-WeChat-Bridge scheduled task, with failure logging.
'
' Windows 11 delegates console windows to Windows Terminal, and "pwsh -WindowStyle Hidden"
' cannot hide that delegated window; wscript is a GUI-subsystem host, so Run(..., 0, ...)
' starts the launcher with SW_HIDE from the very beginning and no window is ever shown.
'
' Every outcome is appended to <root>\.state\logs\bridge.log, so a scheduled-task failure
' stays traceable even when no other component ran. Messages are ASCII on purpose: the shared
' log is written as UTF-8 by PowerShell and Node, and only ASCII bytes are identical in both
' encodings.
'
' Usage: wscript.exe //B //nologo run-bridge-hidden.vbs [bridge-root]
' The optional bridge root lets install-task.ps1 keep a copy of this file outside the git
' worktree while still launching the bridge that lives in the repository.

Dim fso, sh, root, argRoot, logPath, pwsh, cmd, code
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

argRoot = ""
If WScript.Arguments.Count > 0 Then argRoot = WScript.Arguments(0)
If argRoot <> "" Then
  root = argRoot
Else
  root = fso.GetParentFolderName(WScript.ScriptFullName)
End If

' When the bridge root is unusable the line still lands next to this script.
logPath = ResolveLog(root)
If logPath = "" Then logPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "launcher.log")

WriteLog "launcher: start (root=" & root & ")"

If Not fso.FileExists(fso.BuildPath(root, "run-bridge.ps1")) Then
  WriteLog "launcher: ERROR run-bridge.ps1 not found under " & root
  WScript.Quit 2
End If

pwsh = sh.ExpandEnvironmentStrings("%ProgramFiles%\PowerShell\7\pwsh.exe")
If Not fso.FileExists(pwsh) Then pwsh = "pwsh.exe"
sh.CurrentDirectory = root
cmd = """" & pwsh & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & root & "\run-bridge.ps1"""

On Error Resume Next
code = sh.Run(cmd, 0, True)
If Err.Number <> 0 Then
  WriteLog "launcher: ERROR pwsh could not start: 0x" & Hex(Err.Number) & " " & Err.Description
  WScript.Quit 3
End If
On Error GoTo 0

WriteLog "launcher: run-bridge.ps1 exited rc=" & code
WScript.Quit code

' Returns the shared bridge log path, creating .state\logs when needed; "" when unusable.
Function ResolveLog(base)
  Dim stateDir, logDir
  On Error Resume Next
  ResolveLog = ""
  If base = "" Then Exit Function
  If Not fso.FolderExists(base) Then Exit Function
  stateDir = fso.BuildPath(base, ".state")
  If Not fso.FolderExists(stateDir) Then fso.CreateFolder(stateDir)
  logDir = fso.BuildPath(stateDir, "logs")
  If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
  If fso.FolderExists(logDir) Then ResolveLog = fso.BuildPath(logDir, "bridge.log")
  On Error GoTo 0
End Function

' Appends one timestamped line. Names avoid VBScript's built-ins and this file's own
' procedures: a clash compiles away silently and the line never reaches the log.
Sub WriteLog(message)
  Dim handle, record
  On Error Resume Next
  If logPath = "" Then Exit Sub
  record = TimeStamp() & " " & message
  Set handle = fso.OpenTextFile(logPath, 8, True)
  If Err.Number <> 0 Then
    Err.Clear
    Exit Sub
  End If
  handle.WriteLine record
  handle.Close
  Err.Clear
  On Error GoTo 0
End Sub

Function TimeStamp()
  Dim d
  d = Now
  TimeStamp = Year(d) & "-" & Pad2(Month(d)) & "-" & Pad2(Day(d)) & " " & Pad2(Hour(d)) & ":" & Pad2(Minute(d)) & ":" & Pad2(Second(d))
End Function

Function Pad2(value)
  Pad2 = Right("0" & CStr(value), 2)
End Function
