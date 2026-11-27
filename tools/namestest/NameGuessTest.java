package com.zentor.player;

import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** NameGuess.java with the cases of names_meta_test.go. Run with tools/namestest/run.sh. */
public class NameGuessTest {
    static int fails = 0;

    static void check(boolean ok, String what) {
        if (!ok) { fails++; System.out.println("FAIL: " + what); }
        else System.out.println("ok: " + what);
    }

    static final List<String[]> CATALOG = Arrays.asList(
        new String[]{"Highway to Hell", "AC/DC"}, new String[]{"Hells Bells", "AC/DC"}, new String[]{"Thunderstruck", "AC/DC"},
        new String[]{"Bohemian Rhapsody - Remastered 2011", "Queen"}, new String[]{"Tití Me Preguntó", "Bad Bunny"},
        new String[]{"7 rings", "Ariana Grande"}, new String[]{"Believer", "Imagine Dragons"}, new String[]{"Despechá", "ROSALÍA"},
        new String[]{"One More Time", "Daft Punk"}, new String[]{"Highway to Hell (Live)", "Some Cover Band"},
        new String[]{"Queen", "Perfume Genius"});

    /** an entry as MusicLibrary makes it: path relative to the music, tags "title|artist" or "" */
    static NameGuess.Entry entry(String path, String tags) {
        NameGuess.Entry e = new NameGuess.Entry();
        e.id = path;
        if (!tags.isEmpty()) { String[] p = tags.split("\\|", -1); e.tagT = p[0]; e.tagA = p[1]; }
        String[] parts = path.split("/");
        for (int i = parts.length - 2; i >= 0 && e.dirs.size() < 3; i--) e.dirs.add(parts[i]);
        String file = parts[parts.length - 1];
        NameGuess.prepare(e, file.replaceAll("\\.[^.]+$", ""));
        return e;
    }

    public static void main(String[] a) throws Exception {
        // cleanBase
        String[][] cb = {
            {"01 - Bad Bunny - Tití Me Preguntó", "Bad Bunny - Tití Me Preguntó", "1"},
            {"01. Rosalía - Despechá", "Rosalía - Despechá", "1"},
            {"1-02 Song Name", "Song Name", "1"},
            {"CD1 - 03 - Queen - Love of My Life", "Queen - Love of My Life", "1"},
            {"7 rings - Ariana Grande", "7 rings - Ariana Grande", ""},
            {"22 - Taylor Swift", "22 - Taylor Swift", ""},
            {"99 Luftballons", "99 Luftballons", ""},
            {"Daft_Punk_-_One_More_Time", "Daft Punk - One More Time", ""},
            {"AC_DC - Highway to Hell", "AC_DC - Highway to Hell", ""},
            {"1.5 Lbs - Someone", "1.5 Lbs - Someone", ""},
        };
        for (String[] c : cb) {
            String[] r = NameGuess.cleanBase(c[0]);
            check(r[0].equals(c[1]) && r[1].equals(c[2]), "cleanBase " + c[0] + " → " + r[0] + " " + r[1]);
        }

        // guesses from the file names
        String[][] files = {
            {"AC_DC - Highway to Hell.mp3", "", "Highway to Hell", "AC_DC", ""}, // (sure: the folder AC_DC below)
            {"Queen - Bohemian Rhapsody (Remastered 2011).mp3", "", "Bohemian Rhapsody (Remastered 2011)", "Queen", ""},
            {"Bohemian Rhapsody (Remastered 2011) - Queen.mp3", "", "Bohemian Rhapsody (Remastered 2011)", "Queen", ""},
            {"01 - Bad Bunny - Tití Me Preguntó.mp3", "", "Tití Me Preguntó", "Bad Bunny", "?"},
            {"Daft_Punk_-_One_More_Time.mp3", "", "One More Time", "Daft Punk", "?"},
            {"Believer (Official Video) - Imagine Dragons.mp3", "", "Believer", "Imagine Dragons", ""},
            {"Rauw Alejandro x Bad Bunny - Algo Nuevo.mp3", "", "Algo Nuevo", "Rauw Alejandro x Bad Bunny", "?"},
            {"Metallica/Master of Puppets/01 - Battery.mp3", "", "Battery", "Metallica", ""},
            {"Música rara/AC_DC/Hells Bells - AC_DC.mp3", "", "Hells Bells", "AC_DC", ""},
            {"KILLER QUEEN.mp3", "KILLER QUEEN // QUEEN|", "KILLER QUEEN", "Queen", ""},
            {"tagged.mp3", "It Boy|bbno$", "It Boy", "bbno$", ""},
            {"lalala - bbno$.mp3", "", "lalala", "bbno$", ""},
            {"Solo.mp3", "", "Solo", "Artista desconocido", ""},
        };
        List<NameGuess.Entry> list = new ArrayList<>();
        for (String[] f : files) list.add(entry(f[0], f[1]));
        NameGuess.guess(list);
        for (int i = 0; i < files.length; i++) {
            NameGuess.Entry e = list.get(i);
            String[] f = files[i];
            check(e.title.equals(f[2]) && e.artist.equals(f[3]) && e.doubt == !f[4].isEmpty(),
                "guess " + f[0] + " → " + e.title + " / " + e.artist + (e.doubt ? " (?)" : ""));
        }
        check(list.get(7).album.equals("Master of Puppets"), "album from the folder");

        // alone, «Title - Artist» is a doubt (checked online)
        List<NameGuess.Entry> l1 = new ArrayList<>(Arrays.asList(entry("Highway to Hell - AC_DC.mp3", ""), entry("KILLER QUEEN.mp3", "KILLER QUEEN // QUEEN|")));
        NameGuess.guess(l1);
        check(l1.get(0).doubt && l1.get(0).artist.equals("Highway to Hell"), "alone: doubtful");
        check(l1.get(1).doubt && l1.get(1).artist.equals("QUEEN"), "title tag «Title // Artist»: doubtful");

        // a library artist decides, written as the library writes it
        List<NameGuess.Entry> l2 = new ArrayList<>(Arrays.asList(entry("t.mp3", "Back in Black|AC/DC"), entry("Highway to Hell - AC_DC.mp3", ""), entry("AC DC - Hells Bells.mp3", "")));
        NameGuess.guess(l2);
        check(l2.get(1).title.equals("Highway to Hell") && l2.get(1).artist.equals("AC/DC") && !l2.get(1).doubt, "known artist (second)");
        check(l2.get(2).title.equals("Hells Bells") && l2.get(2).artist.equals("AC/DC"), "known artist (first)");

        // online (simulated)
        List<String> asked = new ArrayList<>();
        NameGuess.lookup = q -> { asked.add(q); return CATALOG; };
        Object[][] oc = {
            {"AC DC", "Highway to Hell", NameGuess.SWAPPED, "AC/DC"},
            {"Highway to Hell", "AC_DC", NameGuess.STRAIGHT, "AC/DC"},
            {"Queen", "Bohemian Rhapsody (Remastered 2011)", NameGuess.SWAPPED, "Queen"},
            {"Bad Bunny", "Tití Me Preguntó", NameGuess.SWAPPED, "Bad Bunny"},
            {"7 rings", "Ariana Grande", NameGuess.STRAIGHT, "Ariana Grande"},
            {"Despechá", "Rosalía", NameGuess.STRAIGHT, "ROSALÍA"},
            {"Queen", "Perfume Genius", NameGuess.STRAIGHT, "Perfume Genius"},
            {"Some Song", "Nobody", NameGuess.UNKNOWN_ORDER, ""},
        };
        for (Object[] c : oc) {
            NameGuess.Answer r = NameGuess.checkOrder((String) c[0], (String) c[1]);
            check(r.r == (int) c[2] && r.name.equals(c[3]), "checkOrder " + c[0] + " / " + c[1] + " → " + r.r + " " + r.name);
        }

        // the repair, with corrections kept apart from the files
        File dir = Files.createTempDirectory("namestest").toFile();
        NameGuess.Fixes fixes = new NameGuess.Fixes(new File(dir, "meta-fix.json"));
        NameGuess.Cache cache = new NameGuess.Cache(new File(dir, "meta-check.json"));
        List<NameGuess.Entry> l3 = new ArrayList<>(Arrays.asList(entry("Highway to Hell - AC_DC.mp3", ""), entry("swapped.mp3", "AC DC|Hells Bells"),
            entry("good.mp3", "Believer|Imagine Dragons"), entry("Some Song - Nobody.mp3", "")));
        NameGuess.guess(l3);
        fixes.apply(l3);
        int fixed = 0;
        for (NameGuess.Entry e : l3) {
            if (!NameGuess.candidate(e, false)) continue;
            String[] c = NameGuess.correction(e, cache.get(e.title, e.artist));
            if (c != null && fixes.set(e, c[0], c[1], "auto")) fixed++;
        }
        check(fixed == 2, "corrected " + fixed + " of 4");
        check(l3.get(0).title.equals("Highway to Hell") && l3.get(0).artist.equals("AC/DC") && l3.get(0).fix.equals("auto"), "Highway to Hell - AC_DC → " + l3.get(0).title + " / " + l3.get(0).artist);
        check(l3.get(1).title.equals("Hells Bells") && l3.get(1).artist.equals("AC/DC"), "swapped tags → " + l3.get(1).title + " / " + l3.get(1).artist);
        check(l3.get(2).fix.isEmpty() && l3.get(3).fix.isEmpty(), "the right ones untouched");

        // after a restart: the same, and nothing asked again
        int n0 = asked.size();
        List<NameGuess.Entry> l4 = new ArrayList<>(Arrays.asList(entry("Highway to Hell - AC_DC.mp3", "")));
        NameGuess.guess(l4);
        new NameGuess.Fixes(new File(dir, "meta-fix.json")).apply(l4);
        check(l4.get(0).artist.equals("AC/DC"), "kept after a restart");
        NameGuess.Cache c2 = new NameGuess.Cache(new File(dir, "meta-check.json"));
        c2.get("Hells Bells", "AC DC");
        check(asked.size() == n0 && !c2.asked, "cached");

        // by hand wins; automatic doesn't replace it; a changed file drops it
        NameGuess.Entry e = l3.get(0);
        check(fixes.set(e, e.artist, e.title, "user") && e.title.equals("AC/DC"), "swap by hand");
        check(fixes.set(e, e.rawTitle, e.rawArtist, "user") && e.title.equals(e.rawTitle) && e.fix.equals("user"), "pinned as it was");
        check(!fixes.set(e, "Highway to Hell", "AC/DC", "auto") && e.title.equals("AC_DC"), "automatic doesn't replace by hand");
        e.rawTitle = "Highway to Hell"; e.rawArtist = "AC/DC (tags)";
        fixes.apply(e);
        check(e.fix.isEmpty() && e.artist.equals("AC/DC (tags)"), "the file changed: its tags win");

        // offline: nothing decided, nothing kept
        NameGuess.lookup = q -> null;
        File d2 = Files.createTempDirectory("namestest").toFile();
        NameGuess.Cache c3 = new NameGuess.Cache(new File(d2, "meta-check.json"));
        check(c3.get("AC DC", "Highway to Hell") == null && !new File(d2, "meta-check.json").exists(), "offline: nothing kept");
        NameGuess.lookup = q -> CATALOG;
        NameGuess.Answer back = c3.get("AC DC", "Highway to Hell");
        check(back != null && back.r == NameGuess.SWAPPED, "back online: decided");

        System.out.println(fails == 0 ? "ALL OK" : fails + " FAILED");
        System.exit(fails == 0 ? 0 : 1);
    }
}
