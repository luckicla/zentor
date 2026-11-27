package android.net;

public final class Uri {
    private final String s;
    private Uri(String s) { this.s = s; }
    public static Uri parse(String s) { return new Uri(s); }
    public String getQueryParameter(String k) {
        int q = s.indexOf('?');
        if (q < 0) return null;
        for (String kv : s.substring(q + 1).split("&")) { int i = kv.indexOf('='); if ((i >= 0 ? kv.substring(0, i) : kv).equals(k)) return i >= 0 ? kv.substring(i + 1) : ""; }
        return null;
    }
}
