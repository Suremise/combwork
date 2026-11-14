; A stand-in installer for build/installer.nsh's handoff (#1647): built with build.mjs, run by run.ps1 in Windows Sandbox
; (never on the host). Its .onInit is the template's order: preInit (installer.nsh's wait, local builds only), then the
; app's mutex taken as ALLOW_ONLY_ONE_INSTALLER_INSTANCE takes it (one found held quits, exit 4 here), held until it
; exits. Its "install" writes when it started and ended to C:\out\<name>.log, five seconds apart. A test mutex name, so
; it can't meet a real Combwork installer.
Unicode true
!define /ifndef APP_GUID "combwork-test-1647-installer-mutex"
!addincludedir "${__FILEDIR__}\..\..\node_modules\app-builder-lib\templates\nsis\include"
!addplugindir /x86-unicode "${PLUGINS}"
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "UAC.nsh"
!include "StdUtils.nsh"
; What electron-builder's generated header and template give installer.nsh (HI-3172's recovery uses them): its command
; line flags (as nsisScriptGenerator defines them), the scope variable, the uninstall key and the exe's name. Stand-ins:
; the harness never arms a recovery (no --updated install, nothing in its folder under these names).
!macro _isUpdated _a _b _t _f
  ${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isUpdated `"" isUpdated ""`
!macro _isForceRun _a _b _t _f
  ${StdUtils.TestParameter} $R9 "force-run"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isForceRun `"" isForceRun ""`
Var installMode
!define UNINSTALL_REGISTRY_KEY "Software\combwork-test-1647-uninstall"
!define APP_EXECUTABLE_FILENAME "combwork-test-1647-none.exe"
!include "${__FILEDIR__}\..\..\build\installer.nsh"
!ifmacrodef customHeader
  !insertmacro customHeader
!endif
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "German"
!insertmacro MUI_LANGUAGE "SpanishInternational"
!insertmacro MUI_LANGUAGE "French"
!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_LANGUAGE "Polish"
!insertmacro MUI_LANGUAGE "PortugueseBR"
!insertmacro MUI_LANGUAGE "SimpChinese"
RequestExecutionLevel user
OutFile "${OUT}"
Var name

Function .onInit
  ${GetParameters} $name
  ${GetOptions} $name "/NAME=" $name
  !ifmacrodef preInit
    !insertmacro preInit
  !endif
  ; installer.nsh's request to a running Combwork to close (HI-1707), as the template inserts it after initMultiUser: here
  ; the stand-in install folder (C:\stand\Combwork), where run.ps1 starts a stand-in Combwork for its cases, or none.
  StrCpy $INSTDIR "C:\stand\Combwork"
  StrCpy $installMode "CurrentUser"
  !ifmacrodef customInit
    !insertmacro customInit
  !endif
  System::Call 'kernel32::CreateMutexW(i 0, i 1, w "${APP_GUID}") i.r5 ?e'
  Pop $6
  ${If} $6 = 183
    SetErrorLevel 4
    Quit
  ${EndIf}
FunctionEnd

Section
  System::Call 'kernel32::GetTickCount() i.r7'
  FileOpen $8 "C:\out\$name.log" a
  FileWrite $8 "start $7$\r$\n"
  Sleep 5000
  System::Call 'kernel32::GetTickCount() i.r7'
  FileWrite $8 "end $7$\r$\n"
  FileClose $8
  ; As the template's install section ends (customInstall): nothing armed here, so nothing to do.
  !ifmacrodef customHeader
    Call cwDisarmRecovery
  !endif
SectionEnd
