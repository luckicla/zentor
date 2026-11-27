package org.json;

import java.util.*;

// A small JSON reader/writer standing in for Android's org.json in tests.
final class JSON {
    final String s; int i;
    JSON(String s) { this.s = s; }
    static Object parse(String s) {
        JSON p = new JSON(s); p.ws(); Object v = p.value(); p.ws();
        if (p.i != s.length()) throw new JSONException("trailing data");
        return v;
    }
    void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
    Object value() {
        if (i >= s.length()) throw new JSONException("end of input");
        char c = s.charAt(i);
        if (c == '{') {
            i++; JSONObject o = new JSONObject(); ws();
            if (s.charAt(i) == '}') { i++; return o; }
            while (true) {
                ws(); String k = str(); ws(); expect(':'); ws(); o.map.put(k, value()); ws();
                if (s.charAt(i) == ',') { i++; continue; }
                expect('}'); return o;
            }
        }
        if (c == '[') {
            i++; JSONArray a = new JSONArray(); ws();
            if (s.charAt(i) == ']') { i++; return a; }
            while (true) {
                ws(); a.list.add(value()); ws();
                if (s.charAt(i) == ',') { i++; continue; }
                expect(']'); return a;
            }
        }
        if (c == '"') return str();
        if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
        if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
        if (s.startsWith("null", i)) { i += 4; return JSONObject.NULL; }
        int st = i;
        while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
        if (st == i) throw new JSONException("bad value at " + i);
        String n = s.substring(st, i);
        if (n.contains(".") || n.contains("e") || n.contains("E")) return Double.parseDouble(n);
        long l = Long.parseLong(n);
        return l == (int) l ? (Object) (int) l : (Object) l;
    }
    void expect(char c) { if (i >= s.length() || s.charAt(i) != c) throw new JSONException("expected " + c + " at " + i); i++; }
    String str() {
        expect('"'); StringBuilder b = new StringBuilder();
        while (true) {
            char c = s.charAt(i++);
            if (c == '"') return b.toString();
            if (c == '\\') {
                char e = s.charAt(i++);
                switch (e) {
                    case 'n': b.append('\n'); break; case 't': b.append('\t'); break; case 'r': b.append('\r'); break;
                    case 'b': b.append('\b'); break; case 'f': b.append('\f'); break;
                    case 'u': b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                    default: b.append(e);
                }
            } else b.append(c);
        }
    }
    static String quote(String v) {
        StringBuilder b = new StringBuilder("\"");
        for (char c : v.toCharArray()) {
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }
    static String write(Object v) {
        if (v == null || v == JSONObject.NULL) return "null";
        if (v instanceof String) return quote((String) v);
        return v.toString();
    }
}
