# PhoneBridge Pi

A Raspberry Pi Zero 2 W does the iPhone app's job. The Pi joins the iPhone's Personal Hotspot over Wi-Fi and plugs into the Chromebook by USB. `PhoneBridge.html` connects to it through Chrome's USB device picker. There's no iPhone app, no Bluetooth and no password: the cable is the pairing.

```
Chromebook                                   Pi Zero 2 W                           iPhone
PhoneBridge.html ── USB cable (Web Serial) ──▶ phonebridge-pi.py ── Wi-Fi ──▶ Personal Hotspot ──▶ internet
TLS + HTTP + rendering here                    TCP relay only                 (Maximize Compatibility on)
```

The Pi relays TCP and nothing else. HTTPS is still negotiated and checked on the Chromebook, so the Pi only sees ciphertext and `host:port`, same as the iPhone app did. Nothing between the page and the Pi is encrypted, because it's a cable between two of your own devices.

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
5. **Chromebook.** Open `PhoneBridge.html` → **Connect USB (Pi)…** → pick **PhoneBridge Pi**. After that it connects by itself whenever the Pi is plugged in, including after a reload.

## Files

| | |
|---|---|
| `phonebridge-pi.py` | The relay. Python 3 standard library only. Serves `/dev/ttyGS0`, re-opens it after unplugs, and pings the hotspot every 25 s so the iPhone doesn't drop an idle Pi |
| `gadget.sh` | configfs USB gadget: one CDC-ACM serial function, VID:PID `1d6b:0104`, product name "PhoneBridge Pi" |
| `wifi.sh` | Reads `connect.txt`; sets the Wi-Fi country, unblocks the radio, creates a NetworkManager profile that retries forever |
| `systemd/` | `phonebridge-gadget`, `phonebridge-wifi`, `phonebridge` (relay, restarts on failure) |
| `install.sh` | Installs the above on a running Pi, or into a mounted image with `--root` (what CI does) |
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
