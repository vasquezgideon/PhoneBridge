# Testing

## Automated (CI)

| Suite | What it proves |
|---|---|
| `chromebook: npm test` | Framing under random splits, tile codec, secure-channel counters, client handshake against a JS mock iPhone (pair, resume, wrong code, tampered commitment, forged trust, revoked/unknown device, tampered ciphertext), and that `protocol/test-vectors/handshake-v1.json` matches the JS implementation |
| `swift test` (PhoneBridgeCore) | The same vectors from Swift (so JS ⇄ Swift agree byte-for-byte), the phone handshake state machine (pair/reject/bad MAC/closed/resume/unknown), framing, PBKDF2 against the RFC 7914 vector |
| `chromebook: npm run test:e2e` | The **built** single-file page in headless Chrome, with a fake `navigator.bluetooth` bridged to the mock iPhone: pairing UI, typo handling, tile rendering, indicators, pointer/keyboard/wheel forwarding, address bar, settings sync, password unlock, auto-reconnect |

## Phase 0 go/no-go — on real hardware

Record the numbers. They decide the display codec and the rest of the roadmap.

1. **Install.** Sideload the IPA and open `PhoneBridge.html` on the Chromebook. Note whether Web Bluetooth works from `file://` or needed `localhost`.
2. **Pair.** Time it from clicking Connect to the page appearing (target < 10 s). Try a wrong code, a Reject on the iPhone, and pairing with the window closed.
3. **Throughput.** Settings › Advanced › Throughput test, both directions, 3 runs each. Note the BLE packet size shown in the iPhone log (`maximumUpdateValueLength`).

   | Run | iPhone → Chromebook kbit/s | Chromebook → iPhone kbit/s |
   |---|---|---|
   | 1 | | |
   | 2 | | |
   | 3 | | |

4. **Latency.** Read the control round trip in the status pill (target median < 250 ms). Also judge click-to-visible-change by eye.
5. **Network isolation.** Turn Wi-Fi off on the Chromebook (and on the iPhone, so it's cellular only) and load a few sites. The iPhone's Network row should say *cellular*.
6. **Frames.** Note the fps readout on a static page, while scrolling, and on a page with animation, at resolution 50 / 75 / 100 % and quality 30 / 50 / 80.
7. **Reconnect.** Walk out of range and back, toggle Bluetooth on either side, and lock and unlock the iPhone. Note what recovers automatically.
8. **Password.** Set one from the Chromebook, reconnect, test wrong attempts until lockout, then test Remember this Chromebook and Require on every reconnect.
9. **Long session.** 30 minutes of browsing: iPhone temperature (status pill shows *hot* at serious/critical), battery drain, any stalls.

Test sites from the roadmap: Google Search, YouTube, Gmail, Google Docs, GitHub, Reddit, an upload form, a download, a complex single-page app. Also hover menus, popups, WebGL, video and drag-and-drop.

## Reporting a failure

Include the iPhone log (Dashboard › This iPhone › Log) and the Chromebook console with Settings › Advanced › Debug log on.
