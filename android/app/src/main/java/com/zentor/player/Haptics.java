package com.zentor.player;

import android.content.Context;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.view.HapticFeedbackConstants;
import android.view.View;

// The feel of each thing: a short click for a tap, two rising pulses for
// switching something on, two falling ones for off, a heartbeat for Me gusta,
// a firm double knock for deleting...
final class Haptics {
    private Haptics() {}

    // {timings ms (off, on, off, on...)}, {amplitudes 0-255}
    private static long[] t(long... v) { return v; }
    private static int[] a(int... v) { return v; }

    static void play(Context ctx, View view, String kind, float power) {
        if (power <= 0) return;
        if (power > 1) power = 1;
        long[] tm; int[] am;
        switch (kind == null ? "" : kind) {
            case "tick":    tm = t(0, 6);                    am = a(0, 70); break;
            case "select":  tm = t(0, 9);                    am = a(0, 130); break;
            case "on":      tm = t(0, 9, 45, 16);            am = a(0, 90, 0, 220); break;
            case "off":     tm = t(0, 16, 45, 9);            am = a(0, 200, 0, 80); break;
            case "play":    tm = t(0, 18);                   am = a(0, 190); break;
            case "pause":   tm = t(0, 10, 35, 10);           am = a(0, 150, 0, 150); break;
            case "skip":    tm = t(0, 12);                   am = a(0, 160); break;
            case "like":    tm = t(0, 14, 70, 32);           am = a(0, 140, 0, 255); break;
            case "unlike":  tm = t(0, 12);                   am = a(0, 90); break;
            case "long":    tm = t(0, 32);                   am = a(0, 220); break;
            case "success": tm = t(0, 12, 60, 12, 60, 28);   am = a(0, 110, 0, 160, 0, 255); break;
            case "warn":    tm = t(0, 22);                   am = a(0, 230); break;
            case "delete":  tm = t(0, 26, 50, 26);           am = a(0, 255, 0, 255); break;
            case "error":   tm = t(0, 40, 40, 40, 40, 40);   am = a(0, 200, 0, 200, 0, 200); break;
            default:        tm = t(0, 11);                   am = a(0, 140); break;
        }
        try {
            Vibrator v;
            if (Build.VERSION.SDK_INT >= 31) {
                VibratorManager vm = (VibratorManager) ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                v = vm == null ? null : vm.getDefaultVibrator();
            } else v = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator() || Build.VERSION.SDK_INT < 26) throw new IllegalStateException();
            if (v.hasAmplitudeControl()) {
                int[] sc = new int[am.length];
                for (int i = 0; i < am.length; i++) sc[i] = am[i] == 0 ? 0 : Math.max(1, Math.min(255, Math.round(am[i] * power)));
                v.vibrate(VibrationEffect.createWaveform(tm, sc, -1));
            } else {
                // no strength control: weaker = shorter
                long[] st = tm.clone();
                for (int i = 1; i < st.length; i += 2) st[i] = Math.max(4, Math.round(st[i] * (0.4f + 0.6f * power)));
                v.vibrate(VibrationEffect.createWaveform(st, -1));
            }
        } catch (Exception e) {
            if (view != null) view.performHapticFeedback("long".equals(kind) || "delete".equals(kind)
                    ? HapticFeedbackConstants.LONG_PRESS : HapticFeedbackConstants.KEYBOARD_TAP);
        }
    }
}
