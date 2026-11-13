#!/bin/sh
# PhoneBridge Pi: join the iPhone's Personal Hotspot using connect.txt on the boot partition.
#   Name: iPhone
#   Pass: hotspot password
#   Country: US        (optional, Wi-Fi regulatory region, default US)
# One line ("Name:iPhone Pass:secret") works too. Edit the file from any computer; it's re-read
# on every boot. NetworkManager keeps retrying, so the hotspot can be switched on later.
set -u
for f in ${PB_CONNECT:-} /boot/firmware/connect.txt /boot/connect.txt; do [ -f "$f" ] && CONF=$f && break; done
[ -n "${CONF:-}" ] || { echo "connect.txt not found on the boot partition" >&2; exit 0; }
TEXT=$(tr -d '\r' < "$CONF")
NAME=$(printf '%s\n' "$TEXT" | sed -n 's/^.*[Nn]ame:[[:space:]]*//p' | sed 's/[[:space:]]*[Pp]ass:.*$//' | sed 's/[[:space:]]*[Cc]ountry:.*$//' | head -n1)
PASS=$(printf '%s\n' "$TEXT" | sed -n 's/^.*[Pp]ass:[[:space:]]*//p' | sed 's/[[:space:]]*[Cc]ountry:.*$//' | head -n1)
PASS=$(printf '%s' "$PASS" | sed 's/[[:space:]]*$//')
COUNTRY=$(printf '%s\n' "$TEXT" | sed -n 's/^.*[Cc]ountry:[[:space:]]*\([A-Za-z][A-Za-z]\).*$/\1/p' | head -n1)
COUNTRY=$(printf '%s' "${COUNTRY:-US}" | tr '[:lower:]' '[:upper:]')
[ -n "$NAME" ] || { echo "connect.txt has no Name:" >&2; exit 0; }
# Wi-Fi stays blocked until a regulatory country is set.
if command -v raspi-config >/dev/null 2>&1; then raspi-config nonint do_wifi_country "$COUNTRY" >/dev/null 2>&1 || true; fi
iw reg set "$COUNTRY" 2>/dev/null || true
rfkill unblock wifi 2>/dev/null || true
nmcli radio wifi on 2>/dev/null || true
# iPhone hotspot names use a curly apostrophe ("Sam’s iPhone"); connect.txt typed on a PC usually
# has a straight one. Scan, and if a visible network matches ignoring apostrophe style and case,
# use its exact name. (Up to ~30 s: the hotspot may only just have been switched on.)
for _ in 1 2 3 4 5 6; do
  FOUND=$(nmcli -t -f SSID dev wifi list --rescan yes 2>/dev/null | python3 -c '
import sys
norm = lambda s: s.replace("\u2019", "'"'"'").replace("\u2018", "'"'"'").replace("`", "'"'"'").strip().casefold()
want = norm(sys.argv[1])
for line in sys.stdin:
    ssid = line.rstrip("\n").replace("\\:", ":")
    if ssid and norm(ssid) == want:
        print(ssid); break
' "$NAME")
  [ -n "$FOUND" ] && break
  sleep 5
done
if [ -n "${FOUND:-}" ] && [ "$FOUND" != "$NAME" ]; then
  echo "connect.txt says \"$NAME\"; using the visible network \"$FOUND\""
  NAME=$FOUND
fi
CON=phonebridge-hotspot
nmcli connection delete "$CON" >/dev/null 2>&1 || true
if [ -n "$PASS" ]; then
  nmcli connection add type wifi ifname wlan0 con-name "$CON" ssid "$NAME" \
    wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PASS" \
    connection.autoconnect yes connection.autoconnect-retries 0 connection.autoconnect-priority 100 \
    802-11-wireless.powersave 2 802-11-wireless.hidden yes >/dev/null
else
  nmcli connection add type wifi ifname wlan0 con-name "$CON" ssid "$NAME" \
    connection.autoconnect yes connection.autoconnect-retries 0 connection.autoconnect-priority 100 \
    802-11-wireless.powersave 2 802-11-wireless.hidden yes >/dev/null
fi
echo "PhoneBridge Pi: joining \"$NAME\" (country $COUNTRY)"
nmcli --wait 30 connection up "$CON" >/dev/null 2>&1 || echo "hotspot not reachable yet; NetworkManager will keep trying"
exit 0
