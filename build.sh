#!/bin/sh
set -e
cd "$(dirname "$0")"

if command -v llvm-rc >/dev/null && command -v llvm-cvtres >/dev/null; then
  llvm-rc /FO res.res res.rc
  llvm-cvtres /machine:x64 /out:rsrc_windows_amd64.syso res.res
  rm res.res
fi

# the Google OAuth client's secret: only from the environment (GitHub Actions:
# the GOOGLE_CLIENT_SECRET repository secret), never in the repository. Without
# it the build works the same; the Google account shows «not available yet».
GSECRET=""
[ -n "$GOOGLE_CLIENT_SECRET" ] && GSECRET="-X main.googleClientSecretBuild=$GOOGLE_CLIENT_SECRET"
# the «Desktop app» client's secret (direct sign-in, no code): GOOGLE_DESKTOP_CLIENT_SECRET
[ -n "$GOOGLE_DESKTOP_CLIENT_SECRET" ] && GSECRET="$GSECRET -X main.googleDesktopSecretBuild=$GOOGLE_DESKTOP_CLIENT_SECRET"

GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-H windowsgui -s -w -X main.version=${VERSION:-1.5.0} $GSECRET" -o MixUp.exe .
echo "MixUp.exe listo"
