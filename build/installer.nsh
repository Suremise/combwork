; Included in the NSIS installer (electron-builder.yml, nsis.include).

; Electron refuses to start from a folder whose permissions have an entry for an AppContainer package but none for
; ALL APPLICATION PACKAGES (S-1-15-2-1): Windows would deny its sandboxed processes access. Give it read access to the
; install folder, inherited by what it holds, on every install and update (electron-updater runs this installer too).
; Combwork checks again at start (src/main/installDir.ts), for a folder changed after installing.
;
; A local build's installer (#1647: npm run dist sets CW_LOCAL_BUILD=1, the release workflow 0; scripts/appIdentity.mjs)
; also drops a downloaded update Combwork was keeping (combwork-updater\pending, electron-updater's cache named after
; package.json's name; hive-updater\pending before HI-2591), so it isn't installed over this build later.
!macro customInstall
  nsExec::Exec '"$SYSDIR\icacls.exe" "$INSTDIR" /grant *S-1-15-2-1:(OI)(CI)(RX)'
  Pop $0
  !ifdef CW_LOCAL_BUILD
    RMDir /r "$LOCALAPPDATA\combwork-updater\pending"
    RMDir /r "$LOCALAPPDATA\hive-updater\pending"
  !endif
!macroend

!if "$%CW_LOCAL_BUILD%" == "1"
  !define CW_LOCAL_BUILD
!endif

; A local build's installer waits for another installer of Combwork to finish, then installs, so it is the last (#1647).
; Every installer electron-builder makes for this app (the published releases' too) holds the mutex named ${APP_GUID}
; (from appId) from its .onInit until it exits, and one that finds it held quits (ALLOW_ONLY_ONE_INSTALLER_INSTANCE,
; silently under /S). On 23 Oct a running 0.9.2 ran its downloaded 0.9.3 release installer as it quit (--updated /S),
; and the user's local build of 0.9.3 didn't end up installed. preInit runs before the template takes the mutex: it
; waits for one held (at most 10 minutes), then lets it go for the template to take; a release installer finding it
; held then quits, as before. Only the outer installer waits (never the uninstaller's build, nor the elevated inner
; instance the outer one started). A timeout or a failing call installs nothing and says so (exit code 3).
!ifdef CW_LOCAL_BUILD
!ifndef BUILD_UNINSTALLER
; How long it waits (ms): a test harness shortens it (tests/installer, #1647).
!define /ifndef CW_INSTALLER_WAIT_MS 600000
LangString combworkInstallerBusy 1033 "Another Combwork installer is still running, or Combwork couldn't tell whether one is. Nothing was installed: run this installer again once the other one has finished."
LangString combworkInstallerBusy 1031 "Ein anderes Combwork-Installationsprogramm läuft noch, oder Combwork konnte nicht feststellen, ob eines läuft. Es wurde nichts installiert: Starten Sie dieses Installationsprogramm erneut, sobald das andere fertig ist."
LangString combworkInstallerBusy 3082 "Todavía se está ejecutando otro instalador de Combwork, o Combwork no ha podido saber si lo hay. No se ha instalado nada: vuelve a ejecutar este instalador cuando el otro haya terminado."
LangString combworkInstallerBusy 1036 "Un autre programme d'installation de Combwork est encore en cours, ou Combwork n'a pas pu savoir s'il y en a un. Rien n'a été installé : relancez ce programme d'installation une fois l'autre terminé."
LangString combworkInstallerBusy 1041 "別の Combwork インストーラーがまだ実行中か、実行中かどうかを確認できませんでした。何もインストールされていません。もう一方が終了してから、このインストーラーをもう一度実行してください。"
LangString combworkInstallerBusy 1045 "Inny instalator Combwork nadal działa albo Combwork nie mógł ustalić, czy działa. Nic nie zostało zainstalowane: uruchom ten instalator ponownie, gdy tamten się zakończy."
LangString combworkInstallerBusy 1046 "Outro instalador do Combwork ainda está em execução, ou o Combwork não conseguiu saber se há um. Nada foi instalado: execute este instalador de novo quando o outro terminar."
LangString combworkInstallerBusy 2052 "另一个 Combwork 安装程序仍在运行，或者 Combwork 无法确定是否有安装程序在运行。未安装任何内容：请在另一个安装程序结束后重新运行此安装程序。"

!macro preInit
  ${IfNot} ${UAC_IsInnerInstance}
    StrCpy $4 "go"
    ; SYNCHRONIZE (0x00100000) and MUTEX_MODIFY_STATE (0x0001): to wait for the mutex, then release it.
    System::Call 'kernel32::OpenMutexW(i 0x00100001, i 0, w "${APP_GUID}") i.r1 ?e'
    Pop $0
    ${If} $1 = 0
      ; Only "no such mutex" (ERROR_FILE_NOT_FOUND) means no installer of Combwork runs: any other error is a failure.
      ${If} $0 <> 2
        StrCpy $4 "fail"
      ${EndIf}
    ${Else}
      ; WAIT_OBJECT_0 (0), or WAIT_ABANDONED (0x80: its installer ended without letting it go): ours now, let go so the
      ; template takes it. WAIT_TIMEOUT (0x102) or WAIT_FAILED: nothing installed.
      System::Call 'kernel32::WaitForSingleObject(i r1, i ${CW_INSTALLER_WAIT_MS}) i.r2'
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
      MessageBox MB_OK|MB_ICONSTOP "$(combworkInstallerBusy)" /SD IDOK
      SetErrorLevel 3
      Quit
    ${EndIf}
  ${EndIf}
!macroend
!endif
!endif

; The upgrade from Hive Desktop (HI-2460, SPEC §4.3), before anything is installed. The outer instance only (the user's,
; whose profile and Hive Desktop's per-user install these are), never the uninstaller.
; 1. Hive Desktop's installer identity is held too: its mutex (1.0's APP_GUID, from appId com.hive.desktop) taken and
;    kept until this installer exits, so a 1.0 installer or updater started meanwhile finds it held and quits; one
;    running now is waited for (at most CW_LEGACY_WAIT_MS). WAIT_ABANDONED counts as taken. electron-builder's
;    uninstaller never takes its installer's mutex (ALLOW_ONLY_ONE_INSTALLER_INSTANCE is the installer's), so Combwork
;    Desktop's uninstaller, run below, isn't held up by it. Any failing call: nothing changed (exit 4).
; 2. hiveUpgrade.ps1: the apps of both installations asked to close (askToClose.ps1, HI-1707: they record their
;    agents and resume them at the next start) and checked to have exited, Hive Desktop removed with its data kept, and
;    the profile folders moved (with the installer's record, HI-2461). It says why it stopped: an app still running
;    (exit 5, nothing changed) or Hive Desktop not removed (exit 6, the profile folders untouched); the installer stops
;    then too, saying so, and nothing is installed. Its lines go to the installer's log.
!ifndef BUILD_UNINSTALLER
; This file's folder (build), as it is included: inside the macro, __FILEDIR__ would be where the macro is inserted.
!define CW_BUILD_DIR "${__FILEDIR__}"
!define LEGACY_GUID "35960567-b95c-520c-a9f1-e8bb85764724"
; How long a held Hive Desktop installer mutex is waited for (ms): 10 minutes, or 20 s in an installer built for the
; Sandbox's refusal check (CW_TEST_SHORT_LEGACY_WAIT=1 in npm run dist's environment; a release never sets it).
!if "$%CW_TEST_SHORT_LEGACY_WAIT%" == "1"
  !define CW_LEGACY_WAIT_MS 20000
!else
  !define CW_LEGACY_WAIT_MS 600000
!endif

LangString hiveLegacyBusy 1033 "A Hive Desktop installer is still running, or Combwork couldn't tell whether one is. Nothing was installed: run this installer again once the other one has finished."
LangString hiveLegacyBusy 1031 "Ein Hive-Desktop-Installationsprogramm läuft noch, oder Combwork konnte nicht feststellen, ob eines läuft. Es wurde nichts installiert: Starten Sie dieses Installationsprogramm erneut, sobald das andere fertig ist."
LangString hiveLegacyBusy 3082 "Todavía se está ejecutando un instalador de Hive Desktop, o Combwork no ha podido saber si lo hay. No se ha instalado nada: vuelve a ejecutar este instalador cuando el otro haya terminado."
LangString hiveLegacyBusy 1036 "Un programme d'installation de Hive Desktop est encore en cours, ou Combwork n'a pas pu savoir s'il y en a un. Rien n'a été installé : relancez ce programme d'installation une fois l'autre terminé."
LangString hiveLegacyBusy 1041 "Hive Desktop のインストーラーがまだ実行中か、実行中かどうかを Combwork が確認できませんでした。何もインストールされていません。もう一方が終了してから、このインストーラーをもう一度実行してください。"
LangString hiveLegacyBusy 1045 "Instalator Hive Desktop nadal działa albo Combwork nie mógł ustalić, czy działa. Nic nie zostało zainstalowane: uruchom ten instalator ponownie, gdy tamten się zakończy."
LangString hiveLegacyBusy 1046 "Um instalador do Hive Desktop ainda está em execução, ou o Combwork não conseguiu saber se há um. Nada foi instalado: execute este instalador de novo quando o outro terminar."
LangString hiveLegacyBusy 2052 "Hive Desktop 安装程序仍在运行，或者 Combwork 无法确定是否有安装程序在运行。未安装任何内容：请在另一个安装程序结束后重新运行此安装程序。"

LangString combworkStillRunning 1033 "Combwork or Hive Desktop is still running. Nothing was installed: close it, then run this installer again."
LangString combworkStillRunning 1031 "Combwork oder Hive Desktop läuft noch. Es wurde nichts installiert: Schließen Sie das Programm und starten Sie dieses Installationsprogramm erneut."
LangString combworkStillRunning 3082 "Combwork o Hive Desktop todavía se está ejecutando. No se ha instalado nada: ciérralo y vuelve a ejecutar este instalador."
LangString combworkStillRunning 1036 "Combwork ou Hive Desktop est encore en cours d'exécution. Rien n'a été installé : fermez-le, puis relancez ce programme d'installation."
LangString combworkStillRunning 1041 "Combwork または Hive Desktop がまだ実行中です。何もインストールされていません。終了してから、このインストーラーをもう一度実行してください。"
LangString combworkStillRunning 1045 "Combwork lub Hive Desktop nadal działa. Nic nie zostało zainstalowane: zamknij program, a potem uruchom ten instalator ponownie."
LangString combworkStillRunning 1046 "O Combwork ou o Hive Desktop ainda está em execução. Nada foi instalado: feche-o e execute este instalador de novo."
LangString combworkStillRunning 2052 "Combwork 或 Hive Desktop 仍在运行。未安装任何内容：请关闭它，然后重新运行此安装程序。"

LangString hiveOldNotRemoved 1033 "Hive Desktop couldn't be uninstalled, so Combwork wasn't installed and your data folders weren't moved. Its uninstall may have stopped partway: check Installed apps, then run this installer again."
LangString hiveOldNotRemoved 1031 "Hive Desktop konnte nicht deinstalliert werden, daher wurde Combwork nicht installiert und Ihre Datenordner wurden nicht verschoben. Die Deinstallation wurde möglicherweise unterbrochen: Prüfen Sie die installierten Apps und starten Sie dieses Installationsprogramm erneut."
LangString hiveOldNotRemoved 3082 "No se ha podido desinstalar Hive Desktop, así que no se ha instalado Combwork ni se han movido tus carpetas de datos. Puede que la desinstalación se haya detenido a medias: revisa las aplicaciones instaladas y vuelve a ejecutar este instalador."
LangString hiveOldNotRemoved 1036 "Hive Desktop n'a pas pu être désinstallé : Combwork n'a donc pas été installé et vos dossiers de données n'ont pas été déplacés. La désinstallation s'est peut-être arrêtée en cours de route : vérifiez les applications installées, puis relancez ce programme d'installation."
LangString hiveOldNotRemoved 1041 "Hive Desktop をアンインストールできなかったため、Combwork はインストールされず、データフォルダーも移動されていません。アンインストールが途中で止まった可能性があります。インストール済みのアプリを確認してから、このインストーラーをもう一度実行してください。"
LangString hiveOldNotRemoved 1045 "Nie udało się odinstalować Hive Desktop, więc Combwork nie został zainstalowany, a foldery danych nie zostały przeniesione. Deinstalacja mogła zatrzymać się w połowie: sprawdź zainstalowane aplikacje i uruchom ten instalator ponownie."
LangString hiveOldNotRemoved 1046 "Não foi possível desinstalar o Hive Desktop, então o Combwork não foi instalado e suas pastas de dados não foram movidas. A desinstalação pode ter parado no meio: verifique os aplicativos instalados e execute este instalador de novo."
LangString hiveOldNotRemoved 2052 "无法卸载 Hive Desktop，因此未安装 Combwork，也未移动你的数据文件夹。卸载可能中途停止：请检查已安装的应用，然后重新运行此安装程序。"

!macro customInit
  ${IfNot} ${UAC_IsInnerInstance}
    ; 1. Hive Desktop's installer mutex, kept open (and owned) until this installer exits.
    StrCpy $4 "go"
    System::Call 'kernel32::CreateMutexW(i 0, i 1, w "${LEGACY_GUID}") i.r1 ?e'
    Pop $0
    ${If} $1 = 0
      StrCpy $4 "fail"
    ${ElseIf} $0 = 183
      ; ERROR_ALREADY_EXISTS: another holds it (not ours yet). WAIT_OBJECT_0 (0) or WAIT_ABANDONED (0x80): ours now.
      System::Call 'kernel32::WaitForSingleObject(i r1, i ${CW_LEGACY_WAIT_MS}) i.r2'
      ${If} $2 <> 0
      ${AndIf} $2 <> 0x80
        StrCpy $4 "fail"
      ${EndIf}
    ${EndIf}
    ${If} $4 == "fail"
      DetailPrint "Hive Desktop's installer mutex: not taken (handle $1, error $0, wait $2)"
      MessageBox MB_OK|MB_ICONSTOP "$(hiveLegacyBusy)" /SD IDOK
      SetErrorLevel 4
      Quit
    ${EndIf}
    ; 2. The upgrade.
    InitPluginsDir
    File "/oname=$PLUGINSDIR\askToClose.ps1" "${CW_BUILD_DIR}\askToClose.ps1"
    File "/oname=$PLUGINSDIR\hiveUpgrade.ps1" "${CW_BUILD_DIR}\hiveUpgrade.ps1"
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\hiveUpgrade.ps1" -InstallDir "$INSTDIR" -WorkDir "$PLUGINSDIR"'
    Pop $0
    DetailPrint "The upgrade from Hive Desktop: $0"
    ${If} $0 == "5"
      MessageBox MB_OK|MB_ICONSTOP "$(combworkStillRunning)" /SD IDOK
      SetErrorLevel 5
      Quit
    ${ElseIf} $0 == "6"
      MessageBox MB_OK|MB_ICONSTOP "$(hiveOldNotRemoved)" /SD IDOK
      SetErrorLevel 6
      Quit
    ${ElseIf} $0 != "0"
      ; The script didn't run or ended unexpectedly ("error", a PowerShell failure): nothing it would do is known done.
      MessageBox MB_OK|MB_ICONSTOP "$(hiveOldNotRemoved)" /SD IDOK
      SetErrorLevel 6
      Quit
    ${EndIf}
  ${EndIf}
!macroend
!endif
