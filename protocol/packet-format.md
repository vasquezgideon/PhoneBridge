# PhoneBridge wire protocol — v1

Everything here is implemented twice: `ios/PhoneBridgeCore` (Swift) and
`chromebook/src` (JS). `protocol/test-vectors/handshake-v1.json` pins the
crypto; both test suites check against it.

## 1. GATT

| Item | UUID | Properties |
|---|---|---|
| Service | `6e5a0001-8f3c-4b7e-9a21-3d5c7b1e0a01` | primary |
| RX (Chromebook → iPhone) | `6e5a0002-8f3c-4b7e-9a21-3d5c7b1e0a01` | write, write-without-response |
| TX (iPhone → Chromebook) | `6e5a0003-8f3c-4b7e-9a21-3d5c7b1e0a01` | notify |

The iPhone is the peripheral and advertises the service UUID with local name
`PhoneBridge`. The Chromebook subscribes to TX **before** writing to RX. One
client at a time; a new subscriber replaces the old one.

## 2. Stream framing

Both characteristics carry a byte stream, chopped into packets of any size
(iPhone: `maximumUpdateValueLength`; Chromebook: configurable, default 180 B,
halved on write errors). The stream is a sequence of frames:

```
u32 BE length | payload[length]        (length ≤ 4 MiB)
```

`payload[0]` is the outer type:

| Byte | Meaning | Rest of payload |
|---|---|---|
| `0x01` | Handshake | UTF-8 JSON |
| `0x02` | Secure | `u64 BE counter` ‖ AES-256-GCM ciphertext ‖ 16-byte tag |

## 3. Handshake

Notation: `‖` concatenation, `pkX` = 65-byte uncompressed P-256 point,
`N` = 16 random bytes, `device` = 16-byte Chromebook ID (random, persistent).
All binary JSON fields are standard base64.

```
T_pair   = "PB-pair-v1"   ‖ device ‖ pkA ‖ pkB ‖ Na ‖ Nb
T_resume = "PB-resume-v1" ‖ device ‖ pkA ‖ pkB ‖ Na ‖ Nb
shared   = ECDH-P256(x coordinate, 32 bytes)
commit   = SHA256("PB-commit-v1" ‖ device ‖ pkA ‖ pkB ‖ Nb)
SAS      = (first 4 bytes of SHA256("PB-sas-v1" ‖ T) as u32 BE) mod 1 000 000, 6 digits
trust    = HKDF-SHA256(ikm=shared, salt="", info="PB-trust-v1" ‖ T, 32)         [pairing only]
salt     = HMAC-SHA256(trust, "PB-salt-v1" ‖ Na ‖ Nb)
okm      = HKDF-SHA256(ikm=shared, salt, info="PB-session-v1" ‖ T, 64)
k_c2p    = okm[0..32]     k_p2c = okm[32..64]
macC     = HMAC-SHA256(trust, "PB-confirm-C" ‖ T)
macP     = HMAC-SHA256(trust, "PB-confirm-P" ‖ T)
```

### Pairing (new device) — commitment + 6-digit code

```
C → P  {"t":"pair_hello","v":1,"device","name","pk":pkA}
P → C  {"t":"pair_commit","pk":pkB,"commit","phone":<host name>}
C → P  {"t":"pair_nonce","n":Na}
P → C  {"t":"pair_reveal","n":Nb}          P shows SAS + Approve/Reject
C: verify commit; user types the code shown on the iPhone; must equal SAS
C → P  {"t":"pair_confirm","mac":macC}
P: waits for the Approve tap AND a valid macC
P → C  {"t":"pair_ok","mac":macP,"phoneId"}
```

The iPhone commits to `Nb` before it sees `Na`, so a man-in-the-middle gets
one 1-in-10⁶ guess per attempt rather than an offline brute force. Pairing is
only accepted while the iPhone's "Pair new Chromebook" window is open (2 min,
3 failed attempts closes it).

### Resume (trusted device)

```
C → P  {"t":"resume_hello","v":1,"device","pk":pkA_eph,"n":Na}
P → C  {"t":"resume_challenge","pk":pkB_eph,"n":Nb,"mac":macP}
C → P  {"t":"resume_proof","mac":macC}
P → C  {"t":"resume_ok"}
```

Fresh ephemeral keys every connection (forward secrecy); `trust` is mixed
into the session salt, so an attacker without it cannot derive keys.

Errors, either direction: `{"t":"error","code","msg"}`. Codes:
`pairing_closed`, `unknown_device`, `rejected`, `bad_confirm`, `bad_proof`,
`bad_message`, `code_mismatch`, `commit_mismatch`.

## 4. Secure channel

* Keys: C uses `k_c2p` to send, `k_p2c` to receive; P the reverse.
* Nonce: `00 00 00 00 ‖ u64 BE counter`. Counters start at 0 per direction.
* AAD: ASCII `PB1`.
* The receiver requires `counter == expected` (BLE GATT is ordered) — replays
  and drops kill the session.

Decrypted plaintext, `pt[0]` = inner type:

| Byte | Meaning |
|---|---|
| `0x01` | Control — UTF-8 JSON object with field `t` |
| `0x02` | Display tile (below) |
| `0x03` | Benchmark filler bytes |

### Display tile (`0x02`)

```
0x02 | u32 frameId | u16 fullW | u16 fullH | u16 x | u16 y | u16 w | u16 h | u8 flags | JPEG
flags: bit0 = last tile of frame, bit1 = keyframe
```

The client sizes its canvas to `fullW×fullH` and draws each JPEG at `(x,y)`.

## 5. Control messages

Phone → Chromebook

| `t` | Fields |
|---|---|
| `welcome` | `phone, phoneId, locked, passwordSet, proto` |
| `auth_required` | `lockoutSeconds` |
| `auth_result` | `ok, error?, lockoutSeconds?` |
| `state` | `url, title, canGoBack, canGoForward, loading, progress` |
| `status` | `battery (0–1, −1 unknown), charging, thermal, network` |
| `security` | `passwordSet, requireEvery, devices:[{id,name,pairedAt,lastSeen,remembered,current}]` |
| `display` | current display settings (echo after apply) |
| `bench_start` / `bench_end` | `bytes` (phone → Chromebook test) |
| `bench_result` | `dir, bytes, ms` (Chromebook → phone test) |
| `pong` | `id` |
| `revoked` | — (this Chromebook was removed; forget trust) |
| `notice` | `level, msg` |

Chromebook → Phone (all ignored except `auth_password` while locked)

| `t` | Fields |
|---|---|
| `auth_password` | `password, remember` |
| `navigate` | `url` (URL or search text) |
| `nav` | `action`: back / forward / reload / stop / home |
| `ptr` | `a`: down / up / move, `x, y` (0–1 normalised), `b` button |
| `wheel` | `x, y, dx, dy` (CSS px) |
| `text` | `s` |
| `key` | `key, ctrl, alt, shift, meta` |
| `display` | any of `quality, scale, fps, grayscale, tiles` |
| `browser_prefs` | `homepage, search` (`%s` = query) |
| `stream` | `on` |
| `refresh` | — (force keyframe) |
| `get_security` | — |
| `set_password` | `current?, password` |
| `remove_password` | `current` |
| `set_require_every` | `value` |
| `revoke` | `id` |
| `bench` | `dir`: p2c / c2p, `bytes` |
| `bench_done` | `bytes` |
| `ping` | `id` |
