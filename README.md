# PhoneBridge

Browse on a Chromebook using an iPhone's internet connection, over Bluetooth LE only.

Everything except moving bytes happens on the Chromebook. Chrome renders, at full resolution, with its own tabs, bookmarks, extensions and devtools. The PhoneBridge extension speaks TLS and HTTP itself (libcurl compiled to WebAssembly). The iPhone is a TCP pipe: it opens the connections the Chromebook asks for and forwards encrypted bytes. It can't see the pages you visit and can't control anything.

```
Chromebook                                                        iPhone
Chrome tabs ── every request (chrome.debugger) ──▶ extension       PhoneBridge app
               cache · tracker block · libcurl.js (TLS + HTTP/2)    TCP pipe: host:port ⇄ bytes
                          │ TCP streams, AES-GCM over BLE ──────────▶ │ ──▶ internet (cellular / Wi-Fi)
```

No pairing step: while the app is open, the iPhone accepts any Chromebook that knows its password. You type it once in the extension and tick Remember. After that it connects on its own, and reconnects whenever the link drops.

## What the iPhone can and can't see

| | iPhone |
|---|---|
| HTTPS page content, URLs, cookies, form data, passwords | **No.** TLS is negotiated and verified on the Chromebook; the iPhone forwards ciphertext. |
| Which hosts the Chromebook connects to (`host:port`) and how many bytes | Yes. It has to open the TCP connections. The dashboard shows only connection and byte counts. |
| Plain `http://` sites | On the wire, like any router or Wi-Fi hotspot would. Prefer HTTPS. |
| Controls over the Chromebook | **None.** The protocol has no message for it. The iPhone's only knobs are its own password, name and screen-awake setting. |

## Status

v0.3. **Not yet run on real hardware.** Here's what has actually been checked:

- **Packaged extension, end to end.** It runs in headless Chrome with Chrome's own network blackholed; the mock iPhone (in Node) is a real TCP pipe to local servers. It passes 23 checks, among them:
  - pages rendered, gzip decoded on the Chromebook, `Set-Cookie`/`HttpOnly`, cross-origin iframes;
  - cache hits on reload, POST, redirects, tracker blocking, DNS errors explained, reconnect, password change;
  - a self-signed HTTPS site rejected by the Chromebook, with the iPhone having seen only a TLS ClientHello and no plaintext.
- **CI** also loads `https://example.com` over the real internet the same way.
- **Protocol and crypto** are checked by JS, Swift and an independent Python implementation.
- **The iOS app has only been compiled by CI.**

Still missing:

- **WebSockets don't pass through yet.** libcurl.js supports them; the Chrome-side plumbing isn't done.
- **No HTTP/3 (QUIC).** HTTP/2 over TLS is used instead, which every major site supports.
- **Video won't stream.** BLE is ~0.1–1 Mbit/s.
- **Expect slow first loads.** A 3 MB page takes roughly 30–60 s cold; reloads are much faster.
- **Some requests stay off the relay.** Downloads started from Chrome's download manager and requests made by sites' service workers aren't routed.

## Build

GitHub Actions on every push:

| Job | Output |
|---|---|
| Chromebook extension (ubuntu) | unit tests, Python vector check, package, E2E including real-internet HTTPS → **`PhoneBridge-extension.zip`** |
| Swift core (macos-15) | field arithmetic, PAKE handshake, vectors, tunnel frames |
| iOS app (macos-15) | XcodeGen → unsigned build → **`PhoneBridge-unsigned.ipa`** |
| Release (`v*` tag) | both attached to a GitHub Release |

Locally:

```sh
cd chromebook && npm ci
npm test                         # 25 tests
python3 ../protocol/xcheck.py    # pip install cryptography
npm run build                    # vendors libcurl.js (one documented patch) → dist/PhoneBridge-extension.zip
npm run test:e2e                 # needs Chrome; PB_REAL_NET=1 adds the real-internet HTTPS check

swift test --package-path ios/PhoneBridgeCore
brew install xcodegen && xcodegen generate --spec ios/project.yml
```

## Install

**iPhone.** Sideload `PhoneBridge-unsigned.ipa` (SideStore / AltStore / Xcode). Open it and allow Bluetooth. Tap the eye icon to see the generated password (e.g. `k7mq-3xph`), or change it.

**Chromebook.**

1. Unzip `PhoneBridge-extension.zip`.
2. Go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the folder.
3. In the pinned **PhoneBridge** tab, enter the password, click **Sign in**, and choose *PhoneBridge* in Chrome's Bluetooth picker.
4. Browse normally.

Chrome shows *PhoneBridge started debugging this browser*. That's the `chrome.debugger` permission the routing depends on.

**Keep both ends open.** The PhoneBridge app has to stay in the foreground on the iPhone, and the PhoneBridge tab has to stay open on the Chromebook. Managed Chromebooks may block developer-mode extensions.

## Repository

```
ios/
  PhoneBridgeCore/     SwiftPM: field math + Elligator2, PAKE handshake, wire + tunnel frames, tests
  App/                 dashboard (status, password, byte counts), AppModel
  Bluetooth/           GATT server
  Tunnel/              NWConnection TCP pipe
  Security/ Settings/
chromebook/
  extension/           MV3 extension: link page, interceptor, cache, tunnel, fetcher; vendor/ = libcurl.js (generated)
  tests/               node tests, mock iPhone, headless E2E
  tools/               vendor (libcurl.js + patch), packager, vector generator
protocol/              packet-format.md (v3), test vectors, xcheck.py
docs/                  SECURITY, TESTING, ROADMAP (original plan)
```

## Third-party code

[libcurl.js](https://github.com/ading2210/libcurl.js) 0.7.5 (LGPL-3.0-or-later): curl, mbedTLS, nghttp2, brotli and Mozilla's CA bundle, compiled to WebAssembly. It's copied into the extension at build time by `tools/vendor.mjs`, which changes one line: responses with null-body statuses (304) hung upstream. The license and a note ship inside the extension in `vendor/`.

## History

[`docs/ROADMAP.md`](docs/ROADMAP.md) planned the iPhone as the browser and the Chromebook as a display (v0.1). v0.2 moved rendering to the Chromebook. v0.3 moved TLS and HTTP there too, leaving the iPhone as a pure network pipe.
