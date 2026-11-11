# PhoneBridge

A tiny remote computer hosted on an iPhone, with a Chromebook acting as its monitor, keyboard and mouse — over Bluetooth LE only.

The iPhone owns the browser: WebKit, all networking (including cellular), cookies, sessions and storage. The Chromebook runs a single HTML page that draws JPEG tiles streamed from the phone and sends input back. The Chromebook doesn't need internet, and the page is built with a Content-Security-Policy of `connect-src 'none'`, so it *can't* fetch anything even if it tried.

```
iPhone (host)                         Chromebook (client)
WKWebView · cellular · storage   ⇄    PhoneBridge.html
Keychain trust · tile encoder   BLE   canvas · input · settings
```

## Status

This is **Phase 0 + the Phase 1 MVP** from [`docs/ROADMAP.md`](docs/ROADMAP.md): the first-milestone go/no-go demo, plus enough browser around it to use.

| Done | Not yet |
|---|---|
| BLE GATT peripheral on iPhone, Web Bluetooth client | Tabs, bookmarks, history (Phase 2) |
| Pairing: commitment + 6-digit code + approval on iPhone | `<select>` popups, JS alerts, file pickers forwarded |
| Encrypted session (ECDH P-256, HKDF, AES-256-GCM, strict counters) | Downloads/uploads (Phase 4) |
| Trusted-device resume, revoke, optional persistent password + lockout | Extensions (Phase 5) |
| Desktop-mode WKWebView, persistent profile | Background / locked-phone operation |
| Changed-region JPEG tiles, adaptive bursts, backpressure | Audio, smooth video |
| Pointer, wheel, keyboard, paste | |
| Throughput benchmark both directions, RTT readout | |
| Settings on both sides, synced over the link | |

**Untested on real hardware so far.** The protocol and crypto are pinned by shared test vectors (JS, Swift, and an independent Python check agree), and the Chromebook UI passes an end-to-end test in headless Chrome against a mock iPhone. The iOS app has only been compiled by CI, and BLE behaviour on real devices still needs measuring. That measurement is the point of Phase 0.

## Build

Everything builds on GitHub Actions (`.github/workflows/build.yml`) on every push:

| Job | Runner | Output |
|---|---|---|
| Chromebook client | ubuntu | unit tests, cross-language vectors, single-file build, headless E2E → **`PhoneBridge-chromebook`** artifact (`PhoneBridge.html`) |
| Swift core tests | macos-15 | handshake state machine, vectors, framing, PBKDF2 |
| iOS app | macos-15 | XcodeGen → `xcodebuild` without signing → **`PhoneBridge-ios`** artifact (`PhoneBridge-unsigned.ipa`) |
| Release | ubuntu | on a `v*` tag, attaches both files to a GitHub Release |

Locally:

```sh
# Chromebook client
cd chromebook
npm ci
npm test             # protocol, crypto, handshake (incl. mock iPhone)
npm run build        # → dist/PhoneBridge.html
npm run test:e2e     # needs Chrome; CHROME_PATH=… if not /usr/bin/google-chrome

# iOS (macOS + Xcode)
swift test --package-path ios/PhoneBridgeCore
brew install xcodegen && xcodegen generate --spec ios/project.yml
open ios/PhoneBridge.xcodeproj
```

## Install & run

**iPhone.** Download the `PhoneBridge-ios` artifact from the latest Actions run, unzip it, and sideload `PhoneBridge-unsigned.ipa` with SideStore (or AltStore, or Xcode with your own team). On first launch, allow Bluetooth.

**Chromebook.** Download the `PhoneBridge-chromebook` artifact and open `PhoneBridge.html` in Chrome.

If Chrome refuses Web Bluetooth for a `file://` page, serve it from localhost instead. `localhost` counts as a secure context, and nothing leaves the machine. In the Linux development environment:

```sh
cd ~/Downloads && python3 -m http.server 8000   # then open http://localhost:8000/PhoneBridge.html
```

**First connection**

1. On the iPhone, open PhoneBridge and tap **Pair new Chromebook** (the pairing window stays open for 2 minutes).
2. On the Chromebook, click **Connect…** and pick *PhoneBridge* in Chrome's chooser.
3. Type the 6-digit code the iPhone shows. When the Chromebook says **Code verified**, tap **Approve** on the iPhone.

After that, the Chromebook reconnects automatically (Settings › Reconnect automatically). Keep PhoneBridge open in the foreground on the phone. The app keeps the screen awake by default for that reason.

**Phase 0 checklist.** [`docs/TESTING.md`](docs/TESTING.md) lists what to measure on real hardware, including the built-in benchmark under Settings › Advanced.

## Repository

```
ios/
  project.yml              XcodeGen spec (project is generated, not committed)
  PhoneBridgeCore/         SwiftPM: wire format, crypto, handshake, password verifier + tests
  App/                     SwiftUI dashboard, AppModel (link ⇄ session ⇄ browser ⇄ streamer)
  Bluetooth/               CBPeripheralManager GATT server, send queue with backpressure
  Browser/                 WKWebView controller, injected input agent, live preview
  Rendering/               snapshot → changed-region JPEG tiles
  Security/                Keychain-backed trusted devices, password, lockout
  Settings/                host settings
chromebook/
  PhoneBridge.html         dev entry (classic scripts, works from file://)
  src/                     bytes, protocol, crypto, storage, session, bluetooth, renderer, input, settings, interface
  tools/build.mjs          inlines everything into dist/PhoneBridge.html + CSP
  tests/                   node tests, mock iPhone, headless E2E
protocol/
  packet-format.md         the wire protocol, both directions
  test-vectors/            handshake-v1.json — checked by JS and Swift tests
docs/                      ROADMAP, SECURITY, TESTING
```

## Known limitations

- **Input is synthetic.** Clicks and keys are DOM events injected into the page (`isTrusted === false`). Most sites accept them; some games, CAPTCHAs and anti-bot checks won't.
- **Native popups stay on the phone.** `<select>` dropdowns, `alert()` and file pickers open on the iPhone's screen for now, not the Chromebook's.
- **Single tab.** `target=_blank` opens in place.
- **Bandwidth.** BLE is slow. Expect roughly 1–3 fps on changing content, and a scroll re-sends most of the screen. Lower the resolution or quality, or turn on grayscale, under Display.
- **Google sign-in** inside an embedded web view can hit `disallowed_useragent`. The `ASWebAuthenticationSession` handoff is Phase 3.
- **Foreground only.** iOS throttles BLE peripherals in the background.

## Security

Summary in [`docs/SECURITY.md`](docs/SECURITY.md); exact constructions in [`protocol/packet-format.md`](protocol/packet-format.md). Cookies, passwords and tokens never leave the iPhone. The Chromebook receives pixels, page metadata and its own trust key.
