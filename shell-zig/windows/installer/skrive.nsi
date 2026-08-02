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

; ProgIds for the document types Skrive registers as a handler for. Versionless
; names on purpose: they are stable identities the shell keys associations to,
; so bumping them on every release would strand the user's chosen default.
!define PROGID_MD "Skrive.Markdown"
!define PROGID_TXT "Skrive.Text"
!define PROGID_HTML "Skrive.Html"

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

  Call RegisterFileTypes
SectionEnd

; File associations, so Explorer offers "Open with Skrive" for the document
; types Skrive can open. HKCU\Software\Classes, matching this per-user install
; — a machine-wide (HKLM) registration would need elevation for no benefit.
;
; OpenWithProgids, NOT the default handler: these are borrowed types other
; editors already own, and installing Skrive must not silently take over every
; .txt on the machine. This puts Skrive in the "Open with" list and lets the
; user promote it themselves; Windows shows its own picker on first use.
;
; `%1` is quoted in the command so a path with spaces arrives as one argument.
Function RegisterFileTypes
  WriteRegStr HKCU "Software\Classes\${PROGID_MD}" "" "Markdown Document"
  WriteRegStr HKCU "Software\Classes\${PROGID_MD}\DefaultIcon" "" "$INSTDIR\Skrive.exe,0"
  WriteRegStr HKCU "Software\Classes\${PROGID_MD}\shell\open\command" "" '"$INSTDIR\Skrive.exe" "%1"'

  WriteRegStr HKCU "Software\Classes\${PROGID_TXT}" "" "Plain Text Document"
  WriteRegStr HKCU "Software\Classes\${PROGID_TXT}\DefaultIcon" "" "$INSTDIR\Skrive.exe,0"
  WriteRegStr HKCU "Software\Classes\${PROGID_TXT}\shell\open\command" "" '"$INSTDIR\Skrive.exe" "%1"'

  WriteRegStr HKCU "Software\Classes\${PROGID_HTML}" "" "HTML Document"
  WriteRegStr HKCU "Software\Classes\${PROGID_HTML}\DefaultIcon" "" "$INSTDIR\Skrive.exe,0"
  WriteRegStr HKCU "Software\Classes\${PROGID_HTML}\shell\open\command" "" '"$INSTDIR\Skrive.exe" "%1"'

  WriteRegStr HKCU "Software\Classes\.md\OpenWithProgids" "${PROGID_MD}" ""
  WriteRegStr HKCU "Software\Classes\.markdown\OpenWithProgids" "${PROGID_MD}" ""
  WriteRegStr HKCU "Software\Classes\.txt\OpenWithProgids" "${PROGID_TXT}" ""
  WriteRegStr HKCU "Software\Classes\.text\OpenWithProgids" "${PROGID_TXT}" ""
  WriteRegStr HKCU "Software\Classes\.html\OpenWithProgids" "${PROGID_HTML}" ""
  WriteRegStr HKCU "Software\Classes\.htm\OpenWithProgids" "${PROGID_HTML}" ""

  ; Lists the extensions under the app itself, which is what populates the
  ; "Open with > Choose another app" dialog and Default Apps.
  WriteRegStr HKCU "Software\Classes\Applications\Skrive.exe\shell\open\command" "" '"$INSTDIR\Skrive.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\Skrive.exe\SupportedTypes" ".md" ""
  WriteRegStr HKCU "Software\Classes\Applications\Skrive.exe\SupportedTypes" ".markdown" ""
  WriteRegStr HKCU "Software\Classes\Applications\Skrive.exe\SupportedTypes" ".txt" ""
  WriteRegStr HKCU "Software\Classes\Applications\Skrive.exe\SupportedTypes" ".text" ""
  WriteRegStr HKCU "Software\Classes\Applications\Skrive.exe\SupportedTypes" ".html" ""
  WriteRegStr HKCU "Software\Classes\Applications\Skrive.exe\SupportedTypes" ".htm" ""

  ; Tell the shell the association table changed, so Explorer's context menu
  ; picks it up without a sign-out. SHCNE_ASSOCCHANGED | SHCNF_IDLIST.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
FunctionEnd

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

  ; File associations. The ProgId keys go entirely; from the per-extension
  ; lists only OUR value is deleted (DeleteRegValue, not DeleteRegKey) — those
  ; keys are shared, and removing them would take every other editor's
  ; "Open with" entry down with us. DeleteRegKey /ifempty then tidies up only
  ; if we were the last one listed.
  DeleteRegKey HKCU "Software\Classes\${PROGID_MD}"
  DeleteRegKey HKCU "Software\Classes\${PROGID_TXT}"
  DeleteRegKey HKCU "Software\Classes\${PROGID_HTML}"

  DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "${PROGID_MD}"
  DeleteRegValue HKCU "Software\Classes\.markdown\OpenWithProgids" "${PROGID_MD}"
  DeleteRegValue HKCU "Software\Classes\.txt\OpenWithProgids" "${PROGID_TXT}"
  DeleteRegValue HKCU "Software\Classes\.text\OpenWithProgids" "${PROGID_TXT}"
  DeleteRegValue HKCU "Software\Classes\.html\OpenWithProgids" "${PROGID_HTML}"
  DeleteRegValue HKCU "Software\Classes\.htm\OpenWithProgids" "${PROGID_HTML}"
  DeleteRegKey /ifempty HKCU "Software\Classes\.md\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\.markdown\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\.txt\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\.text\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\.html\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\.htm\OpenWithProgids"

  DeleteRegKey HKCU "Software\Classes\Applications\Skrive.exe"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
SectionEnd
