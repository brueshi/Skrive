; Skrive Windows installer (Stage 6 M3). Hand-written NSIS, compiled on macOS
; with Homebrew `makensis` (no rc.exe / Windows SDK). Produces a per-user
; installer (no admin/UAC) that lays out the same files the portable zip ships
; (Skrive.exe + native-bridge.js + WebView2Loader.dll + WinSparkle.dll +
; renderer/) into %LOCALAPPDATA%\Programs\Skrive, registers a Start Menu
; shortcut + an Add/Remove Programs entry, and bootstraps the Edge WebView2
; Evergreen runtime if it is missing. File associations were intentionally cut
; from M3.
;
; Driven by defines from package-windows.sh (-D...); the defaults let a manual
; `makensis skrive.nsi` from this directory work after a `build-windows.sh
; x64 release`.

Unicode true

!define APPNAME "Skrive"
!define PUBLISHER "Skrive"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
; Path to the assembled release bundle (build-windows.sh output). Source paths
; use forward slashes so the macOS cross-build's `makensis` resolves them; only
; runtime targets ($INSTDIR, $TEMP) use backslashes.
!ifndef DIST
  !define DIST "../dist"
!endif
; The WebView2 Evergreen bootstrapper, vendored next to WebView2Loader.dll.
!ifndef BOOTSTRAPPER
  !define BOOTSTRAPPER "../vendor/webview2/MicrosoftEdgeWebview2Setup.exe"
!endif
!ifndef ICON
  !define ICON "../skrive.ico"
!endif
!ifndef OUTFILE
  !define OUTFILE "Skrive-${VERSION}-Setup.exe"
!endif

; Edge WebView2 Evergreen Runtime client id (stable, Microsoft-published).
!define WV2_CLIENT "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define ARP_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"

Name "${APPNAME}"
OutFile "${OUTFILE}"
; Per-user install: no admin prompt, lands in the user's profile.
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
InstallDirRegKey HKCU "Software\${APPNAME}" "InstallDir"
SetCompressor /SOLID lzma

; Version metadata on Setup.exe itself.
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "FileDescription" "${APPNAME} installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "${PUBLISHER}"

!include "MUI2.nsh"
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Skrive.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${APPNAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File "${DIST}/Skrive.exe"
  File "${DIST}/native-bridge.js"
  File "${DIST}/WebView2Loader.dll"
  File "${DIST}/WinSparkle.dll"
  SetOutPath "$INSTDIR\renderer"
  File /r "${DIST}/renderer/*"
  SetOutPath "$INSTDIR"

  Call EnsureWebView2

  CreateShortCut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\Skrive.exe" "" "$INSTDIR\Skrive.exe" 0

  ; Uninstaller + Add/Remove Programs (HKCU, since this is a per-user install).
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\${APPNAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${ARP_KEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${ARP_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${ARP_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${ARP_KEY}" "DisplayIcon" "$INSTDIR\Skrive.exe"
  WriteRegStr HKCU "${ARP_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${ARP_KEY}" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr HKCU "${ARP_KEY}" "QuietUninstallString" "$\"$INSTDIR\Uninstall.exe$\" /S"
  WriteRegDWORD HKCU "${ARP_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${ARP_KEY}" "NoRepair" 1
SectionEnd

; Install the Edge WebView2 Evergreen Runtime if it is absent. The runtime
; advertises itself via the EdgeUpdate "pv" value (per-machine, then per-user);
; an empty or "0.0.0.0" value means not installed. The bundled bootstrapper
; then pulls the runtime online (silent). Windows 11 ships it by default, so on
; most machines this is a no-op registry read.
Function EnsureWebView2
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WV2_CLIENT}" "pv"
  StrCmp $0 "" check_hkcu 0
  StrCmp $0 "0.0.0.0" check_hkcu wv2_done

  check_hkcu:
  ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WV2_CLIENT}" "pv"
  StrCmp $0 "" do_install 0
  StrCmp $0 "0.0.0.0" do_install wv2_done

  do_install:
  DetailPrint "Installing the Microsoft Edge WebView2 Runtime..."
  File "/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe" "${BOOTSTRAPPER}"
  ExecWait '"$TEMP\MicrosoftEdgeWebview2Setup.exe" /silent /install' $1
  Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"

  wv2_done:
FunctionEnd

Section "Uninstall"
  Delete "$INSTDIR\Skrive.exe"
  Delete "$INSTDIR\native-bridge.js"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\WinSparkle.dll"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR\renderer"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  ; User data under %APPDATA%\Skrive (projects state, crash logs, WebView2
  ; profile) is deliberately left in place — uninstall must not destroy it.
  DeleteRegKey HKCU "${ARP_KEY}"
  DeleteRegKey HKCU "Software\${APPNAME}"
SectionEnd
