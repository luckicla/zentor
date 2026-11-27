package org.json;

import java.util.*;

public class JSONArray {
    final ArrayList<Object> list = new ArrayList<>();
    public JSONArray() {}
    public JSONArray(String s) throws JSONException {
        Object v = JSON.parse(s);
        if (!(v instanceof JSONArray)) throw new JSONException("not an array");
        list.addAll(((JSONArray) v).list);
    }
    public int length() { return list.size(); }
    public JSONArray put(Object v) { list.add(v); return this; }
    public Object opt(int i) { return i >= 0 && i < list.size() ? list.get(i) : null; }
    public JSONObject optJSONObject(int i) { Object v = opt(i); return v instanceof JSONObject ? (JSONObject) v : null; }
    public JSONObject getJSONObject(int i) throws JSONException { JSONObject o = optJSONObject(i); if (o == null) throw new JSONException("no object at " + i); return o; }
    public String optString(int i) { Object v = opt(i); return v == null ? "" : v.toString(); }
    @Override public String toString() {
        StringBuilder b = new StringBuilder("[");
        for (Object v : list) { if (b.length() > 1) b.append(','); b.append(JSON.write(v)); }
        return b.append(']').toString();
    }
}
