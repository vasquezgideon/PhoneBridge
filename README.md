# PhoneBridge

Browse on a Chromebook using an iPhone's internet connection, over Bluetooth LE only.

Everything except moving bytes happens on the Chromebook. Chrome renders, at full resolution, with its own tabs, bookmarks, extensions and devtools. The PhoneBridge extension speaks TLS and HTTP itself (libcurl compiled to WebAssembly). The iPhone is a TCP pipe: it opens the connections the Chromebook asks for and forwards encrypted bytes. It can't see the pages you visit and can't control anything.

```
Chromebook                                                        iPhone
Chrome tabs ── every request (chrome.debugger) ──▶ extension       PhoneBridge app
               cache · tracker block · libcurl.js (TLS + HTTP/2)    TCP pipe: host:port ⇄ bytes
                          │ TCP streams, AES-GCM over BLE ──────────▶ │ ──▶ internet (cellular / Wi-Fi)
```

**Can't install extensions?** (managed Chromebook, developer mode blocked) Use **`PhoneBridge.html`** instead: one self-contained file, nothing to install. It is its own small browser: an address bar on top, the site drawn below. Same iPhone app, same password, same encryption. See [Single-file version](#single-file-version-phonebridgehtml) for what it can and can't do.

No pairing step: while the app is open, the iPhone accepts any Chromebook that knows its password. You type it once in the extension and tick Remember. After that it connects on its own, and reconnects whenever the link drops.

## What the iPhone can and can't see

| | iPhone |
|---|---|
| HTTPS page content, URLs, cookies, form data, passwords | **No.** TLS is negotiated and verified on the Chromebook; the iPhone forwards ciphertext. |
| Which hosts the Chromebook connects to (`host:port`) and how many bytes | Yes. It has to open the TCP connections. The dashboard shows only connection and byte counts. |
| Plain `http://` sites | On the wire, like any router or Wi-Fi hotspot would. Prefer HTTPS. |
| Controls over the Chromebook | **None.** The protocol has no message for it. The iPhone's only knobs are its own password, name and screen-awake setting. |

## Status

v0.5. **Not yet run on real hardware.** Here's what has actually been checked:

- **Packaged extension, end to end.** It runs in headless Chrome with Chrome's own network blackholed; the mock iPhone (in Node) is a real TCP pipe to local servers. It passes 23 checks, among them:
  - pages rendered, gzip decoded on the Chromebook, `Set-Cookie`/`HttpOnly`, cross-origin iframes;
  - cache hits on reload, POST, redirects, tracker blocking, DNS errors explained, reconnect, password change;
  - a self-signed HTTPS site rejected by the Chromebook, with the iPhone having seen only a TLS ClientHello and no plaintext.
- **`PhoneBridge.html`, end to end.** Opened from `file://` in the same setup; 39 checks, including CSS/`@import`, script order, lazy images, cookies (`HttpOnly` hidden from scripts), `fetch`/XHR, CORS blocking, `localStorage`, forms, redirects, Back, certificate rejection.
- **CI** also loads `https://registry.npmjs.org` over the real internet with both.
- **Protocol and crypto** are checked by JS, Swift and an independent Python implementation.
- **The iOS app has only been compiled by CI.**

Still missing:

- **WebSockets don't pass through yet.** libcurl.js supports them; the Chrome-side plumbing isn't done.
- **No HTTP/3 (QUIC).** HTTP/2 over TLS is used instead, which every major site supports.
- **Video won't stream.** BLE is ~0.1–1 Mbit/s (see [Speed](#speed)).
- **Expect slow first loads.** A 3 MB page takes roughly 30–60 s cold; reloads are much faster.
- **Some requests stay off the relay.** Downloads started from Chrome's download manager and requests made by sites' service workers aren't routed.

## Speed

Bluetooth LE between an iPhone and a web page has a hard ceiling. iOS honours connection intervals down to about 15 ms, the Chromebook picks the interval, and an iPhone acting as a peripheral typically moves a few hundred kbit/s at best (roughly 20–60 KB/s of page data in practice). The best case is about 30–50 ms per round trip. So PhoneBridge tries to waste as few round trips as possible and to keep small messages from waiting behind big ones:

- **No queue-jumping delays.** The iPhone seals and queues only ~6 packets at a time and picks what goes next: control messages, then connection opens/closes, then the connection that has sent least recently, in frames of at most 2 KB. On an emulated 30 ms / 24 KB/s link, during a 600 KB download, a ping went from ~0.7 s (the v0.4 sender) to ~0.16 s, and opening a new connection plus two round trips went from ~2.2 s to ~0.5 s, at the same download speed (`tests/latency.test.mjs`).
- **One round trip less per connection** ("early data"): the TLS handshake leaves right behind the connect request instead of waiting for the iPhone to confirm it.
- **Short connection interval requested** by the iPhone (`setDesiredConnectionLatency(.low)`). The Chromebook may or may not grant it.
- **Full-size Bluetooth writes.** The iPhone reports the negotiated packet size; the Chromebook packs frames into packets of that size instead of 180 B.
- **No timer polling in the TLS engine.** libcurl.js ran curl on a `setInterval(0)` loop (≥4 ms per step, ~1 s per step in a background tab, such as the extension's pinned tab). curl now runs the moment bytes arrive.
- **Fewer redirects.** Permanent redirects are cached, and the HTML version remembers HSTS hosts, so `http://` links go straight to `https://`.

Turning sound into a modem over Bluetooth audio (headset/microphone profiles) isn't a way out. iOS can't act as a Bluetooth headset or audio sink for another device, Bluetooth audio codecs are lossy, and data-over-audio modems reach hundreds of bit/s to ~1 kbit/s, thousands of times slower than BLE. The real step up is a cable (USB 2.0 is ~1000× BLE). A USB link to the iPhone app over Apple's usbmux protocol from WebUSB is possible in principle (see webmuxd) but isn't built or verified here.

## Build

GitHub Actions on every push:

| Job | Output |
|---|---|
| Chromebook (ubuntu) | unit tests, Python vector check, package, both E2E suites incl. real-internet HTTPS → **`PhoneBridge-extension.zip`**, **`PhoneBridge.html`** |
| Hosted page (default branch) | publishes the same page to GitHub Pages, once Pages is enabled (Settings → Pages → Source: GitHub Actions) |
| Swift core (macos-15) | field arithmetic, PAKE handshake, vectors, tunnel frames |
| iOS app (macos-15) | XcodeGen → unsigned build → **`PhoneBridge-unsigned.ipa`** |
| Release (`v*` tag) | all three attached to a GitHub Release |

Locally:

```sh
cd chromebook && npm ci
npm test                         # 36 tests, incl. latency on an emulated BLE link
python3 ../protocol/xcheck.py    # pip install cryptography
npm run build                    # → dist/PhoneBridge-extension.zip, dist/PhoneBridge.html, dist/pages/
npm run build:page               # just PhoneBridge.html (inlines page/ + libcurl.js with its WebAssembly)
npm run test:e2e                 # extension; needs Chrome. PB_REAL_NET=1 adds the real-internet HTTPS check
npm run test:page                # PhoneBridge.html

swift test --package-path ios/PhoneBridgeCore
brew install xcodegen && xcodegen generate --spec ios/project.yml
```

## Install

**iPhone.** Sideload `PhoneBridge-unsigned.ipa` (SideStore / AltStore / Xcode). Open it and allow Bluetooth. Tap the eye icon to see the generated password (e.g. `k7mq-3xph`), or change it.

**Chromebook, extension** (full fidelity: real Chrome tabs).

1. Unzip `PhoneBridge-extension.zip`.
2. Go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the folder.
3. In the pinned **PhoneBridge** tab, enter the password, click **Sign in**, and choose *PhoneBridge* in Chrome's Bluetooth picker.
4. Browse normally.

Chrome shows *PhoneBridge started debugging this browser*. That's the `chrome.debugger` permission the routing depends on.

**Chromebook, no extension.** Download `PhoneBridge.html` (Actions artifact or Release), open it from the Files app (it opens in Chrome), enter the password, click **Sign in**, pick *PhoneBridge* in the Bluetooth picker, then type an address in its address bar. If Chrome refuses Bluetooth to a file, open the hosted copy instead (below).

**Keep both ends open.** The PhoneBridge app has to stay in the foreground on the iPhone, and the PhoneBridge tab has to stay open on the Chromebook.

## Single-file version (`PhoneBridge.html`)

A web page can't route Chrome's own tabs (that needs an extension), so `PhoneBridge.html` is a browser inside a tab. It fetches each page over the iPhone tunnel, decrypts it on the Chromebook, inlines its stylesheets and scripts, and renders it in a sandboxed frame whose Content-Security-Policy blocks every direct network request. A small runtime inside that frame routes what the page asks for later (images as they scroll into view, CSS backgrounds and fonts actually used, `fetch`/`XMLHttpRequest`, forms, links) back through the tunnel. Cookies, each site's `localStorage` and the HTTP cache live in the page's own storage.

Works well: articles, docs, Wikipedia, search (bare words search DuckDuckGo's HTML edition), forums, most server-rendered sites, forms and logins on them.

Works poorly or not at all, and why:
- **Single-page apps** (Gmail, YouTube, X, most dashboards). Their scripts read `window.location`, which inside the frame isn't the site's address and can't be faked; many also need IndexedDB, service workers or WebSockets, which an opaque sandboxed frame doesn't have.
- **A script that changes `location` directly** leaves the sandbox; PhoneBridge shows a notice instead of an unrouted page. Ordinary links and forms are fine.
- **Embedded frames** (video players, maps, embedded posts) show a placeholder.
- No ES-module imports between files, no Web Workers, no WebSockets, no synchronous XHR.

Security model: the frame has an opaque origin, so a site's scripts can't touch PhoneBridge's window, password or tunnel. Cross-origin `fetch`/XHR from a page is held to CORS (with preflights), and a site never gets another site's cookies.

**Bluetooth on `file://`.** Chrome treats a `file://` page as a secure context, which Web Bluetooth requires, but whether a given Chrome build lets a file use Bluetooth isn't something CI can check (headless Linux Chrome has no Bluetooth). If Connect reports that Web Bluetooth isn't available, use the **hosted copy**: enable Pages once (repo Settings → Pages → Source: GitHub Actions) and open `https://<you>.github.io/<repo>/` while you still have Wi-Fi. It installs as an app and works offline after that first visit. The page lists what it detected (`Web Bluetooth: available · adapter: on · secure context: true · file:`) under the Connect button. School and work Chromebooks may block Web Bluetooth by policy; neither version can get around that.

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
  page/                single-file browser: address bar UI, HTML/CSS rewriting, cookies, CORS, in-frame runtime (shim.js)
  tests/               node tests, mock iPhone, headless E2E (extension and page)
  tools/               vendor (libcurl.js + patch), packager, build-page (→ PhoneBridge.html), vector generator
protocol/              packet-format.md (v3), test vectors, xcheck.py
docs/                  SECURITY, TESTING, ROADMAP (original plan)
```

## Third-party code

[libcurl.js](https://github.com/ading2210/libcurl.js) 0.7.5 (LGPL-3.0-or-later): curl, mbedTLS, nghttp2, brotli and Mozilla's CA bundle, compiled to WebAssembly. It's copied into the extension at build time by `tools/vendor.mjs`, which changes one line: responses with null-body statuses (304) hung upstream. The license and a note ship inside the extension in `vendor/`. `PhoneBridge.html` embeds the single-file build (`libcurl_full.js`, WebAssembly inside) with the same one-line patch; its header comment names the library and license.

## History

[`docs/ROADMAP.md`](docs/ROADMAP.md) planned the iPhone as the browser and the Chromebook as a display (v0.1). v0.2 moved rendering to the Chromebook. v0.3 moved TLS and HTTP there too, leaving the iPhone as a pure network pipe. v0.4 added `PhoneBridge.html` for Chromebooks that can't load extensions. v0.5 cut latency: priority sending on the iPhone, early data, full-size packets, an event-driven TLS engine.
