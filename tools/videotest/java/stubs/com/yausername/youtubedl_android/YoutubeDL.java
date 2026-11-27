package com.yausername.youtubedl_android;

// yt-dlp isn't on a PC test: every call fails (the fast way is what's tested).
public class YoutubeDL {
    public enum UpdateChannel { _STABLE, _NIGHTLY }
    private static final YoutubeDL I = new YoutubeDL();
    public static YoutubeDL getInstance() { return I; }
    public void init(Object app) throws Exception { throw new Exception("no yt-dlp in tests"); }
    public String version(Object app) { return null; }
    public Object updateYoutubeDL(Object app, UpdateChannel c) throws Exception { throw new Exception("no yt-dlp in tests"); }
    public YoutubeDLResponse execute(YoutubeDLRequest r) throws Exception { throw new Exception("no yt-dlp in tests"); }
}
