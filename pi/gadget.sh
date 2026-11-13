#!/bin/sh
# PhoneBridge Pi: present the Pi to the Chromebook as a USB serial device (CDC-ACM) via configfs.
# Chrome's Web Serial picker lists it as "PhoneBridge Pi"; on the Pi it is /dev/ttyGS0.
set -e
G=/sys/kernel/config/usb_gadget/phonebridge
modprobe libcomposite
mountpoint -q /sys/kernel/config || mount -t configfs none /sys/kernel/config
[ -d "$G" ] && exit 0
mkdir -p "$G"
cd "$G"
echo 0x1d6b > idVendor     # Linux Foundation
echo 0x0104 > idProduct    # Multifunction Composite Gadget (PhoneBridge.html filters on these two)
echo 0x0100 > bcdDevice
echo 0x0200 > bcdUSB
echo 0xEF > bDeviceClass
echo 0x02 > bDeviceSubClass
echo 0x01 > bDeviceProtocol
mkdir -p strings/0x409
SERIAL=$(awk '/Serial/ {print $3}' /proc/cpuinfo 2>/dev/null)
echo "${SERIAL:-0000000000000000}" > strings/0x409/serialnumber
echo "PhoneBridge" > strings/0x409/manufacturer
echo "PhoneBridge Pi" > strings/0x409/product
mkdir -p configs/c.1/strings/0x409
echo "PhoneBridge serial" > configs/c.1/strings/0x409/configuration
echo 250 > configs/c.1/MaxPower
mkdir -p functions/acm.usb0
ln -s functions/acm.usb0 configs/c.1/
# Bind to the USB device controller (dwc2); wait for it after boot.
for _ in $(seq 1 30); do
  UDC=$(ls /sys/class/udc 2>/dev/null | head -n1)
  [ -n "$UDC" ] && break
  sleep 1
done
[ -n "$UDC" ] || { echo "no USB device controller: is dtoverlay=dwc2 in config.txt?" >&2; exit 1; }
echo "$UDC" > UDC
