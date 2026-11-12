# PhoneBridge wire protocol — v3

v3 makes the iPhone a **TCP pipe**. Chrome on the Chromebook renders; the PhoneBridge extension
runs TLS and HTTP itself (libcurl.js: curl + mbedTLS in WebAssembly, Mozilla CA bundle) and asks
the iPhone only to open TCP connections and move bytes. For HTTPS the iPhone sees host:port and
ciphertext, nothing else. Nothing in the protocol lets the iPhone steer the Chromebook.

Implemented in `ios/PhoneBridgeCore` (Swift) and `chromebook/extension/src` (JS).
`protocol/test-vectors/handshake-v2.json` pins the crypto and the tunnel frames (the handshake is
unchanged since v2); the JS tests, the Swift tests and `protocol/xcheck.py` all check it.

## 1. GATT

| Item | UUID | Properties |
|---|---|---|
| Service | `6e5a0001-8f3c-4b7e-9a21-3d5c7b1e0a01` | primary |
| RX (Chromebook → iPhone) | `6e5a0002-8f3c-4b7e-9a21-3d5c7b1e0a01` | write, write-without-response |
| TX (iPhone → Chromebook) | `6e5a0003-8f3c-4b7e-9a21-3d5c7b1e0a01` | notify |

## 2. Stream framing

`u32 BE length | payload` frames (≤ 4 MiB) over the BLE byte stream. `payload[0]`: `0x01`
handshake (UTF-8 JSON) · `0x02` secure (`u64 BE counter ‖ AES-256-GCM ciphertext ‖ tag`).

## 3. Handshake — CPace-style password PAKE over X25519

```
G      = Elligator2( SHA256("PB2-cpace-generator" ‖ NFC(password)), bit 255 cleared, LE int mod p )   (RFC 9380 §6.7.1, Z = 2)
Ya     = X25519(ya, G)    Yb = X25519(yb, G)    K = X25519(ya, Yb) = X25519(yb, Ya)   (zero → abort)
T      = "PB2" ‖ device(16) ‖ Ya ‖ Yb ‖ Na(16) ‖ Nb(16)
okm    = HKDF-SHA256(K, salt "", info "PB2-keys" ‖ T, 128) → confirmP | confirmC | k_c2p | k_p2c
macP   = HMAC(confirmP, "P" ‖ T)    macC = HMAC(confirmC, "C" ‖ T)

C → P  {"t":"hello","v":3,"device","name","pk":Ya,"n":Na}
P → C  {"t":"challenge","pk":Yb,"n":Nb,"mac":macP,"phone"}     C checks macP (else wrong password)
C → P  {"t":"proof","mac":macC}                                P checks macC
P → C  {"t":"ok"}
```

Errors `{"t":"error","code","msg","lockoutSeconds"?}`: `wrong_password`, `locked_out`, `bad_message`,
`password_changed`, `session_reset`, `bad_frame`. Every `hello` counts as an attempt until a
valid proof; after 5, sign-in locks 30 s, then one attempt, then 60 s, 120 s … (max 15 min).

## 4. Secure channel

AES-256-GCM; C sends with `k_c2p`, P with `k_p2c`; nonce `00000000 ‖ u64 BE counter`; AAD `PB2`;
strictly sequential counters. Plaintext `pt[0]`: `0x01` control JSON · `0x03` benchmark ·
`0x04` tunnel frame.

### Tunnel frame (`0x04`)

```
0x04 | u8 op | u32 BE stream | payload
```

| op | Direction | Payload |
|---|---|---|
| `0x01` CONNECT | C → P | `u16 BE port ‖ UTF-8 host` (TCP) |
| `0x02` OPENED | P → C | — |
| `0x03` DATA | both | raw bytes (≤ 16 KB per frame) |
| `0x04` CLOSE | both | `u8 reason`: 0 normal · 1 reset · 2 refused · 3 dns · 4 timeout · 5 unreachable · 6 limit · 7 bad request |

Stream ids are chosen by the Chromebook. The iPhone resolves the host (DNS), connects within
20 s, and reports failures with a reason so the Chromebook can explain them.

**Early data** (iPhone advertises `"early-data"` in `welcome.features`): the Chromebook may send
DATA right after CONNECT without waiting for OPENED. The iPhone holds up to 256 KB per connection
until the TCP connection is up, then writes it in order; if the connect fails, the held bytes are
dropped and CLOSE carries the reason. This removes one Bluetooth round trip from every new
connection. Without the feature the Chromebook waits for OPENED, as in v3.0.

**Sending order on the iPhone** (an implementation rule, not wire format, but it decides latency):
encrypted frames can't be reordered, so the iPhone chooses what to seal next only when its radio
queue is nearly empty (~6 notifications). Control messages go first, then OPENED/CLOSE (a CLOSE
never overtakes its own connection's data), then DATA from the connection that has sent the fewest
bytes recently (decaying by half per second), in frames of at most 2 KB. It reads at most 64 KB
ahead per connection; beyond that TCP's own window holds the server back.

### Remote view frame (`0x05`, P → C) — "iPhone renders" mode

```
0x05 | u8 kind | u32 BE seq | u16 BE x | u16 BE y | u16 BE w | u16 BE h | data
```

kind `0x01` TILE: `data` is a JPEG of the rectangle (x, y, w, h) of picture `seq`. kind `0x02` END: picture
`seq` is complete and is (w × h) pixels; the Chromebook draws its tiles, then acks with
`{t:'rv_ack', seq}`. The iPhone has at most one picture in flight. Only offered when `welcome.features`
contains `"remote-view"`, and only used after the Chromebook sends `rv_start`.

## 5. Control messages

| Direction | `t` | Fields |
|---|---|---|
| C → P | `ping` | `id` |
| C → P | `bench` / `bench_done` | `dir`, `bytes` |
| P → C | `welcome` | `phone, proto`, optional `features` (array; `"early-data"`) and `mtu` (bytes per notification, so the Chromebook writes full-size packets) |
| P → C | `status` | `battery, charging, thermal, network`, optional `mtu` |
| P → C | `pong` | `id` |
| C → P | `rv_start` / `rv_resize` | `w, h` (CSS px), optional `url` — iPhone renders at this size |
| C → P | `rv_nav` / `rv_back` / `rv_forward` / `rv_reload` / `rv_halt` / `rv_stop` | `url` for `rv_nav` |
| C → P | `rv_input` | `e`: `click`/`down`/`up`/`move` (`x, y`), `wheel` (`dx, dy, x, y`), `text` (`text`), `key` (`key, code, ctrl, alt, shift, meta`) |
| C → P | `rv_ack` | `seq` |
| P → C | `rv_state` | `url, title, loading, canBack, canForward, progress` |
| P → C | `bench_start` / `bench_end` / `bench_result` | benchmark |

There are no messages by which the iPhone could navigate, open tabs, inject content or change
Chromebook settings. In "iPhone renders" mode the direction is the same: the Chromebook drives the
iPhone's web view; the iPhone only reports state and sends pictures.
