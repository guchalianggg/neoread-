; Lists Reader under "Open with" for PDF and EPUB. The builder's own file
; associations also set each extension's default type and leave it dangling
; after uninstall, so only ProgIDs and OpenWithProgids are written here; users
; choose the default app in Windows.

; The stopped-process check runs on every path that reaches
; uninstallOldVersion with a usable $INSTDIR, because builder 26.17.0 skips
; CHECK_APP_RUNNING inside elevated (inner UAC) instances:
;   - outer instance: customCheckAppRunning, unchanged (per-user GUI,
;     all-users GUI started as admin, already-elevated silent upgrades);
;   - inner GUI instance (user picked "all users" without admin):
;     the instfiles page PRE callback, after final directory selection;
;   - inner silent instance (the install section elevated a per-machine
;     upgrade): customInit after forcing the per-machine mode.
; Each instance reaches exactly one hook. No library scan, unknown-file
; gate or mandatory snapshot is performed during installation.

!ifndef BUILD_UNINSTALLER
  Var neoreadStartMenuBefore
  Var neoreadDesktopBefore
!endif
!macro customInit
  ; A silent inner instance only exists when installer.nsi's install section
  ; elevated a per-machine upgrade, so re-forcing the mode here is safe. The
  ; section repeats setInstallModePerAllUsers later (idempotent) and resets
  ; $INSTDIR, so do NOT sanitize it here; the process check and
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
      !error "Reader protection requires a single-architecture installer"
    !endif
    !ifdef APP_ARM64
      !error "Reader protection requires a single-architecture installer"
    !endif
    File /oname=$PLUGINSDIR\neoread-program-files.json "${BUILD_RESOURCES_DIR}\program-files-x64.json"
  !else ifdef APP_ARM64
    !ifdef APP_32
      !error "Reader protection requires a single-architecture installer"
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
      MessageBox MB_OK|MB_ICONSTOP "卸载未完成。请正常退出 Reader 后重试；若仍失败，请记录下方错误信息。错误：$1" /SD IDOK
    !else
      MessageBox MB_OK|MB_ICONSTOP "安装未完成。请正常退出 Reader 和后台任务后重试；若仍失败，请记录下方错误信息。错误：$1" /SD IDOK
    !endif
    SetErrorLevel 73
    Quit
  ${EndIf}
!macroend

; Snapshot only builder-managed paths, in its selected shell context. A
; registered upgrade can recreate a deleted link because builder tests for
; the NEW app exe when deciding whether to preserve links. Remember absences
; so customInstall can undo only those new links. A preexisting different
; destination may be an unrelated same-name shortcut; do not repair it.
!macro neoreadRememberLink OLD_LINK NEW_LINK STATE
  ${If} ${FileExists} "${NEW_LINK}"
    ${If} "${OLD_LINK}" != "${NEW_LINK}"
      StrCpy ${STATE} "collision"
    ${EndIf}
  ${ElseIfNot} ${FileExists} "${OLD_LINK}"
    StrCpy ${STATE} "absent"
  ${EndIf}
!macroend

!macro neoreadRememberUpgradeLinks
  ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "KeepShortcuts"
  ReadRegStr $1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $0 == "true"
  ${AndIf} $1 != ""
    !insertmacro setLinkVars
    !insertmacro neoreadRememberLink $oldStartMenuLink $newStartMenuLink $neoreadStartMenuBefore
    !insertmacro neoreadRememberLink $oldDesktopLink $newDesktopLink $neoreadDesktopBefore
  ${EndIf}
!macroend

; Only require the application to be stopped. Do not inspect the old program
; tree, read library settings or create mandatory upgrade snapshots.
!macro neoreadRunInstallProtection
  ${If} ${isDeleteAppData}
    MessageBox MB_OK|MB_ICONSTOP "Reader 数据保护禁止 --delete-app-data。" /SD IDOK
    SetErrorLevel 73
    Quit
  ${EndIf}
  !ifdef UNINSTALL_REGISTRY_KEY_2
    !define NEOREAD_SECOND_UNINSTALL_ARG '-UninstallRegistryKey2 "${UNINSTALL_REGISTRY_KEY_2}"'
  !else
    !define NEOREAD_SECOND_UNINSTALL_ARG ""
  !endif
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\neoread-upgrade-protection.ps1" -Mode CheckStopped -Destination "$INSTDIR" -InstallRegistryKey "${INSTALL_REGISTRY_KEY}" -UninstallRegistryKey "${UNINSTALL_REGISTRY_KEY}" ${NEOREAD_SECOND_UNINSTALL_ARG}'
  !undef NEOREAD_SECOND_UNINSTALL_ARG
  !insertmacro neoreadRequireProtectionSuccess
  !insertmacro neoreadRememberUpgradeLinks
!macroend

; installSection.nsh calls this AFTER final directory selection (also /S /D),
; BEFORE uninstallOldVersion and installApplicationFiles. No process is killed.
; Only outer instances reach it; upstream skips it for inner instances.
!macro customCheckAppRunning
  !insertmacro neoreadExtractProtection
  !ifdef BUILD_UNINSTALLER
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\neoread-upgrade-protection.ps1" -Mode CheckStopped -Destination "$INSTDIR"'
    !insertmacro neoreadRequireProtectionSuccess
  !else
    !insertmacro neoreadRunInstallProtection
  !endif
!macroend

; Replace the assisted installer's PRE callback, not its directory page.
; multiUser.nsh loads the registered path into $INSTDIR; instFilesPre would
; append \Reader to e.g. ...\NeoRead. Skip that normalization only if the
; chosen directory is still the registered directory for this shell context.
!macro customPageAfterChangeDir
  !ifdef allowToChangeInstallationDirectory
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_PRE neoreadInstFilesPre
!macroend

; Compile the callback after assistedInstaller.nsh defines instFilesPre.
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !ifndef ONE_CLICK
      Function neoreadInstFilesPre
        !ifdef allowToChangeInstallationDirectory
          ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
          ${If} $INSTDIR != $0
            Call instFilesPre
          ${EndIf}
        !endif
        ${If} ${UAC_IsInnerInstance}
          !insertmacro neoreadExtractProtection
          !insertmacro neoreadRunInstallProtection
        ${EndIf}
      FunctionEnd
    !endif
  !endif
!macroend

!macro customUnInit
  ; Even an explicit switch must not reactivate upstream's recursive AppData deletion.
  ${If} ${isDeleteAppData}
    MessageBox MB_OK|MB_ICONSTOP "Reader 卸载只移除已知程序文件，禁止 --delete-app-data。" /SD IDOK
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

; Only the preserve branch needs a repair: Rename moves the .lnk without
; changing its target or icon. The normal create branch already sets both.
!macro neoreadFinishManagedLink LINK STATE
  ${If} ${FileExists} "${LINK}"
    ${If} ${STATE} == "absent"
      Delete "${LINK}"
    ${ElseIf} $keepShortcuts == "true"
    ${AndIf} ${STATE} != "collision"
      ClearErrors
      CreateShortCut "${LINK}" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ${IfNot} ${Errors}
        WinShell::SetLnkAUMI "${LINK}" "${APP_ID}"
      ${EndIf}
      ClearErrors
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  ; installSection.nsh calls customInstall after both default add macros.
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    !insertmacro neoreadFinishManagedLink $newStartMenuLink $neoreadStartMenuBefore
    ; Builder picked $launchLink before this hook. Never launch a deleted
    ; shortcut or a different, preexisting .lnk that prevented its rename.
    ${If} $neoreadStartMenuBefore == "absent"
      StrCpy $launchLink "$appExe"
    ${ElseIf} $keepShortcuts == "true"
    ${AndIf} $neoreadStartMenuBefore == "collision"
      StrCpy $launchLink "$appExe"
    ${EndIf}
  !endif
  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    ${IfNot} ${isNoDesktopShortcut}
      !insertmacro neoreadFinishManagedLink $newDesktopLink $neoreadDesktopBefore
    ${EndIf}
  !endif

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
