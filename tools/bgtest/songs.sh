#!/bin/sh
# Short made-up songs with a beat (nothing with rights), onto the emulator.
set -e
mkdir -p songs
for i in 1 2 3 4 5 6 7 8; do
  f=$((110 + i * 37)); bpm=$((100 + i * 4))
  ffmpeg -loglevel error -y -f lavfi -i "aevalsrc='0.5*sin(2*PI*$f*t)*(0.6+0.4*sin(2*PI*0.25*t)) + 0.8*sin(2*PI*55*t)*exp(-12*mod(t,60/$bpm))':s=44100:d=45" \
    -ac 2 -b:a 160k -metadata title="Prueba $i" -metadata artist="Test" songs/prueba$i.mp3
done
adb shell mkdir -p /sdcard/Music/zt
adb push songs/. /sdcard/Music/zt/
adb shell content call --uri content://media --method scan_volume --arg external_primary || true
sleep 5
