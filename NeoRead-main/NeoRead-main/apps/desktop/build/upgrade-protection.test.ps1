# Synthetic fixtures only. No real library, AppData, installer or uninstaller is used.
param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\upgrade-protection.ps1"
$allowed = [IO.Path]::GetFullPath($env:PI_SCRATCH_DIR).TrimEnd('\') + '\'
if (-not [IO.Path]::GetFullPath($Root).StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test root must be session scratch' }
[IO.Directory]::CreateDirectory($Root) | Out-Null
$script:checks = 0
$script:oldUninstallerCalls = 0
# Exercise the real process enumeration once, then isolate the synthetic core tests.
$actualProcesses = @(Get-NeoReadProcesses)
if (-not $actualProcesses.Count) { throw 'CIM process enumeration failed' }
function Get-NeoReadProcesses { return @() }
function Check([bool]$condition, [string]$name) {
    if (-not $condition) { throw ('Assertion failed: ' + $name) }
    $script:checks++
}
function Put([string]$Path, [string]$Text) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}
function New-Fixture([string]$Name) {
    $base = Join-Path $Root $Name
    $data = Join-Path $base 'user-data'
    $old = Join-Path $base 'NeoRead'
    $library = Join-Path $base ('NeoRead Library ' + [char]0x4e2d + [char]0x6587)
    $manifest = Join-Path $base 'manifest.json'
    $null = [IO.Directory]::CreateDirectory($data)
    Put (Join-Path $old 'NeoRead.exe') 'old program'
    Put (Join-Path $old 'resources\app.asar') 'old asar'
    Put (Join-Path $old 'Uninstall NeoRead.exe') 'DO NOT EXECUTE: synthetic old uninstaller'
    Put $manifest '{"schema":1,"files":["NeoRead.exe","resources\\app.asar"]}'
    Put (Join-Path $data 'library-location.json') (@{directory=$library} | ConvertTo-Json -Compress)
    Put (Join-Path $library 'neoread.sqlite') 'SQLite format 3; categories=SP,other; documents=latest'
    Put (Join-Path $library 'neoread.sqlite-wal') 'uncheckpointed WAL bytes'
    Put (Join-Path $library 'neoread.sqlite-shm') 'SHM bytes'
    Put (Join-Path $library 'originals\paper.pdf') 'original PDF bytes'
    Put (Join-Path $library 'edited\copy.pdf') 'edited PDF bytes'
    Put (Join-Path $library 'attachments\image.bin') 'attachment bytes'
    Put (Join-Path $library 'translations\result.md') 'translation bytes'
    Put (Join-Path $library 'ai-config.json') '{"apiKey":"FAKE-SYNTHETIC-API-NOT-A-SECRET","model":"test"}'
    Put (Join-Path $data 'proxy-settings.json') '{"opaque":"FAKE-LOCAL-CONFIG"}'
    $bytes = New-Object byte[] 8193
    [Random]::new(42).NextBytes($bytes)
    [IO.File]::WriteAllBytes((Join-Path $library 'attachments\binary.dat'), $bytes)
    return @{ Destination=(Join-Path $base 'new-program'); UserData=$data; BackupRoot=(Join-Path $base 'persistent-backups'); OldInstallDirs=@($old); Manifest=$manifest; UninstallerName='Uninstall NeoRead.exe' }
}
function Selected-Library($fixture) { return (Get-Content -LiteralPath (Join-Path $fixture.UserData 'library-location.json') -Encoding UTF8 -Raw | ConvertFrom-Json).directory }
function Select-Library($fixture, [string]$Path) { Put (Join-Path $fixture.UserData 'library-location.json') (@{directory=$Path} | ConvertTo-Json -Compress) }
function Simulate-Upgrade($fixture) {
    $result = Invoke-NeoReadUpgradeProtection @fixture
    # This sentinel is the ONLY stand-in for calling a legacy uninstaller.
    $script:oldUninstallerCalls++
    return $result
}
function Blocked($fixture, [string]$reason) {
    $before = $script:oldUninstallerCalls
    $failed = $false
    try { $null = Simulate-Upgrade $fixture } catch { $failed = $true; if ($reason) { Check ($_.Exception.Message -match $reason) ('blocked reason ' + $reason) } }
    Check $failed 'upgrade must fail closed'
    Check ($script:oldUninstallerCalls -eq $before) 'old uninstaller never called after failure'
}

$f = New-Fixture 'normal'
$result = Simulate-Upgrade $f
Check ($result.event -eq 'upgrade.protection.complete') 'completed external library snapshot'
$snapshot = Join-Path $f.BackupRoot $result.snapshot
$record = Get-Content -LiteralPath (Join-Path $snapshot 'manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json
Check ($record.files.Count -eq 11) 'all library and user configuration files included'
foreach ($entry in $record.files) {
    $copy = Join-Path $snapshot $entry.path
    $source = if ($entry.path.StartsWith('library\')) { Join-Path (Selected-Library $f) $entry.path.Substring(8) } else { Join-Path $f.UserData $entry.path.Substring(14) }
    Check ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash) 'source and snapshot bytes identical'
    Check ((Get-Item -LiteralPath $copy).Length -eq $entry.bytes) 'manifest size verified'
    Check ((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant() -eq $entry.sha256) 'manifest SHA256 verified'
}
Check ([IO.File]::ReadAllText((Join-Path $snapshot 'library\neoread.sqlite')).Contains('categories=SP')) 'category bytes retained'
Check ([IO.File]::ReadAllText((Join-Path $snapshot 'library\ai-config.json')).Contains('FAKE-SYNTHETIC-API-NOT-A-SECRET')) 'opaque fake API settings retained locally'
Check (-not ($result | ConvertTo-Json -Compress).Contains('FAKE-')) 'no configuration contents in status'
Put (Join-Path (Selected-Library $f) 'neoread.sqlite-wal') 'new WAL after first snapshot'
$second = Simulate-Upgrade $f
Check ($second.snapshot -ne $result.snapshot) 'new snapshot never overwrites old backup'
Check ([IO.Directory]::Exists($snapshot)) 'old snapshot retained'
Check ([IO.File]::ReadAllText((Join-Path $f.BackupRoot ($second.snapshot + '\library\neoread.sqlite-wal'))) -eq 'new WAL after first snapshot') 'changed content backed up again'

foreach ($case in @('old', 'destination', 'equal-destination', 'destination-parent', 'case-insensitive')) {
    $f = New-Fixture $case
    $library = switch ($case) {
        'old' { Join-Path $f.OldInstallDirs[0] 'NeoRead Library' }
        'destination' { Join-Path $f.Destination 'resources\library' }
        'equal-destination' { $f.Destination }
        'destination-parent' { Split-Path $f.Destination }
        'case-insensitive' { Join-Path $f.OldInstallDirs[0].ToUpperInvariant() 'LIBRARY' }
    }
    Select-Library $f $library
    Blocked $f 'library_inside_install'
}
$f = New-Fixture 'unknown-old-file'
Put (Join-Path $f.OldInstallDirs[0] 'personal\notes.txt') 'unknown user file'
Blocked $f 'unknown_install_data'
$f = New-Fixture 'unknown-destination-library'
Put (Join-Path $f.Destination 'nested\reader.sqlite') 'unselected data'
Blocked $f 'unknown_install_data'
foreach ($text in @('not json', '{}', '{"directory":"relative"}', '{"directory":null}', '[]')) {
    $f = New-Fixture ('config-' + [Guid]::NewGuid().ToString('N'))
    Put (Join-Path $f.UserData 'library-location.json') $text
    Blocked $f ''
}
$f = New-Fixture 'missing-selected-library'
Select-Library $f (Join-Path (Split-Path $f.UserData) 'missing-library')
Blocked $f 'library_missing'
$f = New-Fixture 'locked-db'
$lock = [IO.File]::Open((Join-Path (Selected-Library $f) 'neoread.sqlite'), 'Open', 'ReadWrite', 'None')
try { Blocked $f '' } finally { $lock.Dispose() }
$f = New-Fixture 'active-library-lock'
$lock = [IO.File]::Open((Join-Path (Selected-Library $f) 'neoread.lock'), 'OpenOrCreate', 'ReadWrite', 'ReadWrite')
try { Blocked $f '' } finally { $lock.Dispose() }
$f = New-Fixture 'corrupt-copy'
$originalCopy = (Get-Item Function:\Copy-SnapshotFile).ScriptBlock
function Copy-SnapshotFile([IO.Stream]$Source, [string]$Target) { [IO.File]::WriteAllText($Target, 'CORRUPTED-SYNTHETIC-COPY') }
try { Blocked $f 'backup_verification_failed' } finally { Set-Item Function:\Copy-SnapshotFile $originalCopy }
Check (@([IO.Directory]::GetDirectories($f.BackupRoot, '.incomplete-*')).Count -eq 1) 'failed snapshot is visibly incomplete'
Check (@([IO.Directory]::GetDirectories($f.BackupRoot) | Where-Object { -not [IO.Path]::GetFileName($_).StartsWith('.incomplete-') }).Count -eq 0) 'failed verification never publishes backup'
$f = New-Fixture 'source-changed'
$script:changingLibrary = Selected-Library $f
function Copy-SnapshotFile([IO.Stream]$Source, [string]$Target) {
    & $originalCopy $Source $Target
    Put (Join-Path $script:changingLibrary 'new-file-during-copy.txt') 'concurrent write'
}
try { Blocked $f 'source_changed' } finally { Set-Item Function:\Copy-SnapshotFile $originalCopy }
$f = New-Fixture 'running-app'
function Get-NeoReadProcesses { return @([pscustomobject]@{Name='NeoRead.exe'; ExecutablePath=$null}) }
Blocked $f 'app_running'
function Get-NeoReadProcesses { return @() }
$f = New-Fixture 'failed-process-query'
function Get-NeoReadProcesses { throw 'synthetic enumeration failure' }
Blocked $f ''
function Get-NeoReadProcesses { return @() }
$f = New-Fixture 'backup-is-file'
Put $f.BackupRoot 'cannot create snapshot here'
Blocked $f ''
$f = New-Fixture 'backup-inside-old'
$f.BackupRoot = Join-Path $f.OldInstallDirs[0] 'backups'
Blocked $f 'unsafe_install_location'
$f = New-Fixture 'backup-inside-library'
$f.BackupRoot = Join-Path (Selected-Library $f) 'backups'
Blocked $f 'unsafe_backup_location'
$f = New-Fixture 'temporary-backup'
$originalTemp = $env:TEMP
try { $env:TEMP = Split-Path $f.BackupRoot; Blocked $f 'temporary_backup_location' } finally { $env:TEMP = $originalTemp }

# Actual NTFS junctions: never traverse them for discovery, snapshot or cleanup.
foreach ($case in @('library-link', 'install-link', 'backup-link')) {
    $f = New-Fixture $case
    $external = Join-Path (Split-Path $f.UserData) 'external'
    $null = [IO.Directory]::CreateDirectory($external)
    $link = switch ($case) {
        'library-link' { Join-Path (Selected-Library $f) 'linked' }
        'install-link' { Join-Path $f.OldInstallDirs[0] 'linked' }
        'backup-link' { $f.BackupRoot }
    }
    New-Item -ItemType Junction -Path $link -Value $external | Out-Null
    try { Blocked $f 'reparse_point' } finally { [IO.Directory]::Delete($link) }
}
$f = New-Fixture 'denied-enumeration'
$denied = Join-Path (Selected-Library $f) 'denied'
Put (Join-Path $denied 'data.txt') 'private'
$originalAcl = [IO.Directory]::GetAccessControl($denied)
$acl = [IO.Directory]::GetAccessControl($denied)
$deny = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User, 'ListDirectory', 'Deny')
$acl.AddAccessRule($deny)
[IO.Directory]::SetAccessControl($denied, $acl)
try { Blocked $f '' } finally {
    $restore = [Security.AccessControl.DirectorySecurity]::new()
    $restore.SetSecurityDescriptorSddlForm($originalAcl.GetSecurityDescriptorSddlForm('Access'), 'Access')
    [IO.Directory]::SetAccessControl($denied, $restore)
}

# No-data fresh installs and known program-only older installs are both valid.
$f = New-Fixture 'no-data'
[IO.File]::Delete((Join-Path $f.UserData 'library-location.json'))
$f.UserData = Join-Path (Split-Path $f.UserData) 'absent-user-data'
Check ((Simulate-Upgrade $f).event -eq 'upgrade.protection.empty') 'no-data old installation allowed'
$f.OldInstallDirs = @()
Check ((Simulate-Upgrade $f).event -eq 'upgrade.protection.empty') 'fresh install allowed'
Check (-not [IO.Directory]::Exists((Join-Path $f.UserData 'library'))) 'preflight never creates blank library'

# Registry discovery reads ONLY this disposable test key, not the real NeoRead keys.
$keyName = 'Software\NeoReadUpgradeProtectionTests\' + [Guid]::NewGuid().ToString('N')
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
try {
    $f = New-Fixture 'registry'
    $key = $base.CreateSubKey($keyName + '\Install')
    $key.SetValue('InstallLocation', $f.OldInstallDirs[0]); $key.Dispose()
    $key = $base.CreateSubKey($keyName + '\Uninstall')
    $key.SetValue('UninstallString', '"' + (Join-Path $f.Destination 'Uninstall NeoRead.exe') + '" /currentuser'); $key.Dispose()
    $found = @(Get-RegisteredInstallDirs ($keyName + '\Install') @($keyName + '\Uninstall'))
    Check ($found -contains $f.OldInstallDirs[0]) 'HKCU install directory discovered'
    Check ($found -contains $f.Destination) 'uninstall command fallback discovered'
} finally { $base.DeleteSubKeyTree($keyName, $false); $base.Dispose() }

# Real exact-whitelist cleanup simulation, including resources and arbitrary new directories.
$f = New-Fixture 'clean'
$program = $f.OldInstallDirs[0]
Put (Join-Path $program 'resources\library\neoread.sqlite') 'must survive'
Put (Join-Path $program 'resources\unknown.txt') 'unknown resources survive'
Put (Join-Path $program 'personal\nested\notes.txt') 'unknown nested notes survive'
Remove-NeoReadProgramFiles $program $f.Manifest $f.UninstallerName
Check (-not [IO.File]::Exists((Join-Path $program 'NeoRead.exe'))) 'known executable deleted'
Check (-not [IO.File]::Exists((Join-Path $program 'resources\app.asar'))) 'known resources file deleted'
Check ([IO.File]::ReadAllText((Join-Path $program 'resources\library\neoread.sqlite')) -eq 'must survive') 'unknown library retained'
Check ([IO.File]::ReadAllText((Join-Path $program 'resources\unknown.txt')) -eq 'unknown resources survive') 'unknown resources retained'
Check ([IO.File]::ReadAllText((Join-Path $program 'personal\nested\notes.txt')) -eq 'unknown nested notes survive') 'unknown directory tree retained'
$f = New-Fixture 'clean-junction'
$program = $f.OldInstallDirs[0]
$outside = Join-Path (Split-Path $program) 'outside'
Put (Join-Path $outside 'app.asar') 'must never be deleted via junction'
[IO.File]::Delete((Join-Path $program 'resources\app.asar'))
[IO.Directory]::Delete((Join-Path $program 'resources'))
$link = Join-Path $program 'resources'
New-Item -ItemType Junction -Path $link -Value $outside | Out-Null
try {
    $failed = $false
    try { Remove-NeoReadProgramFiles $program $f.Manifest $f.UninstallerName } catch { $failed = $true }
    Check $failed 'cleanup rejects junction'
    Check ([IO.File]::Exists((Join-Path $program 'NeoRead.exe'))) 'cleanup validates before deleting any file'
    Check ([IO.File]::ReadAllText((Join-Path $outside 'app.asar')) -eq 'must never be deleted via junction') 'junction target retained'
} finally { [IO.Directory]::Delete($link) }
foreach ($bad in @('..\outside.txt', 'resources\..\outside', 'C:\outside', '$INSTDIR\x', 'resources\*.pdf', 'resources\file:stream')) {
    $f = New-Fixture ('bad-manifest-' + [Guid]::NewGuid().ToString('N'))
    Put $f.Manifest (@{schema=1;files=@('NeoRead.exe', $bad)} | ConvertTo-Json -Compress)
    Blocked $f 'invalid_manifest'
}
@{ event='synthetic.upgrade.tests.passed'; assertions=$script:checks; simulatedUninstalls=$script:oldUninstallerCalls } | ConvertTo-Json -Compress
