; Included in the NSIS installer (electron-builder.yml, nsis.include).

; Electron refuses to start from a folder whose permissions have an entry for an AppContainer package but none for
; ALL APPLICATION PACKAGES (S-1-15-2-1): Windows would deny its sandboxed processes access. Give it read access to the
; install folder, inherited by what it holds, on every install and update (electron-updater runs this installer too).
; Hive checks again at start (src/main/installDir.ts), for a folder changed after installing.
;
; A local build's installer (#1647: npm run dist sets HIVE_LOCAL_BUILD=1, the release workflow 0; scripts/appIdentity.mjs)
; also drops a downloaded update Hive was keeping (hive-updater\pending), so it isn't installed over this build later.
!macro customInstall
  nsExec::Exec '"$SYSDIR\icacls.exe" "$INSTDIR" /grant *S-1-15-2-1:(OI)(CI)(RX)'
  Pop $0
  !ifdef HIVE_LOCAL_BUILD
    RMDir /r "$LOCALAPPDATA\hive-updater\pending"
  !endif
!macroend

!if "$%HIVE_LOCAL_BUILD%" == "1"
  !define HIVE_LOCAL_BUILD
!endif

; A local build's installer waits for another installer of Hive to finish, then installs, so it is the last (#1647).
; Every installer electron-builder makes for this app (the published releases' too) holds the mutex named ${APP_GUID}
; (from appId) from its .onInit until it exits, and one that finds it held quits (ALLOW_ONLY_ONE_INSTALLER_INSTANCE,
; silently under /S). On 23 Oct a running 0.9.2 ran its downloaded 0.9.3 release installer as it quit (--updated /S),
; and the user's local build of 0.9.3 didn't end up installed. preInit runs before the template takes the mutex: it
; waits for one held (at most 10 minutes), then lets it go for the template to take; a release installer finding it
; held then quits, as before. Only the outer installer waits (never the uninstaller's build, nor the elevated inner
; instance the outer one started). A timeout or a failing call installs nothing and says so (exit code 3).
!ifdef HIVE_LOCAL_BUILD
!ifndef BUILD_UNINSTALLER
; How long it waits (ms): a test harness shortens it (tests/installer, #1647).
!define /ifndef HIVE_INSTALLER_WAIT_MS 600000
LangString hiveInstallerBusy 1033 "Another Hive installer is still running, or Hive couldn't tell whether one is. Nothing was installed: run this installer again once the other one has finished."
LangString hiveInstallerBusy 1031 "Ein anderes Hive-Installationsprogramm läuft noch, oder Hive konnte nicht feststellen, ob eines läuft. Es wurde nichts installiert: Starten Sie dieses Installationsprogramm erneut, sobald das andere fertig ist."
LangString hiveInstallerBusy 3082 "Todavía se está ejecutando otro instalador de Hive, o Hive no ha podido saber si lo hay. No se ha instalado nada: vuelve a ejecutar este instalador cuando el otro haya terminado."
LangString hiveInstallerBusy 1036 "Un autre programme d'installation de Hive est encore en cours, ou Hive n'a pas pu savoir s'il y en a un. Rien n'a été installé : relancez ce programme d'installation une fois l'autre terminé."
LangString hiveInstallerBusy 1041 "別の Hive インストーラーがまだ実行中か、実行中かどうかを確認できませんでした。何もインストールされていません。もう一方が終了してから、このインストーラーをもう一度実行してください。"
LangString hiveInstallerBusy 1045 "Inny instalator Hive nadal działa albo Hive nie mógł ustalić, czy działa. Nic nie zostało zainstalowane: uruchom ten instalator ponownie, gdy tamten się zakończy."
LangString hiveInstallerBusy 1046 "Outro instalador do Hive ainda está em execução, ou o Hive não conseguiu saber se há um. Nada foi instalado: execute este instalador de novo quando o outro terminar."
LangString hiveInstallerBusy 2052 "另一个 Hive 安装程序仍在运行，或者 Hive 无法确定是否有安装程序在运行。未安装任何内容：请在另一个安装程序结束后重新运行此安装程序。"

!macro preInit
  ${IfNot} ${UAC_IsInnerInstance}
    StrCpy $4 "go"
    ; SYNCHRONIZE (0x00100000) and MUTEX_MODIFY_STATE (0x0001): to wait for the mutex, then release it.
    System::Call 'kernel32::OpenMutexW(i 0x00100001, i 0, w "${APP_GUID}") i.r1 ?e'
    Pop $0
    ${If} $1 = 0
      ; Only "no such mutex" (ERROR_FILE_NOT_FOUND) means no installer of Hive runs: any other error is a failure.
      ${If} $0 <> 2
        StrCpy $4 "fail"
      ${EndIf}
    ${Else}
      ; WAIT_OBJECT_0 (0), or WAIT_ABANDONED (0x80: its installer ended without letting it go): ours now, let go so the
      ; template takes it. WAIT_TIMEOUT (0x102) or WAIT_FAILED: nothing installed.
      System::Call 'kernel32::WaitForSingleObject(i r1, i ${HIVE_INSTALLER_WAIT_MS}) i.r2'
      ${If} $2 = 0
      ${OrIf} $2 = 0x80
        System::Call 'kernel32::ReleaseMutex(i r1) i.r3'
        ${If} $3 = 0
          StrCpy $4 "fail"
        ${EndIf}
      ${Else}
        StrCpy $4 "fail"
      ${EndIf}
      System::Call 'kernel32::CloseHandle(i r1) i.r3'
      ${If} $3 = 0
        StrCpy $4 "fail"
      ${EndIf}
      ; The mutex outlives its installer until the last handle to it is closed (the ended process's, as Windows cleans it
      ; up), and the template's CreateMutex would find it and quit: wait until it is gone (at most 10 s, else nothing
      ; installed). Seen in the Sandbox check (tests/installer).
      ${If} $4 == "go"
        StrCpy $4 "fail"
        ${For} $2 1 100
          System::Call 'kernel32::OpenMutexW(i 0x00100000, i 0, w "${APP_GUID}") i.r1 ?e'
          Pop $0
          ${If} $1 = 0
            ${If} $0 = 2
              StrCpy $4 "go"
            ${EndIf}
            ${Break}
          ${EndIf}
          System::Call 'kernel32::CloseHandle(i r1)'
          Sleep 100
        ${Next}
      ${EndIf}
    ${EndIf}
    ${If} $4 == "fail"
      MessageBox MB_OK|MB_ICONSTOP "$(hiveInstallerBusy)" /SD IDOK
      SetErrorLevel 3
      Quit
    ${EndIf}
  ${EndIf}
!macroend
!endif
!endif

; Before the template's check ends a running Hive (HI-1707): the Hive of this install folder is asked to close for the
; install, so it records its agents and tells them, and resumes them when it starts again (hiveAskToClose.ps1 says how).
; Its result goes to the installer's log only: whatever it was, the template's check runs after it as before, ending a
; Hive that didn't close. The outer instance only (the user's, whose profile Hive's is), never the uninstaller.
!ifndef BUILD_UNINSTALLER
; This file's folder (build), as it is included: inside the macro, __FILEDIR__ would be where the macro is inserted.
!define HIVE_BUILD_DIR "${__FILEDIR__}"
!macro customInit
  ${IfNot} ${UAC_IsInnerInstance}
    InitPluginsDir
    File "/oname=$PLUGINSDIR\hiveAskToClose.ps1" "${HIVE_BUILD_DIR}\hiveAskToClose.ps1"
    nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\hiveAskToClose.ps1" -InstallDir "$INSTDIR"'
    Pop $0
    DetailPrint "Asked Hive to close for the install: $0"
  ${EndIf}
!macroend
!endif
