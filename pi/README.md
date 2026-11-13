# PhoneBridge Pi

A Raspberry Pi Zero 2 W does the iPhone app's job. The Pi joins the iPhone's Personal Hotspot over Wi-Fi and plugs into the Chromebook by USB. `PhoneBridge.html` connects to it through Chrome's USB device picker. There's no iPhone app, no Bluetooth and no password: the cable is the pairing.

```
Chromebook                                   Pi Zero 2 W                           iPhone
PhoneBridge.html ── USB cable (Web Serial) ──▶ phonebridge-pi.py ── Wi-Fi ──▶ Personal Hotspot ──▶ internet
TLS + HTTP + rendering here                    TCP relay only                 (Maximize Compatibility on)
```

The Pi relays TCP and nothing else. HTTPS is still negotiated and checked on the Chromebook, so the Pi only sees ciphertext and `host:port`, same as the iPhone app did. Nothing between the page and the Pi is encrypted, because it's a cable between two of your own devices.

## Two ways pages load

`PhoneBridge-Pi.html` → ☰ → Settings → **Where pages load**:

- **On the Pi (real Chrome)**, the default. Chromium runs headless on the Pi. The Chromebook gets pictures of the page and sends back clicks, scrolling and typing.
  - Sites work as in Chrome: Google Search, YouTube video, logins, web apps.
  - Costs: **no sound**, text is a picture, and speed depends on the Zero 2 W (512 MB RAM, four slow cores).
  - Needs Chromium on the Pi. The new image has it; on a hand-installed Pi, run `sudo apt install chromium`. Without it, pages are rebuilt on the Chromebook and a banner says so.
- **On this Chromebook.** The page fetches the site through the Pi and rebuilds it here. It's sharp and has sound, but sites with heavy bot checks or video players break: Google Search, YouTube video, some image loading. Google searches are redirected to DuckDuckGo's plain-HTML results.

Chromium runs as the unprivileged `pbrender` user, never as root. It closes itself after 5 minutes without a picture client, which frees the RAM.

**Logins and extensions (Pi browser).** The Pi browser's profile is kept on the SD card in `/var/lib/pbrender/profile`, so you stay signed in (Google included) across unplugs and reboots. It identifies itself as normal Chrome rather than "HeadlessChrome", which Google sign-in turns away.

- **Install an extension:** ☰ → **Pi browser** → paste a Chrome Web Store link → Install. The Pi downloads it over the hotspot, unpacks it with its store key (so it keeps its real ID), and restarts its browser on the same page.
- **Open an extension:** the **Open** and **Options** buttons show its toolbar popup or options page as a page. There's no toolbar, so badges and icons aren't shown.
- **Not available:** Manifest V2 extensions, which current Chromium no longer runs. Auto-update is also missing: install again to update.
- **Erase logins & data** deletes the profile (cookies, history, site data) and keeps the extensions.

**Picture settings:**
- **Sharpness:** Light renders at 0.75× (least work for the Pi), Normal at 1×, Sharp at the Chromebook screen's full resolution.
- **Picture quality:** JPEG 40/60/80.

## Set up

1. **SD card.** Either:
   - Flash `PhoneBridge-Pi.img.xz` from the GitHub release or CI artifact. This is Raspberry Pi OS Lite 64-bit with PhoneBridge already installed. Use Raspberry Pi Imager → *Use custom*, and skip Imager's "customisation" step.
   - Or flash plain Raspberry Pi OS Lite (64-bit), boot it once with a keyboard and screen (or SSH), copy this folder over and run `sudo ./install.sh`.
2. **`connect.txt`.** Edit it on the card's boot partition, the drive called `bootfs` that any computer, including the Chromebook's Files app, can open:
   ```
   Name: iPhone
   Pass: hotspot password
   Country: US
   ```
   - `Name` is your hotspot's name, shown in iPhone Settings → General → About → Name.
   - `Pass` is the password from Settings → Personal Hotspot.
   - `Country` is your Wi-Fi region as a two-letter code (optional; default US).
   - A single line also works: `Name:iPhone Pass:hotspot passotwd`. A straight `'` matches the iPhone's curly `’`.
   - The file is re-read every boot.
3. **iPhone.** Settings → Personal Hotspot:
   - Turn on **Allow Others to Join**.
   - Turn on **Maximize Compatibility**. The Zero 2 W only has 2.4 GHz Wi-Fi, and iPhone 12 and later run the hotspot on 5 GHz unless this is on.
   - Keep that screen open the first time the Pi joins.
4. **Plug in.** Use a data-capable micro-USB cable into the Pi's **USB** port: the inner one, next to the HDMI port, not `PWR IN`. That one port powers the Pi and carries the data. Give it about 30–60 s to boot; the first boot is slower.
5. **Chromebook.** Open **`PhoneBridge-Pi.html`**. It shows only a waiting screen until the Pi is connected. The first time, click **Choose PhoneBridge Pi…** and pick it. After that it connects by itself whenever the Pi is plugged in, including after a reload, and goes back to the waiting screen if you unplug it. (`PhoneBridge.html`, the iPhone-app version, can use a Pi too: **Connect USB (Pi)…**.)

   **Editing `connect.txt` from the page:** **Hotspot settings…** (waiting screen) or the Hotspot card (panel). With the SD card in the Chromebook, click **Open connect.txt…** and pick it on the `bootfs` drive, change it, then click **Save**. Put the card back in the Pi. The Pi only reads the file when it starts.

## Files

| | |
|---|---|
| `pbrender.py` | “Pi browser” mode: drives headless Chromium over the DevTools protocol (stdlib WebSocket client), sends JPEG pictures, replays input |
| `phonebridge-pi.py` | The relay. Python 3 standard library only. Serves `/dev/ttyGS0`, re-opens it after unplugs, and pings the hotspot every 25 s so the iPhone doesn't drop an idle Pi |
| `gadget.sh` | configfs USB gadget: one CDC-ACM serial function, VID:PID `1d6b:0104`, product name "PhoneBridge Pi" |
| `wifi.sh` | Reads `connect.txt`; sets the Wi-Fi country, unblocks the radio, creates a NetworkManager profile that retries forever |
| `systemd/` | `phonebridge-gadget`, `phonebridge-wifi`, `phonebridge` (relay, restarts on failure) |
| `install.sh` | Installs the above on a running Pi, or into a mounted image with `--root` (what CI does) |
| `tests/test_render.py` | Pi browser mode at the protocol level against a real Chromium: start, picture, link click, Back, typing + Enter, resize, navigation, no HeadlessChrome in UA/client hints, login cookie survives a restart, Web Store CRX install → content script runs → popup page → remove, erase |
| `tests/test_install.sh` | Installer on a fake image root with the stock `config.txt` |
| `tests/test_tty.py` | The relay on a real pseudo-terminal with real TCP: welcome, early data, a 200 KB stream, refused port, resync after a cut-off frame |

The image has a console login `pi` / `phonebridge` for an HDMI screen and keyboard. SSH is off. If you turn SSH on, change the password first. The image also turns off cloud-init and the first-boot user wizard so it's ready on first power-on.

## If it doesn't connect

- **USB picker is empty:**
  - Try another cable. Many micro-USB cables only charge.
  - Make sure you used the inner USB port.
  - Wait a full minute on the first boot.
  - On a school or work Chromebook, an administrator can block USB serial devices for web pages (Chrome's Web Serial policy). If so, the button will never list anything.
- **Connects, but every site fails:**
  - The Pi isn't on the hotspot. The panel shows `Wi-Fi “name” · signal%` when it is.
  - Check Maximize Compatibility, and the name and password in `connect.txt`.
  - Open the Personal Hotspot screen on the iPhone and wait 30 s. The Pi keeps retrying.
- **Debugging with a screen and keyboard:**
  - `journalctl -u phonebridge -u phonebridge-wifi -u phonebridge-gadget`
  - `nmcli dev wifi list`
  - `ls /sys/class/udc`: it should list a controller. If not, `dtoverlay=dwc2` is missing from `config.txt`.

## Not verified on hardware yet

All the logic is tested, but on a laptop:
- The relay is tested over a pseudo-terminal and in headless Chrome through a fake Web Serial port.
- The scripts are tested against a stubbed `nmcli` and a fake image root.

Still unchecked on a real Zero 2 W:
- that ChromeOS lists the gadget in the Web Serial picker;
- the first-boot time;
- whether disabling cloud-init on the Trixie image has side effects;
- throughput over USB.

Please report what you see.
