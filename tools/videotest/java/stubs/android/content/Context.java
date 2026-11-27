package android.content;

import java.io.File;

// Just enough of Android's Context for YtAudio/Diag on a PC (tools/videotest/java).
public class Context {
    public static final int MODE_PRIVATE = 0;
    private final File dir;
    public Context(File dir) { this.dir = dir; }
    public Context getApplicationContext() { return this; }
    public File getFilesDir() { return dir; }
    public File getCacheDir() { return dir; }
    public AssetManager getAssets() { return new AssetManager(); }
    public static class AssetManager { public java.io.InputStream open(String n) throws java.io.IOException { throw new java.io.FileNotFoundException(n); } }
    public SharedPreferences getSharedPreferences(String name, int mode) { throw new UnsupportedOperationException(); }
}
