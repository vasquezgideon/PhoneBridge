# Testing

## Automated (CI)

| Suite | Proves |
|---|---|
| `npm test` (25) | PAKE (right/wrong password, tampered proof, lockout counting, NFC); TCP tunnel over the encrypted session against real sockets (queued sends, 16 KB framing, large transfers both ways, DNS/refused reasons, teardown); cache rules; framing; vectors |
| `protocol/xcheck.py` | Independent Python (RFC 9380 Elligator2, `cryptography`) agrees with the crypto vectors and tunnel frame layouts |
| `swift test` | Swift field math / Elligator2 / generator / handshake keys / channel bytes / tunnel frames against the same vectors; phone handshake and lockout |
| `npm run test:e2e` (23, +1 with `PB_REAL_NET=1`) | Packaged extension in headless Chrome, Chrome's own network blackholed, mock iPhone = real TCP pipe. Rendering, cookies, iframes, cache, POST, redirects, DNS-error page, tracker block, reconnect, password change. **HTTPS isolation:** self-signed site rejected on the Chromebook; iPhone saw only a TLS ClientHello, no plaintext. CI adds real `https://registry.npmjs.org` |

## On real hardware

1. Sideload, load the extension, and sign in. Time from Connect to the green chip.
2. Run the extension's Advanced › throughput test, both directions, 3 runs each.
3. Turn Wi-Fi off on the Chromebook and load Google, Wikipedia, GitHub, Reddit and Gmail. Note cold and reload times.
4. Check the iPhone dashboard. It should show only connection and byte counts: no hosts, URLs or controls.
5. Robustness:
   - walk out of range and back;
   - toggle Bluetooth on both sides;
   - background the app;
   - leave the PhoneBridge tab in the background for 10+ minutes.
6. Change the password on the iPhone. The Chromebook should ask again.
7. Do 30 minutes of browsing, watching temperature and battery.

When reporting a problem, include the iPhone log and the link page's console with Debug log on.
