package com.zentor.player;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadataRetriever;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.LruCache;
import android.util.Size;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/** Reads the phone's music from MediaStore, in the same shape the web UI expects. */
class MusicLibrary {

    static class Song {
        long id, albumId, size, durationMs, added;
        String title, artist, album, mime, file;
        int track, kbps;
        Uri uri;
    }

    private final Context ctx;
    private final Map<String, Song> byId = new HashMap<>();
    private static final byte[] NONE = new byte[0];
    private final LruCache<String, byte[]> covers = new LruCache<String, byte[]>(24 * 1024 * 1024) {
        @Override protected int sizeOf(String k, byte[] v) { return Math.max(1, v.length); }
    };

    MusicLibrary(Context ctx) { this.ctx = ctx.getApplicationContext(); }

    synchronized Song get(String id) { return byId.get(id); }

    synchronized java.util.List<Song> all() { return new java.util.ArrayList<>(byId.values()); }

    /** title and artist to search a cover with */
    static String[] displayNames(Song s) { return new String[]{s.title, s.artist}; }

    // covers ZenTor found on the internet (Android doesn't let it write them into the files)
    private java.io.File foundFile(Song s) { return new java.io.File(ctx.getFilesDir(), "found-covers/" + s.id); }

    void setFoundCover(Song s, byte[] img) {
        java.io.File f = foundFile(s);
        f.getParentFile().mkdirs();
        try (java.io.FileOutputStream o = new java.io.FileOutputStream(f)) { o.write(img); } catch (Exception ignored) {}
        covers.put(String.valueOf(s.id), img);
    }

    synchronized boolean hasFile(String name, long size) {
        for (Song s : byId.values()) if (name.equalsIgnoreCase(s.file) && s.size == size) return true;
        return false;
    }

    synchronized JSONArray scan() {
        byId.clear();
        JSONArray out = new JSONArray();
        Uri collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        String[] cols = {
            MediaStore.Audio.Media._ID, MediaStore.Audio.Media.TITLE, MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM, MediaStore.Audio.Media.ALBUM_ID, MediaStore.Audio.Media.TRACK,
            MediaStore.Audio.Media.DURATION, MediaStore.Audio.Media.MIME_TYPE, MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.DISPLAY_NAME, MediaStore.Audio.Media.DATE_ADDED,
        };
        String where = MediaStore.Audio.Media.IS_MUSIC + " != 0 AND " + MediaStore.Audio.Media.DURATION + " >= 20000";
        String sort = MediaStore.Audio.Media.DATE_ADDED + " DESC";
        try (Cursor c = ctx.getContentResolver().query(collection, cols, where, null, sort)) {
            if (c == null) return out;
            while (c.moveToNext()) {
                Song s = new Song();
                s.id = c.getLong(0);
                s.title = nonEmpty(c.getString(1), "Sin título");
                s.artist = c.getString(2);
                if (s.artist == null || s.artist.isEmpty() || s.artist.equals("<unknown>")) {
                    s.artist = "Artista desconocido";
                    // no tags (e.g. a song downloaded from YouTube): "Artist - Title" from the file name
                    int dash = s.title.indexOf(" - ");
                    if (dash > 0 && dash < s.title.length() - 3) { s.artist = s.title.substring(0, dash).trim(); s.title = s.title.substring(dash + 3).trim(); }
                }
                s.album = c.getString(3) == null ? "" : c.getString(3);
                s.albumId = c.getLong(4);
                s.track = c.getInt(5) % 1000; // MediaStore stores disc * 1000 + track
                s.durationMs = c.getLong(6);
                s.mime = c.getString(7) == null ? "audio/mpeg" : c.getString(7);
                s.size = c.getLong(8);
                s.file = c.getString(9) == null ? "" : c.getString(9);
                s.added = c.getLong(10); // seconds
                s.kbps = s.durationMs > 0 ? (int) Math.round(s.size * 8.0 / s.durationMs) : 0;
                s.uri = ContentUris.withAppendedId(collection, s.id);
                byId.put(String.valueOf(s.id), s);

                JSONObject j = new JSONObject();
                j.put("id", String.valueOf(s.id));
                j.put("title", s.title);
                j.put("artist", s.artist);
                j.put("album", s.album);
                j.put("num", s.track);
                j.put("duration", s.durationMs / 1000.0);
                j.put("cover", true); // checked lazily; the UI hides covers that fail to load
                j.put("fmt", format(s.mime));
                j.put("kbps", s.kbps);
                j.put("rate", 0);
                j.put("bits", 0);
                j.put("size", s.size);
                j.put("file", s.file);
                j.put("added", s.added);
                out.put(j);
            }
        } catch (Exception e) {
            // no permission yet, or MediaStore unavailable: show an empty library
        }
        return out;
    }

    /** JPEG/PNG bytes of the song's cover, or null if it has none. */
    byte[] cover(Song s) {
        String key = String.valueOf(s.id);
        byte[] cached = covers.get(key);
        if (cached != null) return cached == NONE ? null : cached;
        java.io.File found = foundFile(s);
        if (found.exists()) {
            try (java.io.FileInputStream in = new java.io.FileInputStream(found)) {
                byte[] b = LocalServer.readAll(in);
                covers.put(key, b);
                return b;
            } catch (Exception ignored) {}
        }

        // covers are also kept on disk, so they don't all have to be pulled
        // out of the files again every time the app starts
        java.io.File disk = new java.io.File(ctx.getCacheDir(), "covers/" + key);
        java.io.File none = new java.io.File(ctx.getCacheDir(), "covers/" + key + ".none");
        if (none.exists()) { covers.put(key, NONE); return null; }
        if (disk.exists()) {
            try (java.io.FileInputStream in = new java.io.FileInputStream(disk)) {
                byte[] b = new byte[(int) disk.length()];
                int off = 0, n;
                while (off < b.length && (n = in.read(b, off, b.length - off)) > 0) off += n;
                covers.put(key, b);
                return b;
            } catch (Exception ignored) {}
        }

        byte[] img = null;
        MediaMetadataRetriever r = new MediaMetadataRetriever();
        try {
            r.setDataSource(ctx, s.uri);
            img = r.getEmbeddedPicture();
        } catch (Exception ignored) {
        } finally {
            try { r.release(); } catch (Exception ignored) {}
        }
        if (img == null) img = albumArt(s);
        covers.put(key, img == null ? NONE : img);
        try {
            disk.getParentFile().mkdirs();
            if (img == null) none.createNewFile();
            else try (java.io.FileOutputStream o = new java.io.FileOutputStream(disk)) { o.write(img); }
        } catch (Exception ignored) {}
        return img;
    }

    private byte[] albumArt(Song s) {
        ContentResolver cr = ctx.getContentResolver();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                Uri album = ContentUris.withAppendedId(MediaStore.Audio.Albums.EXTERNAL_CONTENT_URI, s.albumId);
                Bitmap b = cr.loadThumbnail(album, new Size(1200, 1200), null);
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                b.compress(Bitmap.CompressFormat.JPEG, 90, bos);
                return bos.toByteArray();
            }
            Uri art = ContentUris.withAppendedId(Uri.parse("content://media/external/audio/albumart"), s.albumId);
            try (InputStream in = cr.openInputStream(art)) {
                if (in == null) return null;
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                for (int n; (n = in.read(buf)) > 0; ) bos.write(buf, 0, n);
                return bos.toByteArray();
            }
        } catch (Exception e) {
            return null;
        }
    }

    Bitmap coverBitmap(Song s) {
        byte[] b = cover(s);
        if (b == null) return null;
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inSampleSize = 2;
        return BitmapFactory.decodeByteArray(b, 0, b.length, o);
    }

    /**
     * Copies a song the user picked into Music/ZenTor, so it shows up in the
     * library (and in any other music app). Reads exactly `length` bytes.
     */
    void importSong(String name, InputStream in, long length) throws IOException {
        name = cleanName(name);
        String mime = mimeFor(name);
        if (mime == null) throw new IOException("not audio");

        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver cr = ctx.getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.Audio.Media.DISPLAY_NAME, name);
            v.put(MediaStore.Audio.Media.MIME_TYPE, mime);
            v.put(MediaStore.Audio.Media.RELATIVE_PATH, Environment.DIRECTORY_MUSIC + "/ZenTor");
            v.put(MediaStore.Audio.Media.IS_PENDING, 1);
            Uri uri = cr.insert(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
            if (uri == null) throw new IOException("insert failed");
            try (OutputStream out = cr.openOutputStream(uri)) {
                if (out == null) throw new IOException("can't write");
                copy(in, out, length);
            } catch (IOException e) {
                cr.delete(uri, null, null);
                throw e;
            }
            v.clear();
            v.put(MediaStore.Audio.Media.IS_PENDING, 0);
            cr.update(uri, v, null, null);
        } else {
            File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "ZenTor");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("can't create " + dir);
            File f = new File(dir, name);
            String stem = name.contains(".") ? name.substring(0, name.lastIndexOf('.')) : name;
            String ext = name.contains(".") ? name.substring(name.lastIndexOf('.')) : "";
            for (int i = 2; f.exists(); i++) f = new File(dir, stem + " (" + i + ")" + ext);
            try (OutputStream out = new FileOutputStream(f)) {
                copy(in, out, length);
            } catch (IOException e) {
                f.delete();
                throw e;
            }
            final Object done = new Object();
            MediaScannerConnection.scanFile(ctx, new String[]{f.getPath()}, new String[]{mime},
                    (path, uri) -> { synchronized (done) { done.notifyAll(); } });
            synchronized (done) {
                try { done.wait(5000); } catch (InterruptedException ignored) {}
            }
        }
    }

    private static void copy(InputStream in, OutputStream out, long length) throws IOException {
        byte[] buf = new byte[64 * 1024];
        long left = length;
        while (left > 0) {
            int n = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (n < 0) throw new IOException("upload cut short");
            out.write(buf, 0, n);
            left -= n;
        }
    }

    static String cleanName(String n) {
        n = n.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        while (n.startsWith(".")) n = n.substring(1);
        if (n.isEmpty()) n = "cancion.mp3";
        if (n.length() > 150) {
            int dot = n.lastIndexOf('.');
            String ext = dot > 0 ? n.substring(dot) : "";
            n = n.substring(0, 140) + ext;
        }
        return n;
    }

    static String mimeFor(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".m4a") || n.endsWith(".aac")) return "audio/mp4";
        if (n.endsWith(".flac")) return "audio/flac";
        if (n.endsWith(".ogg") || n.endsWith(".oga")) return "audio/ogg";
        if (n.endsWith(".opus")) return "audio/opus";
        if (n.endsWith(".wav")) return "audio/wav";
        return null;
    }

    static String format(String mime) {
        switch (mime) {
            case "audio/mpeg": return "MP3";
            case "audio/mp4": case "audio/x-m4a": case "audio/aac": return "M4A";
            case "audio/flac": case "audio/x-flac": return "FLAC";
            case "audio/ogg": case "application/ogg": return "OGG";
            case "audio/opus": return "OPUS";
            case "audio/wav": case "audio/x-wav": return "WAV";
            default:
                int i = mime.indexOf('/');
                return (i >= 0 ? mime.substring(i + 1) : mime).toUpperCase();
        }
    }

    private static String nonEmpty(String s, String fallback) {
        return s == null || s.trim().isEmpty() ? fallback : s;
    }
}
