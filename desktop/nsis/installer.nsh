; jio's installer, wearing jio's colors.
;
; NSIS's MUI2 wizard is a stock Win32 dialog — white panels, black text, a
; green progress bar. Against the app it installs (near-black, warm grey text,
; a periwinkle accent) that reads as somebody else's installer. This repaints
; it from css/app.css's own tokens.
;
; How it hooks in: electron-builder includes this file at the very top of the
; generated script, before MUI2 has set anything up — early enough to claim
; MUI_CUSTOMFUNCTION_GUIINIT, which MUI2 calls from its own .onGUIInit. (The
; later `customHeader` hook is too late to be useful here: by then MUI has
; already written .onGUIInit and the pages.)
;
; Why a timer rather than a single pass: MUI builds each page's inner dialog
; fresh as the wizard advances, so one pass at GUI-init would only ever catch
; the first page. A short repeating repaint keeps up with whichever page is
; showing. It's cheap — a handful of SetCtlColors calls against mostly
; already-correct controls — and it is purely cosmetic: if it never ran at
; all, the installer would still install, it would just look stock again.
;
; Native pushbuttons (Back / Next / Cancel) are drawn by the OS theme and
; can't be recolored without owner-drawing them, so those stay as Windows
; renders them. Everything else follows the app.

!include "WinMessages.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; --- jio's palette, from css/app.css ---------------------------------------
; SetCtlColors takes bare RRGGBB. The progress-bar messages take a COLORREF,
; which is byte-reversed (00BBGGRR) — hence the different spelling there.
!define JIO_BG         1f1e1d      ; --bg
!define JIO_ELEV       262423      ; --bg-elev
!define JIO_FG         e8e6dc      ; --fg
!define JIO_FG2        c2c0b6      ; --fg-2
!define JIO_FG3        8d8b83      ; --fg-3
!define JIO_ACCENT_CR  0x00FF8C6C  ; --accent #6c8cff, as a COLORREF
!define JIO_TROUGH_CR  0x002A2C2E  ; a step up from --bg, likewise

; commctrl.h. Guarded because, depending on include order, NSIS's own headers
; may already have defined them — and a redefinition is a hard error.
!ifndef PBM_SETBARCOLOR
  !define PBM_SETBARCOLOR 0x0409
!endif
!ifndef PBM_SETBKCOLOR
  !define PBM_SETBKCOLOR  0x2001
!endif

; Repaints the persistent chrome (header band, bottom branding strip) plus
; every control on the page currently showing. The IDs are MUI2's own and are
; stable across NSIS 3.x: 1034/1035/1039 header band and image, 1037/1038
; header title and subtitle, 1028/1256 branding, 1006/1016/1027 page labels,
; 1019 the directory box, 1004 the install log.
!macro JIO_PAINT_BODY
  Push $0
  Push $1

  ; the outer window and its header band
  SetCtlColors $HWNDPARENT ${JIO_FG} ${JIO_BG}
  GetDlgItem $0 $HWNDPARENT 1034
  SetCtlColors $0 ${JIO_FG} ${JIO_BG}
  GetDlgItem $0 $HWNDPARENT 1035
  SetCtlColors $0 ${JIO_FG} ${JIO_BG}
  GetDlgItem $0 $HWNDPARENT 1037
  SetCtlColors $0 ${JIO_FG} ${JIO_BG}
  GetDlgItem $0 $HWNDPARENT 1038
  SetCtlColors $0 ${JIO_FG3} ${JIO_BG}
  GetDlgItem $0 $HWNDPARENT 1039
  SetCtlColors $0 ${JIO_FG} ${JIO_BG}
  GetDlgItem $0 $HWNDPARENT 1028
  SetCtlColors $0 ${JIO_FG3} ${JIO_BG}
  GetDlgItem $0 $HWNDPARENT 1256
  SetCtlColors $0 ${JIO_FG3} ${JIO_BG}

  ; the page mounted inside it
  FindWindow $1 "#32770" "" $HWNDPARENT
  ${If} $1 <> 0
    SetCtlColors $1 ${JIO_FG} ${JIO_BG}
    GetDlgItem $0 $1 1006
    SetCtlColors $0 ${JIO_FG2} ${JIO_BG}
    GetDlgItem $0 $1 1016
    SetCtlColors $0 ${JIO_FG2} ${JIO_BG}
    GetDlgItem $0 $1 1027
    SetCtlColors $0 ${JIO_FG} ${JIO_BG}
    GetDlgItem $0 $1 1021
    SetCtlColors $0 ${JIO_FG2} ${JIO_BG}
    GetDlgItem $0 $1 1023
    SetCtlColors $0 ${JIO_FG2} ${JIO_BG}
    GetDlgItem $0 $1 1019
    SetCtlColors $0 ${JIO_FG} ${JIO_ELEV}
    GetDlgItem $0 $1 1004
    SetCtlColors $0 ${JIO_FG3} ${JIO_ELEV}

    ; the progress bar: accent fill on a dark trough rather than stock green.
    ; PBM_SETBARCOLOR is ignored while the control still carries a visual
    ; style, so drop the theme on it first.
    FindWindow $0 "msctls_progress32" "" $1
    ${If} $0 <> 0
      System::Call 'uxtheme::SetWindowTheme(p $0, w " ", w " ")'
      SendMessage $0 ${PBM_SETBARCOLOR} 0 ${JIO_ACCENT_CR}
      SendMessage $0 ${PBM_SETBKCOLOR} 0 ${JIO_TROUGH_CR}
    ${EndIf}
  ${EndIf}

  Pop $1
  Pop $0
!macroend

; The installer and the uninstaller are two separate compiles of this script,
; told apart by BUILD_UNINSTALLER — so each pass defines only its own side.
; Defining the other's would leave an unreferenced function behind, and
; electron-builder compiles with warnings-as-errors.
!ifdef BUILD_UNINSTALLER
  Function un.jioPaint
    !insertmacro JIO_PAINT_BODY
  FunctionEnd

  Function un.jioGuiInit
    Call un.jioPaint
    ${NSD_CreateTimer} un.jioPaint 100
  FunctionEnd

  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.jioGuiInit
!else
  Function jioPaint
    !insertmacro JIO_PAINT_BODY
  FunctionEnd

  Function jioGuiInit
    Call jioPaint
    ${NSD_CreateTimer} jioPaint 100
  FunctionEnd

  !define MUI_CUSTOMFUNCTION_GUIINIT jioGuiInit
!endif
