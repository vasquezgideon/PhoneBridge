# Security model (v3)

## Roles

- **Chromebook:** does everything. Chrome renders and keeps cookies and site data. The PhoneBridge extension negotiates and verifies TLS (libcurl.js with Mozilla's CA bundle), speaks HTTP/1.1 and HTTP/2, caches, and decides which connections to open.
- **iPhone:** a TCP pipe. It's told "connect to host:port", then forwards bytes until either side closes.

| What | Where it's visible |
|---|---|
| HTTPS URLs, headers, cookies, bodies, passwords | Only on the Chromebook. The iPhone forwards TLS ciphertext. |
| TLS certificate checks | On the Chromebook. A bad certificate fails there; the iPhone can't vouch for or replace one. |
| Destination host:port, connection timing, byte counts | The iPhone (it has to open the connection), the network, and the destination. The same as any router. The TLS SNI also carries the hostname. |
| Plain-HTTP traffic | Readable on the wire by the iPhone and everyone downstream, as on any network. |

**The iPhone can't control the Chromebook.** The protocol only lets it:

- reply `OPENED`, `DATA` or `CLOSE` on streams the Chromebook opened;
- send `welcome`, `status` and `pong`;
- answer the benchmark.

Stray tunnel frames for unknown streams are ignored. The iPhone's settings are its own password, its display name and screen-awake.

What a malicious or compromised iPhone could still do: refuse or drop connections, delay traffic, see which hosts you connect to, and read or modify plain-HTTP traffic (any router can). It can't read or modify HTTPS without a certificate the Chromebook trusts.

## Sign-in: password-authenticated key exchange (CPace-style, X25519)

The password never crosses the air. Both sides map it to a curve point with Elligator2, do an X25519 exchange based on that point, and confirm with HMACs over the transcript (`protocol/packet-format.md` §3).

- **Passive listeners** learn nothing about the password, and the traffic is AES-256-GCM.
- **Active attackers** get one online guess per attempt. They can't brute-force a captured transcript offline.
- **Online guessing** is rate-limited: every `hello` counts until a valid proof; after 5, sign-in locks for 30 s, doubling up to 15 min.
- **Default password:** 8 random characters (~40 bits). Custom passwords must be at least 4 characters.
- **Remember** stores the derived point `G`, not the password text. `G` still signs in, so treat the Chromebook profile as holding the credential.

While the app is open, anyone in Bluetooth range with the password can use the iPhone's connection. Changing the password signs the current Chromebook out.

## Chromebook-side notes

- The extension needs `debugger`, which is effectively full control of browsing. Install builds you trust.
- Extension pages run under CSP `script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'`. They can load their own files (the WebAssembly binary) but can't reach the network. All traffic goes through Bluetooth.
- When the iPhone isn't connected, pages fail by default; using the Chromebook's own network is opt-in.

## Not covered

No DNS privacy from the iPhone: it resolves the hostnames it connects to. Encrypted DNS through the tunnel could hide those lookups, but the hostname would still be visible in TLS SNI. There's no BLE link-layer bonding (security lives at the application layer) and no per-device revocation (change the password instead).
