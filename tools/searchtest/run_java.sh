#!/bin/sh
# SoundCloud.java / SpotifySearch.java off Android: compiled with a small working org.json
# (STUBS, default /tmp/srch-stub: org/json/*.java and com/zentor/player/Diag.java) and run against fakes.py.
set -e
cd "$(dirname "$0")/../.."
STUBS=${STUBS:-/tmp/srch-stub}; OUTD=${OUTD:-/tmp/srch-jout}; PORT=${SRCH_FAKE_PORT:-18616}
SRC=android/app/src/main/java/com/zentor/player
mkdir -p "$OUTD"
javac -nowarn -d "$OUTD" "$STUBS"/org/json/*.java "$STUBS"/com/zentor/player/Diag.java $SRC/SoundCloud.java $SRC/SpotifySearch.java tools/searchtest/java/ScSmoke.java
python3 -c "import sys,time; sys.path.insert(0,'tools/searchtest'); import fakes; fakes.serve($PORT); time.sleep(60)" &
FAKE=$!
for _ in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null && break; sleep 0.2; done  # (the fake makes its HLS fixtures with ffmpeg first)
java -cp "$OUTD" com.zentor.player.ScSmoke "http://127.0.0.1:$PORT" /tmp/srch-jdata; R=$?
kill $FAKE
exit $R
