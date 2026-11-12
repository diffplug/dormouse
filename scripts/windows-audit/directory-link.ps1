#Requires -Version 5.1
# Creating a directory link must not query the SMB target as the Administrator:
# only the synthetic owner is granted share access. New-Item's provider may
# inspect the target to decide whether it is a directory; Win32 takes that flag.
function New-AuditDirectoryLink([string]$Link, [string]$Target) {
  if (-not ('DormouseAudit.DirectoryLinks' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace DormouseAudit {
  public static class DirectoryLinks {
    [DllImport("kernel32.dll", EntryPoint="CreateSymbolicLinkW", CharSet=CharSet.Unicode, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.U1)]
    public static extern bool Create(string link, string target, uint flags);
  }
}
"@
  }
  # DIRECTORY | ALLOW_UNPRIVILEGED_CREATE (the latter only works with Developer
  # Mode, otherwise the caller still needs the normal symbolic-link privilege).
  if (-not [DormouseAudit.DirectoryLinks]::Create($Link, $Target, 3)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $reason = (New-Object ComponentModel.Win32Exception($code)).Message
    throw (New-Object ComponentModel.Win32Exception($code, "CreateSymbolicLinkW failed ($code): $reason; link=$Link"))
  }
}
