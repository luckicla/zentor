#!/bin/sh
# Tries YtVideo/YtDirect (the phone's video of a song) on a PC: javac with small
# stubs of Android, org.json and yt-dlp, against a fake YouTube that answers
# with testdata/visionos_player.json (the Go tests use it too).
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
J="$root/android/app/src/main/java/com/zentor/player"
out=${VIDEOTEST_JAVA_OUT:-$(mktemp -d)}
javac -Xlint:none -nowarn -d "$out" $(find "$here/stubs" -name '*.java') "$J/Diag.java" "$J/YtAudio.java" "$J/YtDirect.java" "$J/YtVideo.java" "$here/com/zentor/player/YtVideoTest.java"
java -Djava.net.useSystemProxies=false -Dhttp.nonProxyHosts='127.0.0.1|localhost' -cp "$out" com.zentor.player.YtVideoTest "$root/testdata/visionos_player.json"
