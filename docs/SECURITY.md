# Security model

## What each side holds

| | iPhone | Chromebook |
|---|---|---|
| Website cookies, storage, passwords, tokens | ✔ (WKWebsiteDataStore) | never |
| Trust key per paired Chromebook | Keychain, this-device-only | IndexedDB, non-extractable `CryptoKey` (localStorage fallback, flagged in UI) |
| Unlock password | salted PBKDF2-SHA256 verifier (210k iterations), Keychain | never stored |
| Session keys | memory only, fresh per connection | memory only |

## Pairing (new Chromebook)

1. Pairing is accepted only while the iPhone's **Pair new Chromebook** window is open: 2 minutes, closed after 3 failed attempts.
2. Ephemeral P-256 ECDH. The iPhone sends a hash commitment to its nonce *before* it sees the Chromebook's nonce, then reveals it.
3. Both sides derive the same 6-digit code from the full transcript. The user types the iPhone's code on the Chromebook (3 typo attempts). A man-in-the-middle can't choose a nonce that makes the codes match: it gets one blind 1-in-10⁶ guess per attempt, and no offline brute force.
4. The iPhone needs an explicit **Approve** tap *and* a valid key-confirmation MAC from the Chromebook. Both sides confirm with HMACs over the transcript.
5. A 32-byte trust key, derived from the shared secret and transcript, is stored on both sides.

The weak point is the human step. If the Chromebook says the code doesn't match, the iPhone's prompt must be rejected, and the prompt says so.

## Reconnecting (trusted Chromebook)

Fresh ephemeral ECDH each time (forward secrecy). The iPhone proves it holds the trust key first, then the Chromebook does. The trust key is mixed into the session-key salt, so an attacker without it can't derive the keys even after completing ECDH.

## Persistent password (optional)

- Set, changed or removed from either the iPhone or a connected, unlocked Chromebook. Changing or removing it from a Chromebook requires the current password.
- When a password is set, a reconnecting Chromebook stays locked until it sends the password over the encrypted channel. While locked, the iPhone ignores every message except `auth_password` (and `ping`), and streams nothing.
- **Remember this Chromebook** skips the prompt on later reconnects. **Require on every reconnect** overrides that. Changing the password clears every remembered device except the one that made the change.
- Brute force: 5 free attempts, then lockouts of 30 s, 60 s, 120 s … capped at 15 min.
- A newly paired Chromebook isn't asked for the password: the on-phone approval is stronger evidence.

## Transport

AES-256-GCM, a separate key per direction, a 96-bit nonce built from a 64-bit counter, and AAD `PB1`. The receiver requires the exact next counter, so replay, reordering or a dropped frame kills the session; the Chromebook then reconnects over a fresh BLE link.

## Network isolation

The built `PhoneBridge.html` carries `default-src 'none'; connect-src 'none'`. It can't make network requests, and it never receives URLs to fetch, only rendered pixels and page metadata. The E2E test runs the built file.

## Not covered (yet)

- BLE link-layer pairing and bonding isn't used. Security lives at the application layer, so OS-level BLE encryption is irrelevant to confidentiality, but the BLE link itself is visible to nearby sniffers as ciphertext.
- No biometric confirmation, no security event log (roadmap: Later).
- Anyone holding the unlocked iPhone controls PhoneBridge. The phone is the root of trust.
