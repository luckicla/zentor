package org.json;

import java.util.*;

public class JSONObject {
    public static final Object NULL = new Object() { public String toString() { return "null"; } };
    final LinkedHashMap<String, Object> map = new LinkedHashMap<>();
    public JSONObject() {}
    public JSONObject(String s) throws JSONException {
        Object v = JSON.parse(s);
        if (!(v instanceof JSONObject)) throw new JSONException("not an object");
        map.putAll(((JSONObject) v).map);
    }
    public JSONObject put(String k, Object v) throws JSONException { map.put(k, v); return this; }
    public JSONObject put(String k, long v) throws JSONException { map.put(k, v); return this; }
    public JSONObject put(String k, int v) throws JSONException { map.put(k, v); return this; }
    public JSONObject put(String k, boolean v) throws JSONException { map.put(k, v); return this; }
    public boolean has(String k) { return map.containsKey(k); }
    public Object remove(String k) { return map.remove(k); }
    public Object get(String k) throws JSONException { if (!map.containsKey(k)) throw new JSONException("no " + k); return map.get(k); }
    public Iterator<String> keys() { return map.keySet().iterator(); }
    public String optString(String k) { return optString(k, ""); }
    public String optString(String k, String d) { Object v = map.get(k); return v == null || v == NULL ? d : v.toString(); }
    public long optLong(String k) { return optLong(k, 0); }
    public long optLong(String k, long d) {
        Object v = map.get(k);
        if (v instanceof Number) return ((Number) v).longValue();
        if (v instanceof String) try { return Long.parseLong((String) v); } catch (NumberFormatException e) { return d; }
        return d;
    }
    public int optInt(String k) { return (int) optLong(k, 0); }
    public int optInt(String k, int d) { return (int) optLong(k, d); }
    public boolean optBoolean(String k) { Object v = map.get(k); return v instanceof Boolean && (Boolean) v; }
    public JSONArray optJSONArray(String k) { Object v = map.get(k); return v instanceof JSONArray ? (JSONArray) v : null; }
    public JSONObject optJSONObject(String k) { Object v = map.get(k); return v instanceof JSONObject ? (JSONObject) v : null; }
    @Override public String toString() {
        StringBuilder b = new StringBuilder("{");
        for (Map.Entry<String, Object> e : map.entrySet()) {
            if (b.length() > 1) b.append(',');
            b.append(JSON.quote(e.getKey())).append(':').append(JSON.write(e.getValue()));
        }
        return b.append('}').toString();
    }
}
