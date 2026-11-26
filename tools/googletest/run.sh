#!/bin/sh
# Tries GoogleAccount.java (the phone's Google account) on a PC against a fake
# Google. stubs/ is a small stand-in for Android's org.json and for the BuildConfig Gradle makes.
set -e
cd "$(dirname "$0")"
J=../../android/app/src/main/java/com/zentor/player
out=$(mktemp -d)
javac -d "$out" stubs/org/json/*.java stubs/com/zentor/player/BuildConfig.java $J/GoogleConfig.java $J/GoogleAccount.java GoogleAccountTest.java
java -Djava.net.useSystemProxies=false -Dhttp.nonProxyHosts='127.0.0.1|localhost' -cp "$out" com.zentor.player.GoogleAccountTest
