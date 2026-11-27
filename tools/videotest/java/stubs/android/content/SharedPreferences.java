package android.content;

public interface SharedPreferences {
    long getLong(String k, long d);
    Editor edit();
    interface Editor { Editor putLong(String k, long v); void apply(); }
}
