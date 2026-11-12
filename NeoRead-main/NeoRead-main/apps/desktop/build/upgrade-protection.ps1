# Windows PowerShell 5.1. Never invoke an uninstaller or terminate a process here.
[CmdletBinding()]
param(
    [ValidateSet('Install', 'UninstallCheck', 'Clean')][string]$Mode = 'Install',
    [string]$Destination,
    [string]$UserData,
    [string]$BackupRoot,
    [string]$Manifest,
    [string]$InstallRegistryKey,
    [string]$UninstallRegistryKey,
    [string]$UninstallRegistryKey2,
    [string]$UninstallerName
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:protectionPhase = 'initialization'

function Stop-Protection([string]$Code) { throw [InvalidOperationException]::new($Code) }

function Assert-PlainPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { Stop-Protection 'invalid_path' }
    $Path = $Path.Replace('/', '\')
    if ($Path -notmatch '^[a-zA-Z]:\\' -or $Path -match '[\x00-\x1f<>"|?*]' -or $Path.Substring(2).Contains(':')) { Stop-Protection 'invalid_path' }
    foreach ($part in $Path.Substring(3).TrimEnd('\').Split('\')) {
        if ($part -and ($part -in @('.', '..') -or $part -match '[ .]$')) { Stop-Protection 'ambiguous_path' }
    }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($full.Length -eq 2) { $full += '\' }
    # Check every ancestor, including existing parents of a not-yet-created target.
    $cursor = $full
    while ($cursor) {
        try {
            $attributes = [IO.File]::GetAttributes($cursor)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Protection 'reparse_point' }
        } catch [IO.FileNotFoundException] { } catch [IO.DirectoryNotFoundException] { }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    # Expand existing 8.3 aliases too, so lexical containment cannot be bypassed.
    if (-not ('NeoReadLongPath' -as [type])) {
        # NSIS's plugin cwd contains a native System.dll. Never let the C# compiler
        # resolve the .NET reference by that relative name (CS0009 / bad image).
        $previousPhase = $script:protectionPhase
        $script:protectionPhase = 'path_interop'
        Add-Type -ReferencedAssemblies ([Uri].Assembly.Location) -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class NeoReadLongPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetLongPathName(string path, StringBuilder buffer, uint size); }'
        $script:protectionPhase = $previousPhase
    }
    $cursor = $full
    $tail = [Collections.Generic.List[string]]::new()
    while (-not [IO.Directory]::Exists($cursor) -and -not [IO.File]::Exists($cursor)) {
        $tail.Insert(0, [IO.Path]::GetFileName($cursor))
        $cursor = [IO.Path]::GetDirectoryName($cursor)
        if (-not $cursor) { Stop-Protection 'unavailable_volume' }
    }
    $buffer = [Text.StringBuilder]::new(32768)
    $length = [NeoReadLongPath]::GetLongPathName($cursor, $buffer, 32768)
    if ($length -eq 0 -or $length -ge 32768) { Stop-Protection 'path_resolution_failed' }
    $full = $buffer.ToString()
    foreach ($part in $tail) { $full = [IO.Path]::Combine($full, $part) }
    return $full.TrimEnd('\')
}

function Test-Inside([string]$Path, [string]$Root) {
    return $Path.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Test-Overlap([string]$A, [string]$B) { return (Test-Inside $A $B) -or (Test-Inside $B $A) }

function Get-TreeFiles([string]$Root) {
    $null = Assert-PlainPath $Root
    if (-not [IO.Directory]::Exists($Root)) {
        if ([IO.File]::Exists($Root)) { Stop-Protection 'not_directory' }
        return
    }
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Root)
    while ($pending.Count) {
        foreach ($entry in [IO.Directory]::GetFileSystemEntries($pending.Pop())) {
            $attributes = [IO.File]::GetAttributes($entry)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Protection 'reparse_point' }
            if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { $pending.Push($entry) }
            else { $entry }
        }
    }
}

function Assert-RelativeFile([string]$Path) {
    if (-not $Path -or $Path -match '[\x00-\x1f<>:"|?*$`!]' -or $Path.Contains('/') -or [IO.Path]::IsPathRooted($Path)) { Stop-Protection 'invalid_manifest' }
    foreach ($part in $Path.Split('\')) {
        if (-not $part -or $part -in @('.', '..') -or $part -match '[ .]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') { Stop-Protection 'invalid_manifest' }
    }
}
function Read-ProgramManifest([string]$Path) {
    $document = [IO.File]::ReadAllText((Assert-PlainPath $Path)) | ConvertFrom-Json
    if ($document.schema -ne 1 -or -not $document.files -or $document.files -isnot [Array]) { Stop-Protection 'invalid_manifest' }
    $known = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $document.files) {
        if ($file -isnot [string]) { Stop-Protection 'invalid_manifest' }
        Assert-RelativeFile $file
        if (-not $known.Add($file)) { Stop-Protection 'invalid_manifest' }
    }
    return ,$known
}

function Get-NeoReadProcesses {
    # Failure to enumerate is a failure, not evidence that the app has stopped.
    return @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
}
function Assert-NeoReadStopped([string[]]$InstallDirs) {
    foreach ($process in (Get-NeoReadProcesses)) {
        if ($process.Name -match '^(?i:NeoRead|neoread-server)\.exe$') { Stop-Protection 'app_running' }
        if ($process.ExecutablePath) {
            foreach ($directory in $InstallDirs) {
                if (Test-Inside $process.ExecutablePath $directory) { Stop-Protection 'app_running' }
            }
        }
    }
}

function Get-RegisteredInstallDirs([string]$InstallKey, [string[]]$UninstallKeys) {
    if (-not $InstallKey -or -not $UninstallKeys.Count) { Stop-Protection 'registry_key_missing' }
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
            try {
                $key = $base.OpenSubKey($InstallKey)
                if ($key) {
                    try {
                        $location = $key.GetValue('InstallLocation', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                        if ($location) { Assert-PlainPath ([string]$location) }
                    } finally { $key.Dispose() }
                }
                foreach ($uninstallKey in $UninstallKeys) {
                    if (-not $uninstallKey) { continue }
                    $key = $base.OpenSubKey($uninstallKey)
                    if ($key) {
                        try {
                            $command = $key.GetValue('UninstallString', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                            if ($command) {
                                # Match builder's quoted executable; reject unknown command formats.
                                if ($command -notmatch '^"([^"\r\n]+\.exe)"(?:\s.*)?$') { Stop-Protection 'unknown_uninstaller' }
                                Assert-PlainPath ([IO.Path]::GetDirectoryName($Matches[1]))
                            }
                            $location = $key.GetValue('InstallLocation', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                            if ($location) { Assert-PlainPath ([string]$location) }
                        } finally { $key.Dispose() }
                    }
                }
            } finally { $base.Dispose() }
        }
    }
}

function Copy-SnapshotFile([IO.Stream]$Source, [string]$Target) {
    $output = [IO.File]::Open($Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $Source.CopyTo($output); $output.Flush($true) } finally { $output.Dispose() }
}

function Invoke-NeoReadUpgradeProtection {
    param([string]$Destination, [string]$UserData, [string]$BackupRoot, [string[]]$OldInstallDirs = @(), [string]$Manifest, [string]$UninstallerName)
    $destinationPath = Assert-PlainPath $Destination
    $userPath = Assert-PlainPath $UserData
    $backupPath = Assert-PlainPath $BackupRoot
    foreach ($temporary in @($env:TEMP, $env:TMP)) {
        if ($temporary -and (Test-Inside $backupPath ([IO.Path]::GetFullPath($temporary).TrimEnd('\')))) { Stop-Protection 'temporary_backup_location' }
    }
    $installDirs = @(@($destinationPath) + @($OldInstallDirs | ForEach-Object { Assert-PlainPath $_ }) | Select-Object -Unique)
    $known = Read-ProgramManifest $Manifest
    Assert-RelativeFile $UninstallerName
    if ($UninstallerName.Contains('\')) { Stop-Protection 'invalid_manifest' }
    $null = $known.Add($UninstallerName)
    foreach ($install in $installDirs) {
        # A volume root is never a valid program directory.
        if ($install.Length -le 3 -or (Test-Overlap $userPath $install) -or (Test-Overlap $backupPath $install)) { Stop-Protection 'unsafe_install_location' }
    }
    if (Test-Overlap $backupPath $userPath) { Stop-Protection 'unsafe_backup_location' }
    Assert-NeoReadStopped $installDirs
    $config = [IO.Path]::Combine($userPath, 'library-location.json')
    $configured = [IO.File]::Exists($config)
    $library = [IO.Path]::Combine($userPath, 'library')
    if ($configured) {
        $null = Assert-PlainPath $config
        $text = [IO.File]::ReadAllText($config)
        if ($text.Length -gt 65536) { Stop-Protection 'invalid_library_config' }
        try { $saved = ConvertFrom-Json -InputObject $text } catch { Stop-Protection 'invalid_library_config' }
        if (-not $saved -or @($saved.PSObject.Properties).Count -ne 1 -or $saved.directory -isnot [string]) { Stop-Protection 'invalid_library_config' }
        $library = Assert-PlainPath $saved.directory
    } elseif ([IO.Directory]::Exists($config)) { Stop-Protection 'invalid_library_config' }
    $library = Assert-PlainPath $library
    foreach ($install in $installDirs) {
        if (Test-Overlap $library $install) { Stop-Protection 'library_inside_install_migrate_first' }
    }
    if (Test-Overlap $backupPath $library) { Stop-Protection 'unsafe_backup_location' }
    # Inspect both the final /D destination and all registry locations before ANY old uninstaller.
    # Unknown files are also blocked: a pre-protection uninstaller would delete them recursively.
    foreach ($install in $installDirs) {
        foreach ($file in (Get-TreeFiles $install)) {
            $relative = $file.Substring($install.Length + 1)
            if ([IO.Path]::GetFileName($file) -match '^(?i:neoread|reader)\.sqlite(?:-wal|-shm)?$' -or -not $known.Contains($relative)) { Stop-Protection 'unknown_install_data_migrate_first' }
        }
    }
    $libraryFiles = @(Get-TreeFiles $library)
    $database = @($libraryFiles | Where-Object { $_ -ieq [IO.Path]::Combine($library, 'neoread.sqlite') -or $_ -ieq [IO.Path]::Combine($library, 'reader.sqlite') })
    if (($configured -or $libraryFiles.Count) -and -not $database.Count) { Stop-Protection 'library_missing_do_not_create_empty' }
    if ($configured -and -not [IO.Directory]::Exists($library)) { Stop-Protection 'library_missing_do_not_create_empty' }
    $sources = [Collections.Generic.List[object]]::new()
    foreach ($file in $libraryFiles) { $sources.Add(@{ Source = $file; Relative = 'library\' + $file.Substring($library.Length + 1) }) }
    foreach ($file in (Get-TreeFiles $userPath)) {
        if (-not (Test-Inside $file $library)) { $sources.Add(@{ Source = $file; Relative = 'configuration\' + $file.Substring($userPath.Length + 1) }) }
    }
    if (-not $sources.Count) { return @{ event = 'upgrade.protection.empty'; files = 0 } }
    [IO.Directory]::CreateDirectory($backupPath) | Out-Null
    $null = Assert-PlainPath $backupPath
    # Private local DACL: only the current user and SYSTEM can read opaque configuration copies.
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    [IO.Directory]::SetAccessControl($backupPath, $acl)
    $id = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N')
    $stage = [IO.Path]::Combine($backupPath, '.incomplete-' + $id)
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    $streams = [Collections.Generic.List[object]]::new()
    $records = [Collections.Generic.List[object]]::new()
    try {
        # Hold read-only, deny-write/delete handles for EVERY source until the snapshot is verified.
        foreach ($source in $sources) {
            $null = Assert-PlainPath $source.Source
            $stream = [IO.File]::Open($source.Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            $streams.Add(@{ Stream = $stream; Source = $source.Source; Relative = $source.Relative })
        }
        if ($configured) {
            $entry = @($streams | Where-Object { $_.Source -ieq $config })[0]
            $reader = [IO.StreamReader]::new($entry.Stream, [Text.Encoding]::UTF8, $true, 1024, $true)
            try { $lockedText = $reader.ReadToEnd() } finally { $reader.Dispose(); $entry.Stream.Position = 0 }
            if ($lockedText -cne $text) { Stop-Protection 'source_changed' }
        }
        foreach ($entry in $streams) {
            $target = [IO.Path]::Combine($stage, $entry.Relative)
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
            Copy-SnapshotFile $entry.Stream $target
            $entry.Stream.Position = 0
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $hash = [BitConverter]::ToString($sha.ComputeHash($entry.Stream)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
            $copy = [IO.File]::OpenRead($target)
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $copyHash = [BitConverter]::ToString($sha.ComputeHash($copy)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose(); $copy.Dispose() }
            if (([IO.FileInfo]$target).Length -ne $entry.Stream.Length -or $hash -ne $copyHash) { Stop-Protection 'backup_verification_failed' }
            $records.Add(@{ path = $entry.Relative; bytes = $entry.Stream.Length; sha256 = $hash })
        }
        # Detect files added/removed while taking the snapshot, not just changes to open files.
        $after = @(@(Get-TreeFiles $library) + @(Get-TreeFiles $userPath) | Sort-Object -Unique)
        $before = @($sources | ForEach-Object { $_.Source } | Sort-Object -Unique)
        if (@(Compare-Object $before $after).Count) { Stop-Protection 'source_changed' }
        Assert-NeoReadStopped $installDirs
        $record = @{ schema = 1; createdUtc = [DateTime]::UtcNow.ToString('o'); library = $library; userData = $userPath; files = @($records.ToArray()) }
        [IO.File]::WriteAllText([IO.Path]::Combine($stage, 'manifest.json'), ($record | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
        [IO.Directory]::Move($stage, [IO.Path]::Combine($backupPath, $id))
        return @{ event = 'upgrade.protection.complete'; files = $records.Count; snapshot = $id }
    } finally { foreach ($entry in $streams) { $entry.Stream.Dispose() } }
    # Failed snapshots stay .incomplete-*; NEVER remove or overwrite previous backups.
}

function Remove-NeoReadProgramFiles([string]$Directory, [string]$Manifest, [string]$UninstallerName) {
    $script:protectionPhase = 'program_manifest'
    $root = Assert-PlainPath $Directory
    if ($root.Length -le 3) { Stop-Protection 'unsafe_install_location' }
    $known = Read-ProgramManifest $Manifest
    Assert-RelativeFile $UninstallerName
    if ($UninstallerName.Contains('\')) { Stop-Protection 'invalid_manifest' }
    $null = $known.Add($UninstallerName)
    $directories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $script:protectionPhase = 'program_paths'
    # Validate the entire whitelist first. Do not follow a junction even for an exact known filename.
    foreach ($file in $known) {
        $target = Assert-PlainPath ([IO.Path]::Combine($root, $file))
        if (-not (Test-Inside $target $root)) { Stop-Protection 'invalid_manifest' }
        if ([IO.Directory]::Exists($target)) { Stop-Protection 'program_file_is_directory' }
        $parent = [IO.Path]::GetDirectoryName($target)
        while ((Test-Inside $parent $root) -and $parent -ine $root) {
            $null = $directories.Add($parent)
            $parent = [IO.Path]::GetDirectoryName($parent)
        }
    }
    $script:protectionPhase = 'program_files'
    foreach ($file in $known) {
        $target = [IO.Path]::Combine($root, $file)
        if ([IO.File]::Exists($target)) { [IO.File]::Delete($target) }
    }
    $script:protectionPhase = 'program_directories'
    foreach ($directory in @($directories | Sort-Object Length -Descending) + @($root)) {
        # Empty directories only. Unknown files and directories always remain in place.
        if ([IO.Directory]::Exists($directory) -and [IO.Directory]::GetFileSystemEntries($directory).Length -eq 0) { [IO.Directory]::Delete($directory, $false) }
    }
}

# Dot sourcing is exclusively the synthetic test/library API; no implicit environment access.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($Mode -eq 'Install') {
            $script:protectionPhase = 'install_preflight'
            $old = @(Get-RegisteredInstallDirs $InstallRegistryKey @($UninstallRegistryKey, $UninstallRegistryKey2))
            $result = Invoke-NeoReadUpgradeProtection -Destination $Destination -UserData $UserData -BackupRoot $BackupRoot -OldInstallDirs $old -Manifest $Manifest -UninstallerName $UninstallerName
        } elseif ($Mode -eq 'UninstallCheck') {
            $script:protectionPhase = 'process_check'
            Assert-NeoReadStopped @((Assert-PlainPath $Destination))
            $result = @{ event = 'uninstall.protection.stopped' }
        } else {
            Remove-NeoReadProgramFiles $Destination $Manifest $UninstallerName
            $result = @{ event = 'uninstall.protection.complete' }
        }
        $result | ConvertTo-Json -Compress
        exit 0
    } catch {
        # No raw exceptions, paths, database/config contents or credentials in installer output.
        $code = 'io_or_verification_failed'
        if ($_.Exception -is [InvalidOperationException] -and $_.Exception.Message -match '^[a-z_]+$') { $code = $_.Exception.Message }
        $exceptionType = $_.Exception.GetType().Name
        if ($exceptionType -notin @('Exception', 'MethodInvocationException', 'UnauthorizedAccessException', 'IOException', 'InvalidOperationException', 'RuntimeException')) { $exceptionType = 'Other' }
        @{ event = 'upgrade.protection.blocked'; reason = $code; mode = $Mode; phase = $script:protectionPhase; exceptionType = $exceptionType } | ConvertTo-Json -Compress
        exit 73
    }
}
