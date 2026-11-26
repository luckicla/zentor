package com.zentor.player;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.nio.ByteBuffer;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Encrypts the Google token (GoogleAccount) with AES-GCM and a key that lives
 * in the Android Keystore: the key never leaves the system (on most phones,
 * the secure hardware), so a copy of the app's files (a backup, a rooted
 * phone's dump) is useless without this phone.
 *
 * If the key goes missing (app data restored on another phone, the Keystore
 * reset after changing the lock screen on some models…) open() fails and
 * GoogleAccount signs out cleanly: the user just connects again.
 *
 * Format: 1 byte version (1) · 1 byte IV length · IV · ciphertext+tag.
 */
final class KeystoreProtector implements GoogleAccount.Protector {
    private static final String STORE = "AndroidKeyStore";
    private static final String ALIAS = "mixup-google-token";

    private static SecretKey key(boolean create) throws Exception {
        KeyStore ks = KeyStore.getInstance(STORE);
        ks.load(null);
        KeyStore.Entry e = ks.getEntry(ALIAS, null);
        if (e instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) e).getSecretKey();
        if (!create) throw new IllegalStateException("no key");
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE);
        g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return g.generateKey();
    }

    @Override public byte[] seal(byte[] plain) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key(true)); // (the Keystore picks a fresh IV)
        byte[] iv = c.getIV(), ct = c.doFinal(plain);
        return ByteBuffer.allocate(2 + iv.length + ct.length).put((byte) 1).put((byte) iv.length).put(iv).put(ct).array();
    }

    @Override public byte[] open(byte[] sealed) throws Exception {
        if (sealed.length < 2 || sealed[0] != 1) throw new IllegalArgumentException("unknown format");
        int n = sealed[1] & 0xff;
        if (sealed.length < 2 + n + 16) throw new IllegalArgumentException("too short");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, sealed, 2, n));
        return c.doFinal(sealed, 2 + n, sealed.length - 2 - n);
    }

    @Override public void forget() {
        try {
            KeyStore ks = KeyStore.getInstance(STORE);
            ks.load(null);
            ks.deleteEntry(ALIAS);
        } catch (Exception ignored) {}
    }
}
