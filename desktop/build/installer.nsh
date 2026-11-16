; MixUp: páginas del instalador (después de elegir carpeta)
; - Opciones: icono en el escritorio (marcado) y abrir MixUp al iniciar Windows
; - Logo: el de MixUp (en sus versiones) o el Legacy (el de ZenTor). Se pone en
;   los accesos directos y la app lo usa desde el principio (luego se cambia
;   en Ajustes → Icono de la app)
; En las actualizaciones automáticas (instalación silenciosa) no se pregunta ni se toca nada,
; salvo /DESKTOP=1 (crear el icono del escritorio: el paso desde el MixUp.exe de antes).
!include nsDialogs.nsh
!include LogicLib.nsh
!include FileFunc.nsh

Var MixChkDesktop
Var MixChkStartup
Var MixOptDesktop
Var MixOptStartup
Var MixLogo
Var MixR0
Var MixR1
Var MixR2
Var MixR3
Var MixR4
Var MixR5
Var MixR6
Var MixImg

!macro customPageAfterChangeDir
  Page custom MixOptionsPage MixOptionsLeave
  Page custom MixLogoPage MixLogoLeave
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


; ---- the logo ----
!macro MixLogoItem X Y NAME LABEL VAR
  File "/oname=$PLUGINSDIR\mixlogo-${NAME}.ico" "${BUILD_RESOURCES_DIR}\icons\${NAME}.ico"
  ${NSD_CreateIcon} ${X} ${Y}u 24u 24u ""
  Pop $0
  ${NSD_SetIcon} $0 "$PLUGINSDIR\mixlogo-${NAME}.ico" $MixImg
  IntOp $1 ${Y} + 26
  ${NSD_CreateRadioButton} ${X} $1u 70u 12u "${LABEL}"
  Pop ${VAR}
  ${If} $MixLogo == "${NAME}"
    ${NSD_Check} ${VAR}
  ${EndIf}
!macroend

Function MixLogoPage
  ${If} ${Silent}
    Abort
  ${EndIf}
  ${If} $MixLogo == ""
    StrCpy $MixLogo "mixup"
  ${EndIf}
  InitPluginsDir
  StrCpy $R0 "Choose MixUp's logo (you can change it later in Settings → App icon):"
  ${If} $LANGUAGE == 3082
  ${OrIf} $LANGUAGE == 1034
    StrCpy $R0 "Elige el logo de MixUp (luego se puede cambiar en Ajustes → Icono de la app):"
  ${ElseIf} $LANGUAGE == 1027
    StrCpy $R0 "Tria el logo de MixUp (després es pot canviar a Configuració → Icona de l'app):"
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 14u "$R0"
  Pop $0
  !insertmacro MixLogoItem 0u 18 "mixup" "MixUp" $MixR0
  !insertmacro MixLogoItem 75u 18 "mixstack" "Apilado" $MixR1
  !insertmacro MixLogoItem 150u 18 "mixblend" "Fundido" $MixR2
  !insertmacro MixLogoItem 225u 18 "mixstep" "Escalón" $MixR3
  !insertmacro MixLogoItem 0u 66 "mixeq" "Ecualizador" $MixR4
  !insertmacro MixLogoItem 75u 66 "mixm" "M" $MixR5
  !insertmacro MixLogoItem 150u 66 "legacy" "Legacy (ZenTor)" $MixR6
  nsDialogs::Show
FunctionEnd

Function MixLogoLeave
  ${NSD_GetState} $MixR0 $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $MixLogo "mixup"
  ${EndIf}
  ${NSD_GetState} $MixR1 $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $MixLogo "mixstack"
  ${EndIf}
  ${NSD_GetState} $MixR2 $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $MixLogo "mixblend"
  ${EndIf}
  ${NSD_GetState} $MixR3 $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $MixLogo "mixstep"
  ${EndIf}
  ${NSD_GetState} $MixR4 $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $MixLogo "mixeq"
  ${EndIf}
  ${NSD_GetState} $MixR5 $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $MixLogo "mixm"
  ${EndIf}
  ${NSD_GetState} $MixR6 $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $MixLogo "legacy"
  ${EndIf}
FunctionEnd

!macro customInstall
  ${IfNot} ${Silent}
    ; the chosen logo: on the shortcuts, and for the app to start with it
    ${If} $MixLogo != ""
    ${AndIf} $MixLogo != "mixup"
      CopyFiles /SILENT "$PLUGINSDIR\mixlogo-$MixLogo.ico" "$INSTDIR\icono.ico"
      CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\icono.ico" 0
    ${EndIf}
    ${If} $MixLogo != ""
      CreateDirectory "$APPDATA\${PRODUCT_NAME}"
      FileOpen $0 "$APPDATA\${PRODUCT_NAME}\icono-elegido.txt" w
      FileWrite $0 "$MixLogo"
      FileClose $0
    ${EndIf}
    ${If} $MixOptDesktop == ${BST_CHECKED}
      ${If} ${FileExists} "$INSTDIR\icono.ico"
        CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\icono.ico" 0
      ${Else}
        CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
      ${EndIf}
    ${EndIf}
    ${If} $MixOptStartup == ${BST_CHECKED}
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MixUp" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    ${EndIf}
  ${Else}
    ; silent: coming from the MixUp.exe of before, which was on the desktop
    ${GetParameters} $1
    ClearErrors
    ${GetOptions} $1 "/DESKTOP=" $2
    ${IfNot} ${Errors}
    ${AndIf} $2 == "1"
      CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MixUp"
  ${EndIf}
!macroend
