#!/bin/sh
# PhoneBridge Pi installer.
#
#   On the Pi (Raspberry Pi OS Lite, Bookworm or Trixie):   sudo ./install.sh
#   Into a mounted SD card / image (as root on any Linux):  ./install.sh --root /mnt/rootfs [--boot /mnt/rootfs/boot/firmware]
#
# What it does:
#   - copies the relay + scripts to /usr/local/lib/phonebridge and installs three systemd services
#     (USB gadget, Wi-Fi from connect.txt, relay), enabled at boot
#   - turns on USB device mode: dtoverlay=dwc2 in config.txt, dwc2 + libcomposite at boot
#   - puts connect.txt on the boot partition (if there isn't one) for the hotspot name/password
#   - image mode only: creates a console login (default pi / phonebridge; change with --user) and
#     skips Raspberry Pi OS's first-boot setup so the Pi is ready on its first power-on
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=
BOOT=
USERSPEC=pi:phonebridge
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT=$2; shift 2 ;;
    --boot) BOOT=$2; shift 2 ;;
    --user) USERSPEC=$2; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root (sudo $0 $*)" >&2; exit 1; }
if [ -z "$BOOT" ]; then
  if [ -f "$ROOT/boot/firmware/config.txt" ]; then BOOT=$ROOT/boot/firmware
  elif [ -f "$ROOT/boot/config.txt" ]; then BOOT=$ROOT/boot
  else echo "can't find config.txt under $ROOT/boot; pass --boot" >&2; exit 1; fi
fi
[ -f "$BOOT/config.txt" ] || { echo "$BOOT/config.txt not found" >&2; exit 1; }

echo "PhoneBridge Pi: installing into ${ROOT:-/} (boot partition $BOOT)"

# 1. files
LIB=$ROOT/usr/local/lib/phonebridge
install -d "$LIB" "$ROOT/etc/systemd/system/multi-user.target.wants" "$ROOT/etc/modules-load.d"
install -m 755 "$HERE/phonebridge-pi.py" "$HERE/gadget.sh" "$HERE/wifi.sh" "$LIB/"
for u in phonebridge-gadget phonebridge-wifi phonebridge; do
  install -m 644 "$HERE/systemd/$u.service" "$ROOT/etc/systemd/system/$u.service"
  ln -sf "/etc/systemd/system/$u.service" "$ROOT/etc/systemd/system/multi-user.target.wants/$u.service"
done
# Nothing else may grab the gadget's serial port (a login prompt there would eat the protocol).
ln -sf /dev/null "$ROOT/etc/systemd/system/serial-getty@ttyGS0.service"

# 2. USB device (gadget) mode
printf 'dwc2\nlibcomposite\n' > "$ROOT/etc/modules-load.d/phonebridge.conf"
if ! grep -q '^dtoverlay=dwc2' "$BOOT/config.txt"; then
  printf '\n[all]\n# PhoneBridge Pi: USB device mode on the data port\ndtoverlay=dwc2,dr_mode=peripheral\n' >> "$BOOT/config.txt"
fi
# Old guides add modules-load=dwc2,g_ether to cmdline.txt; a g_ether gadget would take the USB port.
if [ -f "$BOOT/cmdline.txt" ] && grep -q 'modules-load=' "$BOOT/cmdline.txt"; then
  sed -i 's/ *modules-load=[^ ]*//' "$BOOT/cmdline.txt"
  echo "  removed modules-load= from cmdline.txt (the PhoneBridge gadget needs the USB port)"
fi

# 3. hotspot settings
if [ ! -f "$BOOT/connect.txt" ]; then
  install -m 644 "$HERE/connect.txt" "$BOOT/connect.txt"
  echo "  wrote $BOOT/connect.txt: put your hotspot's name and password in it"
fi

# 4. image mode: ready on first power-on
if [ -n "$ROOT" ]; then
  NAME=${USERSPEC%%:*}
  PASS=${USERSPEC#*:}
  if ! grep -q "^$NAME:" "$ROOT/etc/passwd"; then
    useradd -R "$ROOT" -m -s /bin/bash -G sudo,video,plugdev,netdev,dialout "$NAME" 2>/dev/null \
      || useradd -R "$ROOT" -m -s /bin/bash "$NAME"
  fi
  HASH=$(printf '%s' "$PASS" | openssl passwd -6 -stdin)
  # (chpasswd -R needs PAM inside the image; edit shadow directly instead)
  awk -v n="$NAME" -v h="$HASH" 'BEGIN{FS=OFS=":"} $1==n{$2=h} {print}' "$ROOT/etc/shadow" > "$ROOT/etc/shadow.pb" \
    && cat "$ROOT/etc/shadow.pb" > "$ROOT/etc/shadow" && rm -f "$ROOT/etc/shadow.pb"
  # Skip the first-boot "create a user" prompt (Bookworm) and cloud-init (Trixie): the user exists
  # and Wi-Fi comes from connect.txt. Saves a lot of first-boot time on a Zero 2 W.
  ln -sf /dev/null "$ROOT/etc/systemd/system/userconfig.service"
  if [ -d "$ROOT/etc/cloud" ]; then touch "$ROOT/etc/cloud/cloud-init.disabled"; fi
  rm -f "$BOOT/userconf.txt" "$BOOT/userconf"
  echo "PhoneBridge-Pi" > "$ROOT/etc/hostname"
  sed -i 's/^127\.0\.1\.1.*/127.0.1.1\tPhoneBridge-Pi/' "$ROOT/etc/hosts" 2>/dev/null || true
  echo "  console login: $NAME / $PASS (SSH stays off)"
else
  systemctl daemon-reload
  systemctl enable phonebridge-gadget.service phonebridge-wifi.service phonebridge.service >/dev/null
  systemctl mask serial-getty@ttyGS0.service >/dev/null 2>&1 || true
  if [ -n "$(find /sys/class/udc -mindepth 1 -maxdepth 1 2>/dev/null)" ]; then
    systemctl restart phonebridge-gadget.service phonebridge-wifi.service phonebridge.service || true
    echo "  started. Plug the Pi's USB data port into the Chromebook."
  else
    echo "  reboot to switch on USB device mode (sudo reboot)"
  fi
fi
echo "done"
