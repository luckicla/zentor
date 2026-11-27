#!/bin/sh
# Tries NameGuess.java (the phone's guess of title / artist, and the online
# check of their order) on a PC, with the same cases as names_meta_test.go.
# Uses the org.json stand-in of tools/googletest/stubs.
set -e
cd "$(dirname "$0")"
J=../../android/app/src/main/java/com/zentor/player
out=$(mktemp -d)
javac -d "$out" ../googletest/stubs/org/json/*.java $J/NameGuess.java NameGuessTest.java
java -cp "$out" com.zentor.player.NameGuessTest
