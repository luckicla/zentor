#!/bin/sh
set -e
cd "$(dirname "$0")"

if command -v llvm-rc >/dev/null && command -v llvm-cvtres >/dev/null; then
  llvm-rc /FO res.res res.rc
  llvm-cvtres /machine:x64 /out:rsrc_windows_amd64.syso res.res
  rm res.res
fi

GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-H windowsgui -s -w -X main.version=${VERSION:-1.4.0}" -o ZenTor.exe .
echo "ZenTor.exe listo"
