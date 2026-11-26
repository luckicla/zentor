#!/bin/sh
# MixUp para macOS: MixUp.app universal (Apple Silicon + Intel) dentro de
# MixUp-macOS.dmg y de MixUp-macOS.zip (el zip es lo que usa la
# actualización automática), más version.txt ("<versión> <sha256 del zip>").
#
# En un Mac (GitHub Actions: macos-latest) usa lipo, sips, iconutil, codesign
# y hdiutil. En Linux sirve para probar: sin esas herramientas hace la .app
# solo para Apple Silicon, sin icono ni dmg (con STRICT=1 falla en su lugar).
set -e
cd "$(dirname "$0")"

VERSION=${VERSION:-1.5.0}
# 2.1.3.412 -> se muestra 2.1.3, la build 412
case "$VERSION" in
  *.*.*.*) SHORT=${VERSION%.*}; BUILD=${VERSION##*.} ;;
  *) SHORT=$VERSION; BUILD=0 ;;
esac

have() { command -v "$1" >/dev/null 2>&1; }
need() {
  if ! have "$1"; then
    [ -n "$STRICT" ] && { echo "falta $1" >&2; exit 1; }
    return 1
  fi
}

OUT=dist-mac
rm -rf "$OUT" && mkdir -p "$OUT"
APP="$OUT/MixUp.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# el secreto del cliente OAuth de Google: solo desde el entorno (en GitHub
# Actions, el secreto del repositorio GOOGLE_CLIENT_SECRET), nunca en el repo.
# Sin él compila igual; la cuenta de Google sale como «Todavía no está disponible».
GSECRET=""
[ -n "$GOOGLE_CLIENT_SECRET" ] && GSECRET="-X main.googleClientSecretBuild=$GOOGLE_CLIENT_SECRET"

for arch in arm64 amd64; do
  CGO_ENABLED=0 GOOS=darwin GOARCH=$arch go build -trimpath \
    -ldflags "-s -w -X main.version=$VERSION $GSECRET" -o "$OUT/MixUp-$arch" .
done
if need lipo; then
  lipo -create -output "$APP/Contents/MacOS/MixUp" "$OUT/MixUp-arm64" "$OUT/MixUp-amd64"
  lipo -info "$APP/Contents/MacOS/MixUp"
else
  echo "(sin lipo: solo arm64)"
  cp "$OUT/MixUp-arm64" "$APP/Contents/MacOS/MixUp"
fi
rm -f "$OUT/MixUp-arm64" "$OUT/MixUp-amd64"
chmod 755 "$APP/Contents/MacOS/MixUp"

# LSUIElement: el servidor no tiene ventana propia (la ventana es la del
# navegador), así que no sale en el Dock ni macOS lo da por «no responde»
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>MixUp</string>
	<key>CFBundleDisplayName</key><string>MixUp</string>
	<key>CFBundleIdentifier</key><string>com.luckicla.mixup</string>
	<key>CFBundleExecutable</key><string>MixUp</string>
	<key>CFBundleIconFile</key><string>MixUp</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleSignature</key><string>????</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleShortVersionString</key><string>$SHORT</string>
	<key>CFBundleVersion</key><string>$BUILD</string>
	<key>CFBundleDevelopmentRegion</key><string>es</string>
	<key>LSMinimumSystemVersion</key><string>11.0</string>
	<key>LSApplicationCategoryType</key><string>public.app-category.music</string>
	<key>LSUIElement</key><true/>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSHumanReadableCopyright</key><string>MixUp · github.com/luckicla/zentor</string>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

# el icono (.icns) a partir de web/mixup.png
if need sips && need iconutil; then
  SET="$OUT/MixUp.iconset"
  mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s web/mixup.png --out "$SET/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2))
    sips -z $d $d web/mixup.png --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$APP/Contents/Resources/MixUp.icns"
  rm -rf "$SET"
else
  echo "(sin sips/iconutil: sin icono)"
fi

# firma ad hoc de toda la app (sin cuenta de desarrollador de Apple: no
# quita el aviso de la primera vez, pero la app queda entera y verificable)
if need codesign; then
  codesign --force --deep --sign - "$APP"
  codesign --verify --deep --strict "$APP"
fi

# el zip (conserva permisos), lo que descarga la actualización automática
(cd "$OUT" && zip -qry -X MixUp-macOS.zip MixUp.app)
if have shasum; then SUM=$(shasum -a 256 "$OUT/MixUp-macOS.zip" | cut -d' ' -f1)
else SUM=$(sha256sum "$OUT/MixUp-macOS.zip" | cut -d' ' -f1); fi
echo "$VERSION $SUM" > "$OUT/version.txt"

# el dmg: la app y un acceso a Aplicaciones para arrastrarla
if need hdiutil; then
  STAGE="$OUT/dmg"
  mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  for i in 1 2 3 4 5; do
    hdiutil create -volname MixUp -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$OUT/MixUp-macOS.dmg" && break
    [ $i = 5 ] && exit 1
    sleep 5
  done
  rm -rf "$STAGE"
fi

ls -la "$OUT"
cat "$OUT/version.txt"
