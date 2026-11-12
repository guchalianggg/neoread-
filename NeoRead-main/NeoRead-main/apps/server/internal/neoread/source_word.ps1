param(
    [ValidateSet('convert','cleanup')][string]$Mode = 'convert',
    [string]$Source,
    [string]$Destination,
    [Parameter(Mandatory=$true)][string]$PidFile
)
$ErrorActionPreference = 'Stop'
# Never enumerate or close existing Word documents/processes. The ownership
# record is a PID plus exact creation time, not an executable-name kill list.
if ($Mode -eq 'cleanup') {
    if (Test-Path -LiteralPath $PidFile) {
        try {
            $record = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
            $process = Get-Process -Id ([int]$record.processId) -ErrorAction Stop
            if ($process.ProcessName -eq 'WINWORD' -and $process.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.startTicks) {
                $process.Kill()
                $process.WaitForExit(3000) | Out-Null
            }
        } catch { }
    }
    exit 0
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NeoReadWordWindow {
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@
$started = [DateTime]::UtcNow
$word = $null
$document = $null
$probe = $null
$owned = $false
$result = 20
try {
    # CoCreateInstance creates a separate automation instance; refuse to operate
    # at all if Office unexpectedly hands back a pre-existing instance.
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.AutomationSecurity = 3
    $word.DisplayAlerts = 0
    # Word exposes HWND on Window, not Application. Create only our own blank
    # document to identify the automation process; never inspect user documents.
    $probe = $word.Documents.Add()
    [uint32]$wordProcessId = 0
    [NeoReadWordWindow]::GetWindowThreadProcessId([IntPtr]$word.ActiveWindow.Hwnd, [ref]$wordProcessId) | Out-Null
    $process = Get-Process -Id $wordProcessId
    if ($process.ProcessName -ne 'WINWORD' -or $process.StartTime.ToUniversalTime() -lt $started) {
        throw 'private_instance_required'
    }
    $owned = $true
    @{ processId = $wordProcessId; startTicks = $process.StartTime.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json -Compress | Set-Content -LiteralPath $PidFile -Encoding UTF8
    $probe.Close(0)
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($probe) | Out-Null
    $probe = $null
    $word.Options.UpdateLinksAtOpen = $false
    $word.Options.UpdateLinksAtPrint = $false
    $word.Options.UpdateFieldsAtPrint = $false
    $word.Options.SaveNormalPrompt = $false
    # ConfirmConversions=false, ReadOnly=true, AddToRecentFiles=false; a fixed
    # nonempty password prevents encrypted documents from prompting for input.
    $document = $word.Documents.Open($Source, $false, $true, $false, 'NeoRead-no-password')
    $document.SaveAs2($Destination, 16, $false, '', $false, '', $false)
    $result = 0
} catch {
    # No exception text: Office errors can contain source text or private paths.
    $result = 20
} finally {
    if ($null -ne $probe) { try { $probe.Close(0) } catch { }; [Runtime.InteropServices.Marshal]::FinalReleaseComObject($probe) | Out-Null }
    if ($owned) {
        if ($null -ne $document) { try { $document.Close(0) } catch { } }
        if ($null -ne $word) { try { $word.Quit(0) } catch { } }
    }
    if ($null -ne $document) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) | Out-Null }
    if ($null -ne $word) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
exit $result
