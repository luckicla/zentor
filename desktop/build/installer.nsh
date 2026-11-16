; MixUp: página de opciones del instalador (después de elegir carpeta)
; - Icono en el escritorio (marcado)
; - Abrir MixUp al iniciar Windows
; En las actualizaciones automáticas (instalación silenciosa) no se pregunta ni se toca nada.
!include nsDialogs.nsh
!include LogicLib.nsh

Var MixChkDesktop
Var MixChkStartup
Var MixOptDesktop
Var MixOptStartup

!macro customPageAfterChangeDir
  Page custom MixOptionsPage MixOptionsLeave
!macroend

Function MixOptionsPage
  ${If} ${Silent}
    Abort
  ${EndIf}
  StrCpy $R0 "Choose how to install MixUp:"
  StrCpy $R1 "Create a desktop icon"
  StrCpy $R2 "Open MixUp when Windows starts"
  StrCpy $R3 "Your music is read from your Music folder. Nothing of yours is touched."
  ${If} $LANGUAGE == 3082
  ${OrIf} $LANGUAGE == 1034
    StrCpy $R0 "Elige cómo quieres instalar MixUp:"
    StrCpy $R1 "Crear un icono en el escritorio"
    StrCpy $R2 "Abrir MixUp al iniciar Windows"
    StrCpy $R3 "La música se lee de tu carpeta Música. No se toca nada tuyo."
  ${ElseIf} $LANGUAGE == 1027
    StrCpy $R0 "Tria com vols instal·lar MixUp:"
    StrCpy $R1 "Crear una icona a l'escriptori"
    StrCpy $R2 "Obrir MixUp en iniciar Windows"
    StrCpy $R3 "La música es llegeix de la teva carpeta Música. No es toca res teu."
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 20u "$R0"
  Pop $0
  ${NSD_CreateCheckbox} 10u 28u 100% 12u "$R1"
  Pop $MixChkDesktop
  ${NSD_Check} $MixChkDesktop
  ${NSD_CreateCheckbox} 10u 46u 100% 12u "$R2"
  Pop $MixChkStartup
  ${NSD_CreateLabel} 0 74u 100% 20u "$R3"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function MixOptionsLeave
  ${NSD_GetState} $MixChkDesktop $MixOptDesktop
  ${NSD_GetState} $MixChkStartup $MixOptStartup
FunctionEnd

!macro customInstall
  ${IfNot} ${Silent}
    ${If} $MixOptDesktop == ${BST_CHECKED}
      CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
    ${EndIf}
    ${If} $MixOptStartup == ${BST_CHECKED}
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MixUp" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MixUp"
  ${EndIf}
!macroend
