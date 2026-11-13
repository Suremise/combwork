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
  ; HI-3172: the install has finished (files, registry, shortcuts): its recovery isn't needed (cwDisarmRecovery, below).
  Call cwDisarmRecovery
  !ifdef CW_LOCAL_BUILD
    RMDir /r "$LOCALAPPDATA\combwork-updater\pending"
    RMDir /r "$LOCALAPPDATA\hive-updater\pending"
  !endif
!macroend

; HI-3167: an update Combwork runs as it quits (electron-updater: --updated, shown, not silent) shows only its progress and
; finish page. The "who should this be installed for" page (perMachine: false) would stop it half way, a question nobody
; expects as they quit: an update keeps the scope of the one copy installed (.onInit read the registry), so the page is
; skipped. With both or neither installed, the page asks, as for a first install. (The template looks the macro up as
; customInstallmode and inserts customInstallMode: NSIS macro names are case-insensitive.)
!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $hasPerUserInstallation == "1"
    ${andIf} $hasPerMachineInstallation == "0"
      StrCpy $isForceCurrentInstall "1"
    ${elseIf} $hasPerUserInstallation == "0"
    ${andIf} $hasPerMachineInstallation == "1"
      StrCpy $isForceMachineInstall "1"
    ${endIf}
  ${endIf}
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
; 2. legacyUpgrade.ps1: the apps of both installations asked to close (askToClose.ps1, HI-1707: they record their
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
    ; HI-3172: run at a sign-in to finish an interrupted update, it asks first (cwAskToResume, below).
    Call cwAskToResume
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
    File "/oname=$PLUGINSDIR\legacyUpgrade.ps1" "${CW_BUILD_DIR}\legacyUpgrade.ps1"
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\legacyUpgrade.ps1" -InstallDir "$INSTDIR" -WorkDir "$PLUGINSDIR"'
    Pop $0
    ; Every install logs it, a clean one too: it names no old app (HI-2632).
    DetailPrint "The upgrade from an earlier version: $0"
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
  ; HI-3172: a silent install shows no pages, so its recovery is armed here, by the instance that installs: a per-user
  ; install's outer one, a per-machine one's elevated one (the outer instance of a silent per-machine update elevates in
  ; the install section and quits). A shown install arms it in its last page instead (customPageAfterChangeDir).
  ${If} ${Silent}
    ${If} $installMode == "all"
      ${If} ${UAC_IsAdmin}
        Call cwArmRecovery
      ${EndIf}
    ${ElseIfNot} ${UAC_IsInnerInstance}
      Call cwArmRecovery
    ${EndIf}
  ${EndIf}
!macroend
!endif

; An update interrupted part-way (HI-3172, SPEC 11.1). electron-builder's install section runs the old copy's
; uninstaller, which deletes it, then extracts the new copy: a shutdown, power cut or killed installer in between left no
; Combwork. Without changing that order (the template's), this installer makes sure it is finished later:
; - Armed before anything is removed (cwArmRecovery: the last page of a shown install, after every page that can be
;   cancelled; customInit for a silent one), whenever there is something to lose (a copy installed in this scope, its
;   uninstall entry, a recovery already armed, or this being a resumed run): under a recovery lock, a copy of this
;   installer is staged and checked (recovery.ps1), swapped atomically onto Combwork-Setup.exe in the recovery folder, and
;   a Run value names it with this install's flags, scope and folder. Run values are never consumed: Windows runs it at
;   each sign-in until a finished install removes it, so any number of interruptions are retried.
; - Anything failing on the way refuses before anything is removed (exit 7, a message naming the step): what it staged
;   goes, an earlier armed recovery (its Run value and Combwork-Setup.exe) is never deleted.
; - Per-user: %LOCALAPPDATA%\combwork-resume and HKCU, locked by Global\CombworkRecovery-<APP_GUID>-<the user's SID>, so
;   the same user's other sessions wait. Per-machine (the elevated instance): ProgramData\Combwork\resume (recovery.ps1
;   creates or checks it, never changing what exists) and HKLM, locked by Global\CombworkRecovery-<APP_GUID>-machine.
;   Each lock is owned until this installer exits (through the install and cwDisarmRecovery), waited for at most
;   CW_RECOVERY_WAIT_MS; any failing call refuses. Their default security (the creator's token) keeps other users out;
;   one held by someone else forever times out and refuses.
; - A finished install (customInstall) deletes the Run value and the copy; a resumed run can't delete itself, so its copy
;   stays, inert, until the next install replaces or removes it.
; - Run at a sign-in (--cw-resume), it asks first (cwAskToResume); No leaves it for the next sign-in.
!ifndef BUILD_UNINSTALLER
!define CW_RECOVERY_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define CW_RECOVERY_VALUE "CombworkFinishUpdate"
!define CW_RECOVERY_FILE "Combwork-Setup.exe"
!define CW_RECOVERY_STAGED "Combwork-Setup.new.exe"
; How long a held recovery lock is waited for (ms): 10 minutes, or 20 s in an installer built for the Sandbox's lock check
; (CW_TEST_SHORT_RECOVERY_WAIT=1 in npm run dist's environment; a release never sets it).
; That build also writes C:\out\recovery-wait.txt as it starts waiting (the Sandbox's out folder): the check's signal.
!if "$%CW_TEST_SHORT_RECOVERY_WAIT%" == "1"
  !define /ifndef CW_RECOVERY_WAIT_MS 20000
  !define CW_RECOVERY_WAIT_SIGNAL "C:\out\recovery-wait.txt"
!else
  !define /ifndef CW_RECOVERY_WAIT_MS 600000
!endif

Var cwRecoveryArmed
Var cwRecoveryMachine
Var cwRecoveryDir

LangString combworkRecoveryFailed 1033 "Combwork couldn't set up a way to finish this update if it were interrupted, so nothing was changed: your Combwork still works. Run the installer again later. If this keeps happening, free some disk space or check the folder named below."
LangString combworkRecoveryFailed 1031 "Combwork konnte nicht vorsorgen, um dieses Update abzuschließen, falls es unterbrochen wird. Daher wurde nichts geändert: Ihr Combwork funktioniert weiterhin. Starten Sie das Installationsprogramm später erneut. Wenn das wiederholt passiert, schaffen Sie Speicherplatz frei oder prüfen Sie den unten genannten Ordner."
LangString combworkRecoveryFailed 3082 "Combwork no ha podido preparar una forma de terminar esta actualización si se interrumpiera, así que no se ha cambiado nada: tu Combwork sigue funcionando. Vuelve a ejecutar el instalador más tarde. Si sigue pasando, libera espacio en disco o revisa la carpeta indicada abajo."
LangString combworkRecoveryFailed 1036 "Combwork n'a pas pu prévoir de quoi terminer cette mise à jour si elle était interrompue : rien n'a donc été modifié, et votre Combwork fonctionne toujours. Relancez le programme d'installation plus tard. Si cela se reproduit, libérez de l'espace disque ou vérifiez le dossier indiqué ci-dessous."
LangString combworkRecoveryFailed 1041 "更新が中断された場合に完了させる準備ができなかったため、何も変更されていません。Combwork はそのまま使えます。後でもう一度インストーラーを実行してください。繰り返し起こる場合は、ディスクの空き容量を増やすか、下に示したフォルダーを確認してください。"
LangString combworkRecoveryFailed 1045 "Combwork nie mógł przygotować sposobu na dokończenie tej aktualizacji, gdyby została przerwana, więc nic nie zostało zmienione: Twój Combwork nadal działa. Uruchom instalator ponownie później. Jeśli to się powtarza, zwolnij miejsce na dysku lub sprawdź folder podany poniżej."
LangString combworkRecoveryFailed 1046 "O Combwork não conseguiu preparar uma forma de concluir esta atualização caso ela fosse interrompida, então nada foi alterado: seu Combwork continua funcionando. Execute o instalador de novo mais tarde. Se isso continuar acontecendo, libere espaço em disco ou verifique a pasta indicada abaixo."
LangString combworkRecoveryFailed 2052 "Combwork 无法预先准备在更新中断时完成更新的方法，因此未做任何更改：你的 Combwork 仍可正常使用。请稍后重新运行安装程序。如果反复出现，请释放磁盘空间或检查下面指出的文件夹。"

LangString combworkResumeAsk 1033 "Combwork's last update was interrupted before it finished, so Combwork may not start. Finish installing it now?"
LangString combworkResumeAsk 1031 "Das letzte Update von Combwork wurde unterbrochen, bevor es abgeschlossen war, daher startet Combwork möglicherweise nicht. Jetzt fertig installieren?"
LangString combworkResumeAsk 3082 "La última actualización de Combwork se interrumpió antes de terminar, así que puede que Combwork no se inicie. ¿Terminar de instalarla ahora?"
LangString combworkResumeAsk 1036 "La dernière mise à jour de Combwork a été interrompue avant la fin : Combwork risque de ne pas démarrer. Terminer l'installation maintenant ?"
LangString combworkResumeAsk 1041 "Combwork の前回の更新は完了前に中断されたため、Combwork が起動しない可能性があります。今すぐインストールを完了しますか?"
LangString combworkResumeAsk 1045 "Ostatnia aktualizacja Combwork została przerwana przed zakończeniem, więc Combwork może się nie uruchomić. Dokończyć instalację teraz?"
LangString combworkResumeAsk 1046 "A última atualização do Combwork foi interrompida antes de terminar, então o Combwork pode não abrir. Concluir a instalação agora?"
LangString combworkResumeAsk 2052 "Combwork 的上次更新在完成前被中断，因此 Combwork 可能无法启动。现在完成安装吗？"

LangString combworkResumeLater 1033 "Nothing was changed. You'll be asked again at your next sign-in. To finish it yourself, run $EXEPATH. To stop being asked, turn it off in Task Manager's Startup apps."
LangString combworkResumeLater 1031 "Es wurde nichts geändert. Sie werden bei der nächsten Anmeldung erneut gefragt. Um es selbst abzuschließen, führen Sie $EXEPATH aus. Damit nicht mehr gefragt wird, deaktivieren Sie es im Task-Manager unter Autostart-Apps."
LangString combworkResumeLater 3082 "No se ha cambiado nada. Se te volverá a preguntar al iniciar sesión la próxima vez. Para terminarla tú, ejecuta $EXEPATH. Para que deje de preguntarse, desactívalo en Aplicaciones de arranque del Administrador de tareas."
LangString combworkResumeLater 1036 "Rien n'a été modifié. La question vous sera reposée à votre prochaine connexion. Pour terminer vous-même, exécutez $EXEPATH. Pour ne plus être sollicité, désactivez-le dans les applications de démarrage du Gestionnaire des tâches."
LangString combworkResumeLater 1041 "何も変更されていません。次回サインイン時にもう一度確認されます。自分で完了するには $EXEPATH を実行してください。確認を止めるには、タスク マネージャーのスタートアップ アプリで無効にしてください。"
LangString combworkResumeLater 1045 "Nic nie zostało zmienione. Pytanie pojawi się ponownie przy następnym logowaniu. Aby dokończyć samodzielnie, uruchom $EXEPATH. Aby przestać być pytanym, wyłącz to w Menedżerze zadań w sekcji Aplikacje autostartu."
LangString combworkResumeLater 1046 "Nada foi alterado. Você será perguntado de novo no próximo login. Para concluir por conta própria, execute $EXEPATH. Para não ser mais perguntado, desative-o em Aplicativos de inicialização no Gerenciador de Tarefas."
LangString combworkResumeLater 2052 "未做任何更改。下次登录时会再次询问。要自行完成，请运行 $EXEPATH。若不想再被询问，请在任务管理器的启动应用中将其禁用。"

; The functions go in through customHeader: electron-builder includes this file ahead of its template, and they use
; what the template defines (LogicLib, $installMode, UNINSTALL_REGISTRY_KEY, UAC).
!macro customHeader
; Run with --cw-resume (the Run value, at a sign-in): asks before anything happens. No: quits, the recovery kept.
Function cwAskToResume
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--cw-resume" $R1
  ${If} ${Errors}
    Return
  ${EndIf}
  MessageBox MB_YESNO|MB_ICONQUESTION "$(combworkResumeAsk)" /SD IDYES IDYES cwResumeGo
  MessageBox MB_OK|MB_ICONINFORMATION "$(combworkResumeLater)" /SD IDOK
  SetErrorLevel 8
  Quit
  cwResumeGo:
FunctionEnd

; The current user's SID as a string, in $R1 ("" if it can't be read).
Function cwUserSid
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  StrCpy $R1 ""
  System::Call 'kernel32::GetCurrentProcess() p.r1'
  ; TOKEN_QUERY (8); TokenUser (1): a TOKEN_USER, whose first field points at the SID.
  System::Call 'advapi32::OpenProcessToken(p r1, i 8, *p .r2) i.r3'
  ${If} $3 <> 0
    System::Call 'advapi32::GetTokenInformation(p r2, i 1, p 0, i 0, *i .r4)'
    ${If} $4 > 0
      System::Alloc $4
      Pop $5
      System::Call 'advapi32::GetTokenInformation(p r2, i 1, p r5, i r4, *i .r4) i.r3'
      ${If} $3 <> 0
        System::Call '*$5(p .r1)'
        System::Call 'advapi32::ConvertSidToStringSidW(p r1, *p .r3) i.r4'
        ${If} $4 <> 0
          System::Call 'kernel32::lstrcpynW(w .R1, p r3, i ${NSIS_MAX_STRLEN})'
          System::Call 'kernel32::LocalFree(p r3)'
        ${EndIf}
      ${EndIf}
      System::Free $5
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r2)'
  ${EndIf}
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
FunctionEnd

; Refuses the install before anything is removed: the message, with the step ($R2), and exit 7. It deletes nothing: a
; refusal can come before this run holds the lock or after recovery.ps1 found the path untrusted (a junction), so a file
; there may be another installer's, or outside the recovery folder. recovery.ps1 removes a copy it staged itself, and the
; one step after it that can fail with a staged copy (the swap) removes it there.
Function cwRefuseRecovery
  DetailPrint "Recovery not armed: $R2"
  MessageBox MB_OK|MB_ICONSTOP "$(combworkRecoveryFailed)$\r$\n$\r$\n$R2" /SD IDOK
  SetErrorLevel 7
  Quit
FunctionEnd

Function cwArmRecovery
  StrCpy $cwRecoveryArmed "0"
  ${If} $installMode == "all"
    StrCpy $cwRecoveryMachine "1"
    ; SetShellVarContext all (setInstallModePerAllUsers): $APPDATA is ProgramData, from the shell, not the environment.
    StrCpy $cwRecoveryDir "$APPDATA\Combwork\resume"
  ${Else}
    StrCpy $cwRecoveryMachine "0"
    StrCpy $cwRecoveryDir "$LOCALAPPDATA\combwork-resume"
  ${EndIf}

  ; Something to lose: a resumed run, a recovery armed already, this scope's uninstall entry, or a copy in the folder.
  StrCpy $0 "0"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--cw-resume" $R1
  ${IfNot} ${Errors}
    StrCpy $0 "1"
  ${EndIf}
  ${If} $cwRecoveryMachine == "1"
    ReadRegStr $1 HKLM "${CW_RECOVERY_RUN_KEY}" "${CW_RECOVERY_VALUE}"
  ${Else}
    ReadRegStr $1 HKCU "${CW_RECOVERY_RUN_KEY}" "${CW_RECOVERY_VALUE}"
  ${EndIf}
  ${If} $1 != ""
    StrCpy $0 "1"
  ${EndIf}
  ReadRegStr $1 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $1 != ""
    StrCpy $0 "1"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrCpy $0 "1"
  ${EndIf}
  ${If} $0 == "0"
    Return
  ${EndIf}

  ; The command the Run value holds: this installer's recovery copy, with this install's flags, scope and folder (/D=,
  ; last, unquoted: NSIS's rule). Checked before anything is staged.
  StrCpy $9 '"$cwRecoveryDir\${CW_RECOVERY_FILE}" --cw-resume'
  ${If} ${isUpdated}
    StrCpy $9 "$9 --updated"
  ${EndIf}
  ${If} ${isForceRun}
    StrCpy $9 "$9 --force-run"
  ${EndIf}
  ${If} $cwRecoveryMachine == "1"
    StrCpy $9 "$9 /allusers"
  ${Else}
    StrCpy $9 "$9 /currentuser"
  ${EndIf}
  StrCpy $9 "$9 /D=$INSTDIR"
  StrLen $1 $9
  ${If} $1 > 259
    StrCpy $R2 "The command to finish it is too long ($1 characters): $9"
    Call cwRefuseRecovery
  ${EndIf}

  ; The recovery lock: owned until this installer exits; a held one is waited for (WAIT_ABANDONED counts as taken).
  ${If} $cwRecoveryMachine == "1"
    StrCpy $2 "Global\CombworkRecovery-${APP_GUID}-machine"
  ${Else}
    Call cwUserSid
    ${If} $R1 == ""
      StrCpy $R2 "Couldn't read this user's SID for the recovery lock."
      Call cwRefuseRecovery
    ${EndIf}
    StrCpy $2 "Global\CombworkRecovery-${APP_GUID}-$R1"
  ${EndIf}
  System::Call 'kernel32::CreateMutexW(p 0, i 1, w r2) p.r3 ?e'
  Pop $4
  ${If} $3 = 0
    StrCpy $R2 "Couldn't take the recovery lock $2 (error $4)."
    Call cwRefuseRecovery
  ${EndIf}
  ${If} $4 = 183
    DetailPrint "Waiting for the recovery lock $2"
    !ifdef CW_RECOVERY_WAIT_SIGNAL
      ; A test build's only: says it has reached the wait, so the Sandbox check lets the holder go after it, not on a timer.
      FileOpen $5 "${CW_RECOVERY_WAIT_SIGNAL}" w
      FileWrite $5 "$2"
      FileClose $5
    !endif
    System::Call 'kernel32::WaitForSingleObject(p r3, i ${CW_RECOVERY_WAIT_MS}) i.r5'
    ${If} $5 <> 0
    ${AndIf} $5 <> 0x80
      StrCpy $R2 "Another installer holds the recovery lock $2 (wait $5)."
      Call cwRefuseRecovery
    ${EndIf}
  ${EndIf}

  ; Staged and checked by recovery.ps1 (its last line says what it did), then swapped onto Combwork-Setup.exe.
  InitPluginsDir
  File "/oname=$PLUGINSDIR\recovery.ps1" "${CW_BUILD_DIR}\recovery.ps1"
  ${If} $cwRecoveryMachine == "1"
    StrCpy $1 "machine"
  ${Else}
    StrCpy $1 "user"
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\recovery.ps1" -Scope $1 -Dir "$cwRecoveryDir" -Source "$EXEPATH"'
  Pop $5
  Pop $6
  DetailPrint "Recovery copy: $5 $6"
  ${If} $5 != "0"
    StrCpy $R2 "$6"
    Call cwRefuseRecovery
  ${EndIf}
  StrCpy $7 $6 6
  ${If} $7 == "staged"
    ; MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH: a complete copy replaces the old one in one step.
    System::Call 'kernel32::MoveFileExW(w "$cwRecoveryDir\${CW_RECOVERY_STAGED}", w "$cwRecoveryDir\${CW_RECOVERY_FILE}", i 9) i.r7 ?e'
    Pop $8
    ${If} $7 = 0
      ; This run's own copy: staged by recovery.ps1 just now, under the lock held, in a folder it checked.
      Delete "$cwRecoveryDir\${CW_RECOVERY_STAGED}"
      StrCpy $R2 "Couldn't put the copy in place in $cwRecoveryDir (error $8)."
      Call cwRefuseRecovery
    ${EndIf}
  ${Else}
    StrCpy $7 $6 4
    ${If} $7 != "self"
      StrCpy $R2 "$6"
      Call cwRefuseRecovery
    ${EndIf}
  ${EndIf}

  ; The Run value, read back.
  ClearErrors
  ${If} $cwRecoveryMachine == "1"
    WriteRegStr HKLM "${CW_RECOVERY_RUN_KEY}" "${CW_RECOVERY_VALUE}" "$9"
    ReadRegStr $1 HKLM "${CW_RECOVERY_RUN_KEY}" "${CW_RECOVERY_VALUE}"
  ${Else}
    WriteRegStr HKCU "${CW_RECOVERY_RUN_KEY}" "${CW_RECOVERY_VALUE}" "$9"
    ReadRegStr $1 HKCU "${CW_RECOVERY_RUN_KEY}" "${CW_RECOVERY_VALUE}"
  ${EndIf}
  ${If} ${Errors}
  ${OrIf} $1 != $9
    StrCpy $R2 "Couldn't write the Run value ${CW_RECOVERY_VALUE}."
    Call cwRefuseRecovery
  ${EndIf}
  DetailPrint "Recovery armed: $9"
  StrCpy $cwRecoveryArmed "1"
FunctionEnd

; The install finished: the Run value and the copy go (the copy unless this installer is it: a resumed run's stays,
; inert, until the next install). Still under the recovery lock.
Function cwDisarmRecovery
  ${If} $cwRecoveryArmed != "1"
    Return
  ${EndIf}
  ${If} $cwRecoveryMachine == "1"
    DeleteRegValue HKLM "${CW_RECOVERY_RUN_KEY}" "${CW_RECOVERY_VALUE}"
  ${Else}
    DeleteRegValue HKCU "${CW_RECOVERY_RUN_KEY}" "${CW_RECOVERY_VALUE}"
  ${EndIf}
  Delete "$cwRecoveryDir\${CW_RECOVERY_STAGED}"
  ${If} "$EXEPATH" != "$cwRecoveryDir\${CW_RECOVERY_FILE}"
    Delete "$cwRecoveryDir\${CW_RECOVERY_FILE}"
  ${EndIf}
  RMDir "$cwRecoveryDir"
  StrCpy $cwRecoveryArmed "0"
FunctionEnd
!macroend

; A shown install arms it in a page of its own after every page that can be cancelled (welcome, scope, folder), just
; before the install's progress: it shows nothing (Abort skips it).
!macro customPageAfterChangeDir
  Page custom cwArmRecoveryPage
  Function cwArmRecoveryPage
    Call cwArmRecovery
    Abort
  FunctionEnd
!macroend
!endif
