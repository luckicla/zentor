package com.zentor.player;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Title and artist of songs without good tags: the same logic as the PC
 * (names.go), in plain Java (no Android classes: it's tested on a PC).
 *
 * A file name «A - B» can be «Artist - Title» or «Title - Artist». The order
 * is decided with evidence (guess): artists already in the library, the
 * folders the file is in, and what each side looks like («(Remastered)»,
 * «(Official Video)», «(feat. X)» = the title). When the evidence is weak the
 * song is doubtful, and the background check asks Deezer / iTunes (the same
 * services the covers come from) which way round exists (checkOrder, cached
 * in meta-check.json). Corrections are kept by MixUp (meta-fix.json), never
 * written into the files; one made by hand always wins over an automatic one,
 * and a correction only applies while the song still reads as when it was made.
 */
final class NameGuess {
    private NameGuess() {}

    /** a song, as far as its names go */
    static final class Entry {
        String id = "", title = "", artist = "", album = "";
        String tagT = "", tagA = "", nameA = "", nameB = "";
        boolean tagTitle, tagArtist, splitTitle, numbered, albumDir, doubt;
        List<String> dirs = new ArrayList<>(); // the folders it's in, the nearest first
        String rawTitle = "", rawArtist = "", fix = "";
    }

    static final String UNKNOWN = "Artista desconocido";

    // ---- cleaning names (library.go / names.go) ----

    static String fold(String s) {
        if (s == null) return "";
        String n = Normalizer.normalize(s.toLowerCase(Locale.ROOT).replace('$', 's'), Normalizer.Form.NFD);
        StringBuilder b = new StringBuilder();
        n.codePoints().forEach(c -> { if (Character.isLetterOrDigit(c)) b.appendCodePoint(c); });
        return b.toString();
    }

    static final Pattern NAME_JUNK = Pattern.compile("(?i)\\s*[\\(\\[](official|oficial|video|lyric|lyrics|letra|audio|visualizer|hd|hq|4k|videoclip|music video|official music video|official video|official audio|lyric video|video oficial|audio oficial)[^\\)\\]]*[\\)\\]]");
    static final Pattern SEARCH_JUNK = Pattern.compile("(?i)\\s*[\\(\\[][^\\)\\]]*[\\)\\]]|\\s+(feat|ft)\\.?\\s.*$");
    static final Pattern ARTIST_SPLIT = Pattern.compile("(?i)\\s*(,|;| feat\\.? | ft\\.? | & | x | y )\\s*");
    static final Pattern LEAD_NUM = Pattern.compile("^\\s*(?:(?i:cd|disc|disco)\\s*\\d+\\s*[-.]?\\s*)?(\\d{1,3})(?:-(\\d{1,3}))?(\\s*[.)]\\s+|\\s*[.)]|\\s*[-_–]\\s*|\\s+)");
    static final Pattern VERSION_WORDS = Pattern.compile("(?iu)[\\(\\[][^\\)\\]]*\\b(remaster(ed)?|remasterizad[oa]|live|en vivo|en directo|directo|remix|mix|version|versión|edit|acoustic|acústic[oa]|acustic[oa]|demo|instrumental|cover|extended|radio|bonus|mono|stereo|deluxe|unplugged|session|sesión|sped up|slowed|reverb|nightcore|karaoke|original)\\b");
    static final Pattern FEAT_PAREN = Pattern.compile("(?i)[\\(\\[]\\s*(feat|ft|featuring|con|with|prod)\\b");
    static final Pattern PROD_WORD = Pattern.compile("(?i)\\bprod\\.?\\s*(by)?\\s");
    static final Pattern COLLAB = Pattern.compile("(?i)^[^\\(\\[]+?(\\s(x|&|feat\\.?|ft\\.?|featuring)\\s|,\\s)");

    static String plain(String s) { return SEARCH_JUNK.matcher(s).replaceAll("").trim(); }

    static String cleanTitle(String s) { return NAME_JUNK.matcher(s).replaceAll("").trim(); }

    static String tidy(String s) {
        int a = 0, b = s.length();
        while (a < b && !keep(s.codePointAt(a))) a += Character.charCount(s.codePointAt(a));
        while (b > a && !keep(s.codePointBefore(b))) b -= Character.charCount(s.codePointBefore(b));
        return s.substring(a, b);
    }
    private static boolean keep(int c) { return Character.isLetterOrDigit(c) || ")]!?'\"$".indexOf(c) >= 0; }

    /** «A - B», «A // B», «A | B»… → {A, B} (B empty if it doesn't split) */
    static String[] splitPair(String s) {
        for (String sep : new String[]{" - ", " – ", " — ", " // ", "//", " | ", " / "}) {
            int i = s.indexOf(sep);
            if (i > 0) {
                String a = tidy(s.substring(0, i)), b = tidy(s.substring(i + sep.length()));
                if (!a.isEmpty() && !b.isEmpty()) return new String[]{a, b};
            }
        }
        return new String[]{tidy(s), ""};
    }

    static String mainArtist(String s) {
        String[] p = ARTIST_SPLIT.split(s, 2);
        return p.length > 0 && !p[0].trim().isEmpty() ? p[0].trim() : s.trim();
    }

    /** {name to split, "1" if it started with a track number} (see cleanBase in names.go) */
    static String[] cleanBase(String base) {
        base = base.trim();
        if (!base.contains(" ") && base.contains("_")) base = base.replace('_', ' ').trim();
        else base = base.replace("_-_", " - ").replace("_–_", " – ");
        Matcher m = LEAD_NUM.matcher(base);
        if (!m.find()) return new String[]{base, ""};
        String rest = base.substring(m.end()).trim();
        if (rest.isEmpty()) return new String[]{base, ""};
        String num = m.group(1), sepRaw = m.group(3), sep = sepRaw.trim();
        boolean pair = !splitPair(rest)[1].isEmpty();
        if (num.startsWith("0") && num.length() > 1) return new String[]{rest, "1"};
        if (m.group(2) != null) return new String[]{rest, "1"};
        if (sep.equals(".") || sep.equals(")")) {
            if (Character.isDigit(rest.charAt(0)) && !sepRaw.contains(" ")) return new String[]{base, ""};
            return new String[]{rest, "1"};
        }
        if ((sep.equals("-") || sep.equals("_") || sep.equals("–")) && pair) return new String[]{rest, "1"};
        return new String[]{base, ""};
    }

    /** like load() on the PC: what the tags and the file's name give */
    static void prepare(Entry e, String fileBase) {
        e.tagTitle = !e.tagT.isEmpty();
        e.tagArtist = !e.tagA.isEmpty();
        e.title = e.tagT;
        e.artist = e.tagA;
        if (e.tagTitle && e.tagArtist) return;
        String[] cb = cleanBase(fileBase);
        String base = cb[0];
        e.numbered = !cb[1].isEmpty();
        if (e.tagTitle) {
            String[] p = splitPair(e.tagT);
            if (!p[1].isEmpty()) { base = p[0] + " - " + p[1]; e.splitTitle = true; }
        }
        e.nameA = base;
        String[] p = splitPair(base);
        if (!p[1].isEmpty()) { e.nameA = p[0]; e.nameB = p[1]; }
    }

    // ---- evidence ----

    static double titleEvidence(String s) {
        double e = 0;
        if (NAME_JUNK.matcher(s).find() || VERSION_WORDS.matcher(s).find()) e += 2;
        if (FEAT_PAREN.matcher(s).find() || PROD_WORD.matcher(s).find()) e += 1;
        return e;
    }

    static final class Artists {
        final Map<String, String> names = new HashMap<>();
        void add(String a) {
            for (String p : ARTIST_SPLIT.split(a)) {
                String f = fold(p);
                if (f.codePointCount(0, f.length()) >= 2 && !f.equals(fold(UNKNOWN))) names.putIfAbsent(f, p.trim());
            }
            String f = fold(a);
            if (!f.isEmpty()) names.putIfAbsent(f, a.trim());
        }
        boolean has(String s) {
            String f = fold(s), m = fold(mainArtist(s));
            return !f.isEmpty() && names.containsKey(f) || !m.isEmpty() && names.containsKey(m);
        }
        String spelling(String s) { String n = names.get(fold(s)); return n != null && !n.isEmpty() ? n : s; }
    }

    static double folderEvidence(String s, List<String> dirs) {
        String f = fold(s);
        if (f.codePointCount(0, f.length()) < 2) return 0;
        double best = 0;
        for (int i = 0; i < dirs.size() && i < 2; i++) {
            String fd = fold(dirs.get(i));
            if (fd.equals(f) || fold(mainArtist(dirs.get(i))).equals(f)) return 3;
            if (f.codePointCount(0, f.length()) >= 4 && fd.startsWith(f) && best < 1.5) best = 1.5;
        }
        return best;
    }

    private static int words(String s) { String t = s.trim(); return t.isEmpty() ? 0 : t.split("\\s+").length; }

    /** > 0: a is the artist; < 0: b is. Its size is how sure. */
    static double orderScore(String a, String b, List<String> dirs, Artists ix) {
        double s = 0;
        if (ix.has(a)) s += 3;
        if (ix.has(b)) s -= 3;
        s += folderEvidence(a, dirs) - folderEvidence(b, dirs);
        s += titleEvidence(b) - titleEvidence(a);
        if (COLLAB.matcher(a).find() && !FEAT_PAREN.matcher(a).find()) s += 1;
        if (COLLAB.matcher(b).find() && !FEAT_PAREN.matcher(b).find()) s -= 1;
        int wa = words(a), wb = words(b);
        if (wb - wa >= 3) s += 0.5;
        else if (wa - wb >= 3) s -= 0.5;
        return s;
    }

    static final double SURE = 2;

    /** fills title / artist of the songs without tags (see guessNames in names.go) */
    static void guess(List<Entry> list) {
        Artists ix = new Artists();
        for (Entry e : list) {
            if (e.tagTitle) e.title = e.tagT;
            if (e.tagArtist) e.artist = e.tagA;
            if (e.albumDir) { e.album = ""; e.albumDir = false; }
            e.doubt = false;
            if (e.tagArtist) ix.add(e.artist);
        }
        int first = 0, second = 0;
        for (Entry e : list) {
            if (e.nameB.isEmpty() || e.tagTitle && e.tagArtist) continue;
            if (ix.has(e.nameA) && !ix.has(e.nameB)) first++;
            else if (ix.has(e.nameB) && !ix.has(e.nameA)) second++;
        }
        int artistFirst = second >= 2 && second > 2 * first ? -1 : first >= 2 && first > 2 * second ? 1 : 0;
        for (Entry e : list) decide(e, ix, artistFirst);
        // a second round with the artists of the sure guesses too (see names.go)
        boolean grown = false;
        for (Entry e : list) {
            if (!e.tagArtist && !e.nameB.isEmpty() && !e.doubt && !UNKNOWN.equals(e.artist) && !ix.has(e.artist)) { ix.add(e.artist); grown = true; }
        }
        if (grown) for (Entry e : list) if (e.doubt) decide(e, ix, artistFirst);
    }

    private static void decide(Entry e, Artists ix, int artistFirst) {
        {
            if (e.tagTitle && e.tagArtist) {
                e.doubt = ix.has(e.title) && !ix.has(e.artist) && !fold(e.title).equals(fold(e.artist));
                return;
            }
            String title = e.nameA, artist = "";
            if (!e.nameB.isEmpty()) {
                String a = e.nameA, b = e.nameB;
                double sc = orderScore(a, b, e.dirs, ix);
                if (e.tagArtist) {
                    if (fold(e.artist).equals(fold(a)) || ix.has(a) && !ix.has(b)) sc = 9;
                    else if (fold(e.artist).equals(fold(b))) sc = -9;
                }
                if (e.splitTitle) sc -= 1.5;
                if (sc > -SURE && sc < SURE) {
                    if (artistFirst < 0) sc -= 1;
                    else if (artistFirst > 0) sc += 0.5;
                }
                if (sc < 0) { artist = b; title = a; } else { artist = a; title = b; }
                e.doubt = sc > -SURE && sc < SURE;
            } else if (e.numbered && !e.tagArtist) {
                if (e.dirs.size() >= 1 && ix.has(e.dirs.get(0))) artist = e.dirs.get(0);
                else if (e.dirs.size() >= 2) {
                    artist = e.dirs.get(1);
                    if (e.album.isEmpty()) { e.album = e.dirs.get(0); e.albumDir = true; }
                }
            }
            if (!e.tagTitle || e.splitTitle) {
                e.title = cleanTitle(title);
                if (e.title.isEmpty()) e.title = title;
            }
            if (!e.tagArtist) {
                e.artist = ix.spelling(cleanTitle(artist));
                if (e.artist.isEmpty()) e.artist = UNKNOWN;
            }
        }
    }

    // ---- MixUp's own corrections (meta-fix.json) ----

    static final class Fixes {
        private final File file;
        private JSONObject m;

        Fixes(File file) {
            this.file = file;
            try { m = new JSONObject(new String(readAll(new FileInputStream(file)), StandardCharsets.UTF_8)); }
            catch (Exception ex) { m = new JSONObject(); }
        }

        /** right after guess: the names are the raw ones */
        synchronized void apply(List<Entry> list) {
            for (Entry e : list) { e.rawTitle = e.title; e.rawArtist = e.artist; apply(e); }
        }

        synchronized void apply(Entry e) {
            e.title = e.rawTitle; e.artist = e.rawArtist; e.fix = "";
            JSONObject f = m.optJSONObject(e.id);
            if (f == null || !f.optString("wasTitle").equals(e.rawTitle) || !f.optString("wasArtist").equals(e.rawArtist)) return;
            e.title = f.optString("title"); e.artist = f.optString("artist"); e.fix = f.optString("by");
            e.doubt = false;
        }

        /** an automatic correction never replaces one made by hand that still applies */
        synchronized boolean set(Entry e, String title, String artist, String by) {
            if (title == null || artist == null || title.trim().isEmpty() || artist.trim().isEmpty()) return false;
            JSONObject old = m.optJSONObject(e.id);
            if (old != null && "user".equals(old.optString("by")) && !"user".equals(by)
                    && old.optString("wasTitle").equals(e.rawTitle) && old.optString("wasArtist").equals(e.rawArtist)) return false;
            try {
                m.put(e.id, new JSONObject().put("title", title.trim()).put("artist", artist.trim()).put("wasTitle", e.rawTitle)
                        .put("wasArtist", e.rawArtist).put("by", by).put("t", System.currentTimeMillis() / 1000));
            } catch (Exception ex) { return false; }
            save();
            apply(e);
            return true;
        }

        synchronized void drop(Entry e) {
            if (m.remove(e.id) != null) save();
            apply(e);
        }

        private void save() {
            try { writeAtomic(file, m.toString().getBytes(StandardCharsets.UTF_8)); } catch (Exception ignored) {}
        }
    }

    // ---- asking the internet which way round it is ----

    /** null: neither service answered (no internet): nothing is decided nor cached */
    interface Lookup { List<String[]> search(String q); }

    /** tests replace it (no network) */
    static Lookup lookup = NameGuess::online;

    static List<String[]> online(String q) {
        List<String[]> out = new ArrayList<>();
        boolean any = false;
        try {
            JSONArray r = new JSONObject(get("https://api.deezer.com/search?limit=25&q=" + URLEncoder.encode(q, "UTF-8"))).optJSONArray("data");
            for (int i = 0; r != null && i < r.length(); i++) {
                JSONObject o = r.getJSONObject(i), ar = o.optJSONObject("artist");
                out.add(new String[]{o.optString("title"), ar == null ? "" : ar.optString("name")});
            }
            any = true;
        } catch (Exception ignored) {}
        if (!out.isEmpty()) return out;
        try {
            JSONArray r = new JSONObject(get("https://itunes.apple.com/search?media=music&entity=song&limit=25&term=" + URLEncoder.encode(q, "UTF-8"))).optJSONArray("results");
            for (int i = 0; r != null && i < r.length(); i++) {
                JSONObject o = r.getJSONObject(i);
                out.add(new String[]{o.optString("trackName"), o.optString("artistName")});
            }
            any = true;
        } catch (Exception ignored) {}
        return any ? out : null;
    }

    static String baseTitle(String s) {
        s = plain(NAME_JUNK.matcher(s).replaceAll(""));
        for (String sep : new String[]{" - ", " – ", " — "}) { int i = s.indexOf(sep); if (i > 0) s = s.substring(0, i); }
        return fold(s);
    }

    static boolean sameArtist(String ours, String theirs) {
        String a = fold(ours), b = fold(theirs);
        if (a.isEmpty() || b.isEmpty()) return false;
        if (a.equals(b) || fold(mainArtist(ours)).equals(fold(mainArtist(theirs)))) return true;
        return a.length() >= 4 && b.length() >= 4 && (a.startsWith(b) || b.startsWith(a));
    }

    static final int UNKNOWN_ORDER = 0, STRAIGHT = 1, SWAPPED = -1;

    static final class Answer {
        final int r; final String name;
        Answer(int r, String name) { this.r = r; this.name = name == null ? "" : name; }
    }

    /** one search with both names finds the song whichever way round; an exact title AND artist match decides. null: offline */
    static Answer checkOrder(String title, String artist) {
        List<String[]> hits = lookup.search((plain(title) + " " + plain(artist)).trim());
        if (hits == null) return null;
        if (hits.isEmpty() && !plain(title).equals(title)) hits = lookup.search((title + " " + artist).trim());
        if (hits == null) return null;
        String ft = baseTitle(title), fa = baseTitle(artist);
        int straight = 0, swapped = 0;
        String nameS = "", nameW = "";
        for (String[] h : hits) {
            String ht = baseTitle(h[0]);
            if (ht.isEmpty()) continue;
            if (ht.equals(ft) && sameArtist(artist, h[1])) { straight++; if (nameS.isEmpty()) nameS = h[1]; }
            if (ht.equals(fa) && sameArtist(title, h[1])) { swapped++; if (nameW.isEmpty()) nameW = h[1]; }
        }
        if (straight > 0 && straight >= swapped) return new Answer(STRAIGHT, nameS);
        if (swapped > 0) return new Answer(SWAPPED, nameW);
        return new Answer(UNKNOWN_ORDER, "");
    }

    /** the answers, so the same pair is never asked twice (unknown ones again after a month) */
    static final class Cache {
        private final File file;
        private JSONObject m;
        boolean asked; // the last get went to the internet

        Cache(File file) {
            this.file = file;
            try { m = new JSONObject(new String(readAll(new FileInputStream(file)), StandardCharsets.UTF_8)); }
            catch (Exception ex) { m = new JSONObject(); }
        }

        /** null: no internet (nothing kept) */
        synchronized Answer get(String title, String artist) {
            long month = System.currentTimeMillis() / 1000 - 30L * 24 * 3600;
            JSONObject a = m.optJSONObject(fold(title) + "|" + fold(artist));
            asked = false;
            if (a != null && (a.optInt("r") != 0 || a.optLong("t") > month)) return new Answer(a.optInt("r"), a.optString("n"));
            JSONObject b = m.optJSONObject(fold(artist) + "|" + fold(title));
            if (b != null && (b.optInt("r") != 0 || b.optLong("t") > month)) return new Answer(-b.optInt("r"), b.optString("n"));
            Answer r = checkOrder(title, artist);
            asked = true;
            if (r == null) return null;
            try {
                m.put(fold(title) + "|" + fold(artist), new JSONObject().put("r", r.r).put("n", r.name).put("t", System.currentTimeMillis() / 1000));
                writeAtomic(file, m.toString().getBytes(StandardCharsets.UTF_8));
            } catch (Exception ignored) {}
            return r;
        }
    }

    /** the songs worth checking: doubtful guesses and songs without a cover, not corrected yet */
    static boolean candidate(Entry e, boolean hasCover) {
        if (!e.fix.isEmpty() || fold(e.artist).isEmpty() || fold(e.title).isEmpty() || UNKNOWN.equals(e.artist) || fold(e.title).equals(fold(e.artist))) return false;
        return e.doubt || !hasCover;
    }

    /** what to do with a song after asking: {title, artist} of the correction, or null */
    static String[] correction(Entry e, Answer a) {
        if (a.r == SWAPPED) {
            String na = !a.name.isEmpty() && fold(a.name).equals(fold(e.title)) ? a.name : e.title;
            return new String[]{e.artist, na};
        }
        if (a.r == STRAIGHT && !e.tagArtist && !a.name.isEmpty() && !a.name.equals(e.artist) && fold(a.name).equals(fold(e.artist)))
            return new String[]{e.title, a.name}; // «AC_DC» → «AC/DC»
        return null;
    }

    // the page reloads the library when this goes up (GET /api/covers → meta)
    static volatile int ver;
    static volatile boolean running;

    // ---- small helpers (like LocalServer's, without Android) ----

    static byte[] readAll(InputStream in) throws java.io.IOException {
        try (InputStream i = in) {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            for (int n; (n = i.read(buf)) > 0; ) o.write(buf, 0, n);
            return o.toByteArray();
        }
    }

    static void writeAtomic(File f, byte[] data) throws java.io.IOException {
        File dir = f.getParentFile();
        if (dir != null) dir.mkdirs();
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(data); }
        if (!tmp.renameTo(f)) { f.delete(); if (!tmp.renameTo(f)) throw new java.io.IOException("rename"); }
    }

    private static String get(String u) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(10000);
        c.setRequestProperty("User-Agent", "MixUp (music player)");
        c.setRequestProperty("Accept", "application/json");
        if (c.getResponseCode() != 200) throw new Exception("http " + c.getResponseCode());
        byte[] b = readAll(c.getInputStream());
        if (b.length > 2 << 20) throw new Exception("big");
        return new String(b, StandardCharsets.UTF_8);
    }
}
