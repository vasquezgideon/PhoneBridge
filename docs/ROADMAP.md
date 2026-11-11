# PhoneBridge — Full Project Roadmap

**Updated:** Security model now supports an optional persistent password (set once, used indefinitely for trusted devices). Expanded customization and settings throughout the product.

---

## Goal

Build a tiny remote computer hosted inside your iPhone, with the Chromebook acting as its monitor, keyboard, mouse, and browser interface.

### Core architectural decision

**The iPhone owns the browser and all internet access. The Chromebook is a remote desktop client.**

That means:

- Websites load using the iPhone’s internet connection, including cellular data.
- Google accounts, cookies, sessions, passwords, and website storage stay on the iPhone.
- JavaScript and website code execute on the iPhone.
- Downloads and uploads are processed by the iPhone.
- The Chromebook sends user input and receives rendered browser output over Bluetooth.
- The Chromebook should not need internet access or a shared Wi-Fi network.

This is substantially different from putting a normal browser on the Chromebook and proxying individual requests through the phone. We’re effectively building a remote browser computer, with a custom display and input protocol.

---

## 1. System Architecture

```
iPhone — PhoneBridge host
Browser engine · cellular networking · storage · extensions · security · settings

Encrypted Bluetooth LE connection
Input, display updates, downloads, uploads, control messages, settings sync

Chromebook — PhoneBridge client
HTML desktop interface · keyboard · mouse · tabs · browser controls · rich settings UI

No Chromebook internet connection required in local Bluetooth mode.
```

### A. iPhone host: the actual computer

The iPhone should do nearly all the computational work.

| Subsystem          | Responsibility                                              |
|--------------------|-------------------------------------------------------------|
| Browser engine     | Load and execute websites                                   |
| Network manager    | All DNS, HTTPS, cookies, requests and responses             |
| Profile manager    | Cookies, local storage, sessions and cache                  |
| Extension engine   | Load and execute browser extensions                         |
| Download manager   | Download, pause, resume and organize files                  |
| Upload manager     | Select and transmit files from iPhone storage               |
| Rendering engine   | Produce display frames for the Chromebook                   |
| Input manager      | Convert remote keyboard and pointer events into browser input |
| Bluetooth host     | Secure communication with Chromebook                        |
| Settings & Config  | Persistent preferences, profiles, security options          |

**Browser engine recommendation:** WebKit initially.

Apple’s `WKWebsiteDataStore.default()` persists cookies and website data on disk, while separate persistent stores can support multiple profiles. Private browsing can use nonpersistent storage.

We should not try to implement a browser engine ourselves. That would be an enormous undertaking and would make compatibility much worse.

### B. Chromebook client: the desktop

Single entry point: **PhoneBridge.html**

It should feel like a desktop browser, not a Bluetooth configuration utility.

Its interface should include:

- Multiple tabs and tab groups
- Address and search bar
- Back, forward, reload and stop
- Bookmarks bar and bookmark manager
- Extensions menu
- Downloads and uploads manager
- Browser history
- Find in page
- Right-click context menus
- Keyboard shortcuts
- Fullscreen browser view
- Mouse pointer and scrolling
- Connection and battery indicators
- **Rich Settings panel** (see Section 3)
- **Security & Pairing screen** (persistent password support)

The Chromebook is not supposed to fetch website resources itself. It receives the host’s rendered output and sends interaction events back.

### C. Network processing: phone only

**Network isolation requirement**

The browser engine on the iPhone makes every website request. The Chromebook never gets the website’s URL and independently fetches its resources as part of rendering.

Intended flow:

1. You type `youtube.com` on the Chromebook.
2. The Chromebook sends the navigation command over Bluetooth.
3. The iPhone browser navigates to YouTube using its cellular connection.
4. The iPhone downloads the HTML, CSS, JavaScript, images and video.
5. The iPhone executes the website.
6. PhoneBridge sends compressed display updates to the Chromebook.
7. The Chromebook sends mouse and keyboard events back.

This keeps the actual website traffic on the iPhone. It also means a Chromebook without internet can still browse through a connected phone.

**Important:** BLE is not a high-bandwidth networking technology. The phone can own the network, but transporting all the rendered output and large files over BLE will be the major performance challenge. We’ll benchmark it before committing to a particular video or display codec.

---

## 2. Important Technical Research and Decisions

### 2.1 Persistent browser sessions and Google accounts

Technically supported, with an authentication caveat.

Use Apple’s `WKWebsiteDataStore`:

- `default()` for the main browser profile, with persistent cookies and storage.
- `nonPersistent()` for private browsing.
- Separate persistent stores for additional profiles.

This means website sessions can survive closing and reopening PhoneBridge. Cookies remain on the iPhone rather than being transmitted to the Chromebook.

**Google sign-in needs special handling.**

Google explicitly prohibits certain OAuth authorization flows inside developer-controlled embedded webviews (can return `disallowed_useragent`). Google recommends supported native authentication approaches such as Google Sign-In or AppAuth.

**Our solution:**

- Normal Google website browsing inside PhoneBridge.
- Detect authentication flows that require an external authentication session.
- Use `ASWebAuthenticationSession` or a provider-supported authentication flow when necessary.
- Return to PhoneBridge after authentication.
- Test whether the resulting login session is available to the browser profile.

We must not promise that every Google authentication flow will automatically share cookies with the browser.

### 2.2 Downloads and uploads

Supported by WebKit APIs (`WKDownload` / `WKDownloadDelegate` and file upload panel via `WKUIDelegate`).

**Downloading a file**

- Website sends file to iPhone over HTTPS.
- PhoneBridge saves it in its download manager.
- Chromebook receives the filename and metadata.
- User optionally requests a copy over Bluetooth.

**Uploading a Chromebook file**

- User selects a file using the Chromebook file picker.
- PhoneBridge receives the file over Bluetooth.
- iPhone supplies the file to the website’s upload form.
- Website receives it through the iPhone’s internet connection.

The website transfer can use the phone’s full internet speed. The extra Chromebook-to-phone file copy is limited by Bluetooth speed.

### 2.3 Bluetooth bandwidth: our biggest engineering risk

Nordic Semiconductor’s BLE measurements show theoretical throughput up to approximately 1.32 Mbps under favorable LE 2M PHY and 247-byte ATT MTU conditions. Actual iPhone/Chromebook performance may be considerably lower.

| Sustained throughput | Approximate time for 100 MB |
|----------------------|-----------------------------|
| 200 kbps             | ~67 minutes                 |
| 780 kbps             | ~17 minutes                 |
| 1.32 Mbps            | ~10 minutes                 |

(Approximate raw transfer estimates, excluding protocol overhead and retransmissions.)

**Design decision:** Website downloads happen at cellular speed. Transferring the downloaded file to the Chromebook happens at Bluetooth speed. We should never make users transfer every download to the Chromebook automatically.

**Display update recommendations:**

- Changed-region / tile updates instead of repeatedly sending full screenshots
- JPEG image compression initially
- Adaptive resolution
- Adaptive image quality
- Prioritizing the visible page area
- Discarding old frames when newer ones are available
- Pausing large file transfers when low-latency interaction is needed

### 2.4 iOS Bluetooth background limitations

Apple’s CoreBluetooth documentation confirms that peripheral behavior changes when an app goes into the background. The `bluetooth-peripheral` background mode is required, and advertising behavior is restricted.

**Therefore:**

- First version: PhoneBridge remains open and foregrounded.
- Later version: experiment with background BLE continuity.
- Do not promise that the browser will continue operating with the iPhone locked.
- Add a clear reconnect and session-restoration system.

### 2.5 Chromebook Bluetooth access

The Chromebook frontend can use Web Bluetooth and GATT characteristics. The browser requires a secure context and user permission before accessing a device.

The first prototype must determine whether `PhoneBridge.html` can use `navigator.bluetooth` when opened locally. If the local-file origin is rejected, we can use a local PWA or another local wrapper without introducing an internet server.

---

## 3. Security Architecture (Updated)

Security is treated as a real feature, not just a four-digit Bluetooth PIN.

### Pairing & Authentication Model

**Two complementary modes:**

1. **Initial Pairing (always required for a new device)**
   - PhoneBridge generates a random, temporary pairing code (or QR code).
   - Chromebook discovers the iPhone via Bluetooth.
   - User enters or scans the code.
   - iPhone shows an explicit confirmation prompt.
   - Both devices authenticate and establish encryption.
   - Chromebook is saved as a **trusted device**.

2. **Persistent Password (optional, indefinite)**
   - After successful pairing, the user may optionally set a **persistent unlock password**.
   - This password is stored securely on the iPhone (Keychain) and associated with the trusted device.
   - On future connections from a trusted device, the Chromebook can unlock the session by entering the password **once** (or the user can choose “Remember this device permanently”).
   - The password is **not** required every single time by default once the device is trusted and the user has opted in.
   - The user can later change or remove the password from the Settings panel.
   - Temporary pairing codes still expire quickly and have limited attempts for *new* devices.

This gives the best of both worlds: strong initial pairing security + convenient long-term access without constant re-authentication.

### Encryption

Recommended design to evaluate:

- Authenticated key exchange using a reviewed protocol or PAKE
- HKDF-SHA-256 for deriving session keys
- AES-GCM or ChaCha20-Poly1305 for encrypted messages
- Sequence counters to prevent replay
- Separate keys for each connection
- Trusted-device list stored on the iPhone

Use a vetted cryptographic implementation rather than inventing our own.

### Security Requirements

| Feature                              | Priority   |
|--------------------------------------|------------|
| Temporary pairing PIN / QR           | Essential  |
| Explicit approval on iPhone          | Essential  |
| Encrypted Bluetooth application messages | Essential |
| Reconnection authentication          | Essential  |
| **Optional persistent password**     | Essential  |
| Revoke trusted devices               | Essential  |
| No cookie / password export          | Essential  |
| File-transfer integrity checks       | Essential  |
| Extension permission prompts         | Essential  |
| Screen privacy / pause control       | Essential  |
| Optional biometric confirmation      | Later      |
| Security event log                   | Later      |

The Chromebook must never receive the actual browser cookies, password database, or authentication tokens. It receives rendered output, browser metadata, and user-authorized file transfers.

---

## 4. Customization & Settings (Expanded)

PhoneBridge should feel highly configurable. Both the iPhone host dashboard and the Chromebook client expose a rich, organized Settings experience.

### Chromebook Settings Panel

Accessible from a dedicated Settings button / keyboard shortcut. Organized into sections:

**Connection & Security**
- Current connection status and signal quality
- Trusted devices list (view / rename / revoke)
- Set / change / remove persistent unlock password
- Require password on every reconnect (toggle)
- Auto-reconnect behavior
- Pairing code regeneration

**Display & Performance**
- Image quality slider (low / medium / high / adaptive)
- Resolution scaling (25% – 100% + adaptive)
- Frame rate target / adaptive mode
- Prefer quality vs. latency
- Changed-tile updates on/off
- Color mode (full / reduced / grayscale for bandwidth)
- Night mode / dark page rendering preference

**Input & Pointer**
- Mouse sensitivity and acceleration
- Scroll speed and direction
- Keyboard layout / language
- Modifier key remapping
- Right-click behavior
- Touchpad-style gestures (if applicable)
- Pointer visibility and size

**Browser Behavior**
- Default zoom level
- Homepage / new-tab page
- Search engine preference
- Tab restore behavior
- Download location preference (phone only / offer transfer)
- Automatic download transfer to Chromebook (off by default)
- Bookmark bar visibility and position

**Appearance**
- Theme (system / light / dark / custom accent)
- UI density (compact / comfortable / spacious)
- Font size for chrome UI
- Tab bar style
- Show / hide connection and battery indicators

**Privacy & Safety**
- Screen privacy mode (pause rendering when inactive)
- Clear browsing data shortcuts
- Extension permission review
- Session timeout options

**Advanced**
- Debug logging level
- Protocol version info
- Reset all settings to defaults
- Export / import settings (local file)

### iPhone Host Dashboard Settings

The phone-side app should expose parallel controls plus host-only options:

- Browser profiles management
- Storage usage breakdown (cache, downloads, extensions)
- Network preference (prefer Wi-Fi / cellular only / automatic)
- Battery and thermal monitoring thresholds
- Background BLE experiments (experimental toggle)
- Extension management and permissions
- Security event log viewer
- Factory reset of PhoneBridge data

Settings should sync in both directions over the encrypted Bluetooth link where appropriate (e.g., display quality preferences set on Chromebook should apply immediately on the host).

---

## 5. Extension System

This is one of the largest subsystems. Design the browser around an extension API from the beginning.

Apple’s Safari Web Extensions use familiar formats, but they are packaged as app extensions and do not automatically become extensions inside an arbitrary `WKWebView`.

Our own extension engine should support a progressive compatibility model:

| Level | Features                                              |
|-------|-------------------------------------------------------|
| 1     | Manifest, JavaScript, CSS, content scripts            |
| 2     | Match patterns, enable/disable, toolbar icons         |
| 3     | Extension storage, runtime messaging                  |
| 4     | Popup pages, options pages, permissions               |
| 5     | Selected tabs, scripting and navigation APIs          |
| 6     | Broader Chrome / Firefox WebExtension compatibility   |

Eventually accept ZIP packages containing a `manifest.json`.

Not every Chrome extension will work. Extensions that rely on Chromium internals, native messaging, Chrome-specific APIs, or unrestricted background service workers may need changes or may be incompatible. A compatibility tester should tell users why an extension doesn’t work.

---

## 6. Development Roadmap

Order matters: prove the difficult technology before polishing the browser interface.

### Phase 0 — Feasibility testing (First priority)

- iPhone BLE peripheral
- Chromebook Web Bluetooth connection
- Pairing code + persistent password option
- Encrypted test messages
- Bidirectional throughput benchmark
- Send a JPEG image to Chromebook
- Send a click command to iPhone
- Verify iPhone cellular browsing with Chromebook Wi-Fi disabled

### Phase 1 — Remote browser MVP

- One `WKWebView` hosted on iPhone
- Desktop website mode
- Persistent browser profile
- Address bar and navigation
- Chromebook canvas rendering
- Pointer and scroll input
- Basic keyboard input
- Connection / reconnection handling
- Basic settings panel (quality + security)

### Phase 2 — Desktop browser interface

- Independent tabs
- Tab switcher
- Bookmarks and folders
- Browsing history
- Find in page
- Keyboard shortcuts
- Right-click menus
- Zoom and display scaling
- Session restore
- Expanded Settings UI

### Phase 3 — Browser profiles and authentication

- Persistent profiles
- Private browsing
- Cookie and site-data management
- Site permissions
- Google authentication testing
- Passkey testing
- Authentication handoff

### Phase 4 — File management

- Download manager
- Download progress
- Pause / cancel / resume where supported
- Phone-side file storage
- Chromebook file selection
- Upload-to-phone transfer
- Phone-to-Chromebook download transfer
- File checksums and transfer recovery

### Phase 5 — Extension runtime

- Manifest parser
- ZIP installer
- Content scripts
- CSS injection
- Permissions
- Extension storage
- Popup and options UI
- Runtime messaging
- Compatibility testing

### Phase 6 — Optimization

- Changed-tile display updates
- Adaptive image quality
- Adaptive resolution
- Input latency improvements
- Memory management
- Battery and temperature monitoring
- Long-session testing
- Reliable reconnection

### Phase 7 — Advanced features

- Background BLE experiments
- Additional profiles
- Audio transport research
- Optional full-phone mirroring
- Additional extension APIs
- Deeper customization options

---

## 7. What the Finished Product Should Look Like

**Chromebook side**  
Feels like a small desktop computer / browser. Familiar chrome, rich Settings, connection indicators, and a clean pairing / unlock flow that supports the optional persistent password.

**iPhone host dashboard**  
Shows:

- Connected Chromebook(s)
- Pairing and security settings (including persistent password management)
- Browser profiles
- Active tabs
- Downloads
- Extension management
- Storage usage
- Network status
- Cellular / Wi-Fi status
- Battery and temperature information
- Disconnect and revoke controls
- Full Settings access

---

## 8. Repository Structure

```
PhoneBridge/
│
├── ios/
│   ├── PhoneBridge.xcodeproj
│   ├── App/
│   ├── Browser/
│   ├── Profiles/
│   ├── Extensions/
│   ├── Downloads/
│   ├── Uploads/
│   ├── Rendering/
│   ├── Bluetooth/
│   ├── Security/
│   ├── Settings/
│   └── Tests/
│
├── chromebook/
│   ├── PhoneBridge.html
│   ├── src/
│   │   ├── interface.js
│   │   ├── bluetooth.js
│   │   ├── protocol.js
│   │   ├── crypto.js
│   │   ├── renderer.js
│   │   ├── file-transfer.js
│   │   └── settings.js
│   └── tests/
│
├── protocol/
│   ├── message-schema/
│   ├── packet-format.md
│   └── test-vectors/
│
├── docs/
│   ├── ROADMAP.md
│   ├── ARCHITECTURE.md
│   ├── SECURITY.md
│   ├── SETTINGS.md
│   ├── EXTENSIONS.md
│   └── TESTING.md
│
└── README.md
```

---

## 9. Success Criteria (Initial Engineering Targets)

| Measurement                    | Initial target                  |
|--------------------------------|---------------------------------|
| Pairing                        | Under 10 seconds                |
| Input round-trip               | Under 250 ms median             |
| Initial static page display    | Under 3 seconds after page ready|
| Static page updates            | 1–3 FPS initially               |
| File integrity                 | SHA-256 verified                |
| Reconnection                   | Automatic where possible        |
| Network isolation              | No website requests from Chromebook |
| Persistent password unlock     | Optional, works across sessions |

Test sites: Google Search, YouTube, Gmail, Google Docs, GitHub, Reddit, file upload forms, file downloads, and complex single-page applications. Also test hover menus, popups, WebGL, video, and drag-and-drop.

---

## 10. First Milestone (Go / No-Go)

Before building the full browser, build a tiny working demonstration:

1. PhoneBridge on iPhone starts advertising.
2. Chromebook’s HTML page discovers it.
3. User enters the pairing code (and optionally sets a persistent password).
4. An encrypted Bluetooth session starts.
5. Chromebook sends `NAVIGATE https://example.com`.
6. iPhone loads the page through cellular.
7. iPhone captures the rendered page.
8. Chromebook displays the page on its canvas.
9. Chromebook sends a scroll or click command.
10. iPhone updates the browser.
11. Verify that the Chromebook never accesses the website itself.

If that works reliably, the rest of the project has a sound foundation.

---

## 11. Research References

- Apple — WKWebView
- Apple — WKWebsiteDataStore
- Apple — WKUserScript
- Apple — WKUIDelegate
- Apple — WKDownload
- Apple — CBPeripheralManager
- Apple — Core Bluetooth background processing
- Apple — ASWebAuthenticationSession
- Apple — Safari Web Extensions
- Google — OAuth 2.0 policies
- MDN — Web Bluetooth API
- Nordic Semiconductor — BLE throughput measurements

---

## Final Architectural Recommendations

- **iPhone is the browser computer.** It owns all website networking and storage.
- **Chromebook is a remote desktop client.** Its HTML frontend displays the browser and sends input.
- **Bluetooth LE is the only connection** in strict local mode.
- **WebKit is the initial browser engine.** We build our own extension compatibility layer.
- **Pairing uses a temporary PIN + device confirmation + encrypted sessions.** An optional persistent password can be set for indefinite convenient access on trusted devices.
- **Downloads remain on the phone by default.** Transfers to the Chromebook are optional.
- **Foreground operation is the initial requirement.** Background operation is a later research item.
- **Rich customization and settings** are first-class features on both sides.
- **The first deliverable is a working two-device prototype**, not another visual mockup.

The most important thing is to prove the Bluetooth display and input pipeline before building all the browser features. That is the part most likely to determine whether PhoneBridge can become the fast, useful little virtual computer you’re imagining.
