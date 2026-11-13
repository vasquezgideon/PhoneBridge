#!/bin/sh
# install.sh against a fake image root with Raspberry Pi OS's stock config.txt layout (which already
# contains "dtoverlay=dwc2,dr_mode=host" under [cm5]). Run as root.
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
R=$(mktemp -d)
mkdir -p "$R/etc/cloud" "$R/boot/firmware" "$R/home"
for f in passwd shadow group gshadow login.defs; do [ -f /etc/$f ] && cp /etc/$f "$R/etc/"; done
for g in sudo netdev plugdev; do groupadd -R "$R" -f "$g" 2>/dev/null || true; done
printf '127.0.1.1\traspberrypi\n' > "$R/etc/hosts"
cat > "$R/boot/firmware/config.txt" <<'CFG'
# For more options and information see
dtparam=audio=on
camera_auto_detect=1
display_auto_detect=1
auto_initramfs=1
dtoverlay=vc4-kms-v3d
max_framebuffers=2
disable_fw_kms_setup=1
arm_64bit=1
disable_overscan=1
arm_boost=1

[cm4]
# Enable host mode on the 2711 built-in XHCI USB controller.
otg_mode=1

[cm5]
dtoverlay=dwc2,dr_mode=host

[all]
CFG
echo 'console=serial0,115200 console=tty1 root=PARTUUID=1 rootfstype=ext4 fsck.repair=yes rootwait' > "$R/boot/firmware/cmdline.txt"
fail() { echo "not ok - $1"; exit 1; }
sh "$HERE/install.sh" --root "$R" > /dev/null
tail -n 3 "$R/boot/firmware/config.txt" | grep -qx 'dtoverlay=dwc2,dr_mode=peripheral' || fail "device mode added despite the stock [cm5] dwc2 line"
echo "ok - stock config.txt gets dtoverlay=dwc2,dr_mode=peripheral under [all]"
sh "$HERE/install.sh" --root "$R" > /dev/null
[ "$(grep -c 'dr_mode=peripheral' "$R/boot/firmware/config.txt")" = 1 ] || fail "second run added it again"
echo "ok - second run doesn't add it twice"
printf '\n[all]\ndtoverlay=dwc2,dr_mode=host\n' >> "$R/boot/firmware/config.txt"
sh "$HERE/install.sh" --root "$R" > /dev/null
tail -n 1 "$R/boot/firmware/config.txt" | grep -qx 'dtoverlay=dwc2,dr_mode=peripheral' || fail "a later host-only line under [all] wasn't overridden"
echo "ok - a later host-only dwc2 line under [all] is overridden"
for u in phonebridge-gadget phonebridge-wifi phonebridge; do [ -L "$R/etc/systemd/system/multi-user.target.wants/$u.service" ] || fail "$u not enabled"; done
[ -f "$R/boot/firmware/connect.txt" ] || fail "no connect.txt"
echo "ok - services enabled, connect.txt in place"
grep -q '^pbrender:' "$R/etc/passwd" && [ -f "$R/usr/local/lib/phonebridge/pbrender.py" ] || fail "browser user / driver missing"
echo "ok - pbrender user and browser driver installed"
rm -rf "$R"
