; Lists NeoRead under "Open with" for PDF and EPUB. The builder's own file
; associations also set each extension's default type and leave it dangling
; after uninstall, so only ProgIDs and OpenWithProgids are written here; users
; choose the default app in Windows.

; The upgrade-protection preflight must run on every path that reaches
; uninstallOldVersion with a usable $INSTDIR, because builder 26.17.0 skips
; CHECK_APP_RUNNING inside elevated (inner UAC) instances:
;   - outer instance: customCheckAppRunning, unchanged (per-user GUI,
;     all-users GUI started as admin, already-elevated silent upgrades);
;   - inner GUI instance (user picked "all users" without admin):
;     customPageAfterChangeDir right after the directory page;
;   - inner silent instance (the install section elevated a per-machine
;     upgrade): customInit after forcing the per-machine mode.
; Each instance reaches exactly one of those hooks, so the snapshot preflight
; runs exactly once per install.

!macro customInit
  ; A silent inner instance only exists when installer.nsi's install section
  ; elevated a per-machine upgrade, so re-forcing the mode here is safe. The
  ; section repeats setInstallModePerAllUsers later (idempotent) and resets
  ; $INSTDIR, so do NOT sanitize $INSTDIR in this branch; the preflight and
  ; the real install share the variable either way.
  ${If} ${UAC_IsInnerInstance}
    ${AndIf} ${Silent}
    !ifndef BUILD_UNINSTALLER
      !insertmacro setInstallModePerAllUsers
      !insertmacro neoreadExtractProtection
      !insertmacro neoreadRunInstallProtection
    !endif
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
    !ifdef BUILD_UNINSTALLER
      MessageBox MB_OK|MB_ICONSTOP "卸载未完成。请正常退出 NeoRead 后重试；若仍失败，请记录下方错误信息。错误：$1" /SD IDOK
    !else
      MessageBox MB_OK|MB_ICONSTOP "安装检查未通过。请正常退出 NeoRead 和后台任务后重试；若书库或未知文件位于程序目录内，请先迁移到外部目录。错误：$1" /SD IDOK
    !endif
    SetErrorLevel 73
    Quit
  ${EndIf}
!macroend

; Mirror assistedInstaller.nsh instFilesPre (same !ifdef guard, same
; APP_FILENAME subfolder rule). Our hidden page runs BEFORE that MUI PRE
; callback fixes $INSTDIR, and the preflight must see the final directory.
!macro neoreadSanitizeInstallDir
  !ifdef allowToChangeInstallationDirectory
    ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
    ${If} $0 == ""
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${EndIf}
  !endif
!macroend

; Full install preflight. The snapshot must always describe the ORIGINAL
; user's data, so SetShellVarContext current keeps $APPDATA/$LOCALAPPDATA on
; the elevating user during the call; afterwards restore the context chosen
; by $installMode so later SHELL_CONTEXT writes hit the intended registry
; hive (HKLM for all-users installs, HKCU otherwise).
!macro neoreadRunInstallProtection
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
  ${If} $installMode == "all"
    SetShellVarContext all
  ${Else}
    SetShellVarContext current
  ${EndIf}
  !insertmacro neoreadRequireProtectionSuccess
!macroend

; installSection.nsh calls this AFTER final directory selection (also /S /D),
; BEFORE uninstallOldVersion and installApplicationFiles. No process is killed.
; Only outer instances reach it; upstream skips it for inner instances.
!macro customCheckAppRunning
  !insertmacro neoreadExtractProtection
  !ifdef BUILD_UNINSTALLER
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\neoread-upgrade-protection.ps1" -Mode UninstallCheck -Destination "$INSTDIR"'
    !insertmacro neoreadRequireProtectionSuccess
  !else
    !insertmacro neoreadRunInstallProtection
  !endif
!macroend

; Hidden custom page between the directory page and instfiles: the only point
; where an elevated inner GUI instance has a final $INSTDIR before files are
; touched. Silent runs skip page callbacks entirely (they preflight in
; customInit) and outer instances keep using customCheckAppRunning.
!macro customPageAfterChangeDir
  PageEx custom
    PageCallbacks neoreadInnerInstallPreflight
  PageExEnd
!macroend

; This file is compiled before the NSIS templates, but function bodies may
; only be compiled after UAC/LogicLib/StrContents are included by them, so
; define the callback from customHeader: installer.nsi expands it after
; including assistedInstaller.nsh and before .onInit.
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Function neoreadInnerInstallPreflight
      ${If} ${UAC_IsInnerInstance}
        ${AndIfNot} ${Silent}
        !insertmacro neoreadSanitizeInstallDir
        !insertmacro neoreadExtractProtection
        !insertmacro neoreadRunInstallProtection
      ${EndIf}
      Abort ; preflight hook only, the page itself is never shown
    FunctionEnd
  !endif
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
