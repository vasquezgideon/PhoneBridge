# Testing

## Automated (CI)

| Suite | Proves |
|---|---|
| `npm test` (36) | PAKE (right/wrong password, tampered proof, lockout counting, NFC); TCP tunnel over the encrypted session against real sockets (queued sends, 16 KB framing, large transfers both ways, DNS/refused reasons, teardown); cache rules; framing; vectors |
| `tests/page.test.mjs` (in `npm test`) | Page build helpers: cookie jar (host-only/domain/path/Secure/HttpOnly/expiry, refused foreign domains), CSS `url()`/`@import` rewriting, `srcset` choice, address-bar parsing, Referer policy, CORS + cookie rules for page scripts |
| `tests/latency.test.mjs` (in `npm test`) | On an emulated BLE link (30 ms interval, ~720 B per event each way, real `PB.BleLink` on the Chromebook side): during a 600 KB download, ping and a new 2-round-trip connection, the v0.4 iPhone sender (8 KB radio queue, 16 KB frames, round-robin) vs the priority/pull scheduler + early data (~0.7 s → ~0.16 s ping, ~2.2 s → ~0.5 s new connection). Prints the numbers; fails unless the new scheduler is several times faster |
| `protocol/xcheck.py` | Independent Python (RFC 9380 Elligator2, `cryptography`) agrees with the crypto vectors and tunnel frame layouts |
| `swift test` | Swift field math / Elligator2 / generator / handshake keys / channel bytes / tunnel frames against the same vectors; phone handshake and lockout |
| `npm run test:e2e` (23, +1 with `PB_REAL_NET=1`) | Packaged extension in headless Chrome, Chrome's own network blackholed, mock iPhone = real TCP pipe. Rendering, cookies, iframes, cache, POST, redirects, DNS-error page, tracker block, reconnect, password change. **HTTPS isolation:** self-signed site rejected on the Chromebook; iPhone saw only a TLS ClientHello, no plaintext. CI adds real `https://registry.npmjs.org` |
| `npm run test:page` (55, +1 with `PB_REAL_NET=1`) | `PhoneBridge.html` opened from `file://`, same blackholed Chrome and mock iPhone. Rendering in the sandboxed frame, stylesheet + `@import` inlining, script order (external/inline/defer), lazy and script-created images, CSS backgrounds on demand, cookies (`HttpOnly` hidden from `document.cookie`), `fetch`/XHR, CORS blocked and allowed, script-added scripts and stylesheets, `localStorage` persistence, `pushState`, anchors, form POST, Back, redirects, refused/DNS/untrusted-certificate errors; `<noscript>` fallbacks ignored; **iPhone renders mode**: a second headless Chrome plays the iPhone's browser — picture drawn, address bar follows, click lands on the right spot, typing, Enter submits, Back, switching modes; **iPhone fetches mode**: page rendered from iPhone-fetched responses, subresources pushed and used, cookies kept on the Chromebook, untrusted certificate refused. `PB_BENCH=1` adds a timed comparison on an emulated BLE link |

## On real hardware

1. Sideload, load the extension (or open `PhoneBridge.html`), and sign in. For the HTML file, note whether Chrome offers Bluetooth to a `file://` page on your Chromebook. Time from Connect to the green chip.
2. Run Advanced › throughput test, both directions, 3 runs each. Note the idle Round trip, and the Round trip while a big page loads (should stay under ~0.3 s now).
3. Turn Wi-Fi off on the Chromebook and load Google, Wikipedia, GitHub, Reddit and Gmail. Note cold and reload times.
4. Check the iPhone dashboard. It should show only connection and byte counts: no hosts, URLs or controls.
5. Robustness:
   - walk out of range and back;
   - toggle Bluetooth on both sides;
   - background the app;
   - leave the PhoneBridge tab in the background for 10+ minutes.
6. Change the password on the iPhone. The Chromebook should ask again.
7. Do 30 minutes of browsing, watching temperature and battery.
8. HTML version, Settings → On the iPhone: load a news site and a web app; note time to first picture, scroll lag, and whether clicks and typing land. Compare with On this Chromebook and with iPhone fetches (time until the page is readable).

When reporting a problem, include the iPhone log and the link page's console with Debug log on.
