; Lists NeoRead under "Open with" for PDF and EPUB. The builder's own file
; associations also set each extension's default type and leave it dangling
; after uninstall, so only ProgIDs and OpenWithProgids are written here; users
; choose the default app in Windows.

; Protected assisted per-user installs only. In builder 26.17.0 the inner UAC
; install section SKIPS CHECK_APP_RUNNING. Reject it in customInit rather than
; ever reaching an old uninstaller without the final-directory preflight.
!macro customInit
  ${If} ${UAC_IsInnerInstance}
    MessageBox MB_OK|MB_ICONSTOP "为保护原用户书库，已中止提升权限安装。请退出安装器，用原用户普通权限启动，并选择用户可写的程序目录。" /SD IDOK
    SetErrorLevel 73
    Quit
  ${EndIf}
!macroend

!macro neoreadExtractProtection
  InitPluginsDir
  File /oname=$PLUGINSDIR\neoread-upgrade-protection.ps1 "${BUILD_RESOURCES_DIR}\upgrade-protection.ps1"
  ; Each artifact must carry its own exact whitelist, never a guessed glob.
  !ifdef APP_64
    !ifdef APP_32
      !error "NeoRead protection requires a single-architecture installer"
    !endif
    !ifdef APP_ARM64
      !error "NeoRead protection requires a single-architecture installer"
    !endif
    File /oname=$PLUGINSDIR\neoread-program-files.json "${BUILD_RESOURCES_DIR}\program-files-x64.json"
  !else ifdef APP_ARM64
    !ifdef APP_32
      !error "NeoRead protection requires a single-architecture installer"
    !endif
    File /oname=$PLUGINSDIR\neoread-program-files.json "${BUILD_RESOURCES_DIR}\program-files-arm64.json"
  !else
    File /oname=$PLUGINSDIR\neoread-program-files.json "${BUILD_RESOURCES_DIR}\program-files-ia32.json"
  !endif
!macroend

!macro neoreadRequireProtectionSuccess
  Pop $0
  Pop $1
  DetailPrint "$1"
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "数据保护检查未通过，未继续安装或卸载。请正常退出 NeoRead 和后台任务后重试；若书库、未知文件位于程序目录内，请先在旧应用中迁移到外部目录。配置损坏、路径不可访问或备份失败时也会中止。不要直接运行旧卸载器。错误：$1" /SD IDOK
    SetErrorLevel 73
    Quit
  ${EndIf}
!macroend

; installSection.nsh calls this AFTER final directory selection (also /S /D),
; BEFORE uninstallOldVersion and installApplicationFiles. No process is killed.
!macro customCheckAppRunning
  !insertmacro neoreadExtractProtection
  !ifdef BUILD_UNINSTALLER
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\neoread-upgrade-protection.ps1" -Mode UninstallCheck -Destination "$INSTDIR"'
  !else
    ${If} $installMode == "all"
      MessageBox MB_OK|MB_ICONSTOP "为保护每个用户的书库，已中止全用户安装。请用原用户普通权限安装。" /SD IDOK
      SetErrorLevel 73
      Quit
    ${EndIf}
    ${If} ${isDeleteAppData}
      MessageBox MB_OK|MB_ICONSTOP "NeoRead 数据保护禁止 --delete-app-data。" /SD IDOK
      SetErrorLevel 73
      Quit
    ${EndIf}
    SetShellVarContext current
    !ifdef UNINSTALL_REGISTRY_KEY_2
      !define NEOREAD_SECOND_UNINSTALL_KEY "${UNINSTALL_REGISTRY_KEY_2}"
    !else
      !define NEOREAD_SECOND_UNINSTALL_KEY ""
    !endif
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\neoread-upgrade-protection.ps1" -Mode Install -Destination "$INSTDIR" -UserData "$APPDATA\NeoRead" -BackupRoot "$LOCALAPPDATA\NeoRead Upgrade Backups" -Manifest "$PLUGINSDIR\neoread-program-files.json" -InstallRegistryKey "${INSTALL_REGISTRY_KEY}" -UninstallRegistryKey "${UNINSTALL_REGISTRY_KEY}" -UninstallRegistryKey2 "${NEOREAD_SECOND_UNINSTALL_KEY}" -UninstallerName "${UNINSTALL_FILENAME}"'
    !undef NEOREAD_SECOND_UNINSTALL_KEY
  !endif
  !insertmacro neoreadRequireProtectionSuccess
!macroend

!macro customUnInit
  ; Even an explicit switch must not reactivate upstream's recursive AppData deletion.
  ${If} ${isDeleteAppData}
    MessageBox MB_OK|MB_ICONSTOP "NeoRead 卸载只移除已知程序文件，禁止 --delete-app-data。" /SD IDOK
    SetErrorLevel 73
    Quit
  ${EndIf}
!macroend

!macro customRemoveFiles
  !insertmacro neoreadExtractProtection
  SetOutPath $PLUGINSDIR
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\neoread-upgrade-protection.ps1" -Mode Clean -Destination "$INSTDIR" -Manifest "$PLUGINSDIR\neoread-program-files.json" -UninstallerName "${UNINSTALL_FILENAME}"'
  !insertmacro neoreadRequireProtectionSuccess
!macroend

!macro neoreadRegisterType EXT PROGID DESCRIPTION
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}" "" "${DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".${EXT}" ""
!macroend

!macro neoreadUnregisterType EXT PROGID
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${PROGID}"
!macroend

!macro customInstall
  !insertmacro neoreadRegisterType "pdf" "NeoRead.pdf" "PDF Document"
  !insertmacro neoreadRegisterType "epub" "NeoRead.epub" "EPUB Book"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$appExe" "%1"'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro neoreadUnregisterType "pdf" "NeoRead.pdf"
  !insertmacro neoreadUnregisterType "epub" "NeoRead.epub"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
