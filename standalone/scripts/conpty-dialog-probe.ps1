# Manual probe for ConPTY window parenting (docs/specs/standalone.md -> "Console window parenting").
#
# Opens a modal message box owned the way MSAL/WAM sign-in (Connect-AzAccount) owns its
# account picker: GetAncestor(GetConsoleWindow(), GA_ROOTOWNER). Without parenting that is
# ConPTY's hidden console window, so the box can open behind Dormouse; with it, the box is
# owned by (and disables) the Dormouse window holding the pane.
#
#   powershell -NoProfile -File conpty-dialog-probe.ps1        # dialog in a child of the shell
#   . .\conpty-dialog-probe.ps1                                 # dialog in the shell itself
#
# Printing the PID first lets a second terminal `Stop-Process` only the dialog's process.
param([string]$Caption = 'Dormouse ConPTY probe')

Add-Type -Namespace DormouseProbe -Name Win32 -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int MessageBoxW(IntPtr owner, string text, string caption, uint type);
'@

$console = [DormouseProbe.Win32]::GetConsoleWindow()
$owner = [DormouseProbe.Win32]::GetAncestor($console, 3) # GA_ROOTOWNER
$ownerPid = [uint32]0
[void][DormouseProbe.Win32]::GetWindowThreadProcessId($owner, [ref]$ownerPid)
$ownerName = (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue).ProcessName
'probe pid {0}; console 0x{1:X}; root owner 0x{2:X} ({3} pid {4})' -f $PID, $console.ToInt64(), $owner.ToInt64(), $ownerName, $ownerPid
$answer = [DormouseProbe.Win32]::MessageBoxW($owner, "Owned by 0x$('{0:X}' -f $owner.ToInt64()) ($ownerName). Dismiss me.", $Caption, 0)
"dismissed ($answer)"
