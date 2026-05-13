/**
 * KEK-Provider-Interface.
 *
 * Two-Layer-Envelope-Encryption:
 *   Step 1 (DEK):  random 32-byte key, AES-GCM encrypts the payload.
 *   Step 2 (KEK):  wraps the DEK. KEK lives in OpenBao Transit (prod)
 *                  oder local Master-Key + HKDF (dev/tests).
 *
 * `KekRef` ist eine String-URI die den KEK eindeutig identifiziert.
 * Konvention:
 *   - `local://user-<userId>`        — LocalKekProvider, HKDF-derived
 *   - `vault://transit/keys/user-<userId>` — OpenBao Transit-Engine
 *
 * GDPR-Crypto-Shredding: `destroyKey(ref)` macht alle Daten die mit
 * diesem ref-gewrappten DEK encrypted sind, unrecoverable. EDPB-konform
 * fuer Art. 17 Erasure.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §5.
 */

export type KekRef = string;

export interface KekProvider {
  /**
   * Wrappt einen DEK mit dem KEK identifiziert durch `ref`.
   *
   * Output ist opaker Ciphertext (Format-Detail des Provider) — Caller
   * speichert ihn als `credentials.wrapped_dek` BLOB. Bei OpenBao ist
   * das eine `vault:v1:<base64>`-String; bei Local ein
   * `<nonce(12)>||<aes-gcm-ciphertext>`-Buffer.
   */
  wrap(dek: Uint8Array, ref: KekRef): Promise<Uint8Array>;

  /**
   * Unwrap inverse. Wirft, wenn:
   *   - ref existiert nicht (z.B. nach destroyKey)
   *   - wrapped wurde mit einem anderen ref erstellt
   *   - Provider-spezifischer Auth-Fehler
   */
  unwrap(wrapped: Uint8Array, ref: KekRef): Promise<Uint8Array>;

  /**
   * Re-wrap: dekryptiert mit `oldRef` und wrappt mit `newRef`. Wird vom
   * Caller batch-mode pro `credentials`-Row gerufen, wenn Key-Rotation
   * laeuft.
   *
   * Note: viele Provider rotieren Keys intern (z.B. OpenBao `rotate`
   * inkrementiert Version aber alter Ciphertext bleibt entschluesselbar).
   * `rotate()` ist nur fuer den Fall, dass das ref selbst wechselt.
   */
  rotate(oldRef: KekRef, newRef: KekRef): Promise<void>;

  /**
   * Crypto-Shred: zerstoert den KEK. Alle Daten encrypted mit diesem
   * ref werden permanent unrecoverable.
   *
   * EDPB-konform fuer GDPR-Art-17-Erasure.
   */
  destroyKey(ref: KekRef): Promise<void>;
}
