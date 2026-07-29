"""Minimal driver for the Ableton Push 3 display.

The Push 3 speaks the same USB display protocol as the Push 2 —
documented in Ableton's push-interface repo — just with a different
USB product ID. 960x160 pixels, 16 bits per pixel, sent as raw bulk
transfers: a 16-byte frame header, then 160 lines of 2048 bytes
(1920 bytes of pixels + 128 bytes of padding), each 32-bit word
XORed with the "signal shaping" pattern 0xFFE7F3E7.

The device blanks the screen if it hasn't received a frame for ~2
seconds, so keep sending frames (even identical ones) to hold an image.
"""

import numpy as np
import usb.core
import usb.backend.libusb1

VENDOR_ID = 0x2982
PRODUCT_ID = 0x1969  # Push 2 is 0x1967

WIDTH, HEIGHT = 960, 160
LINE_BYTES = 2048  # 960 px * 2 bytes + 128 bytes padding
FRAME_BYTES = LINE_BYTES * HEIGHT

FRAME_HEADER = bytes([0xFF, 0xCC, 0xAA, 0x88] + [0] * 12)

XOR_PATTERN = np.tile(
    np.array([0xE7, 0xF3, 0xE7, 0xFF], dtype=np.uint8), FRAME_BYTES // 4
)

# Homebrew's libusb lives outside the default ctypes search path on
# Apple Silicon, so fall back to the known locations.
_LIBUSB_FALLBACKS = [
    "/opt/homebrew/lib/libusb-1.0.dylib",
    "/usr/local/lib/libusb-1.0.dylib",
]


def _get_backend():
    backend = usb.backend.libusb1.get_backend()
    if backend is not None:
        return backend
    for path in _LIBUSB_FALLBACKS:
        backend = usb.backend.libusb1.get_backend(find_library=lambda x: path)
        if backend is not None:
            return backend
    raise RuntimeError(
        "libusb not found. Install it with: brew install libusb"
    )


class Push3Display:
    def __init__(self):
        self.device = usb.core.find(
            idVendor=VENDOR_ID, idProduct=PRODUCT_ID, backend=_get_backend()
        )
        if self.device is None:
            raise RuntimeError(
                "No Push 3 found on USB. Is it plugged in and powered?"
            )
        try:
            self.device.set_configuration()
        except usb.core.USBError as ex:
            raise RuntimeError(
                "Could not claim the Push 3 display interface. "
                "Close Live (or any other app using the display) and, on a "
                "standalone Push, switch it into Control Mode."
            ) from ex
        self._frame = np.zeros(FRAME_BYTES, dtype=np.uint8)

    def send_image(self, image):
        """Send a 960x160 PIL image to the display."""
        rgb = np.asarray(image.convert("RGB"), dtype=np.uint16)
        self.send_rgb(rgb)

    def send_rgb(self, rgb):
        """Send a (160, 960, 3) uint16/uint8 RGB array to the display."""
        rgb = rgb.astype(np.uint16, copy=False)
        r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        # 16-bit pixel: blue in the high 5 bits, green 6, red in the low 5
        pixel = ((b & 0xF8) << 8) | ((g & 0xFC) << 3) | (r >> 3)
        lines = self._frame.reshape(HEIGHT, LINE_BYTES)
        lines[:, : WIDTH * 2] = (
            pixel.astype("<u2").view(np.uint8).reshape(HEIGHT, WIDTH * 2)
        )
        data = self._frame ^ XOR_PATTERN
        self.device.write(0x01, FRAME_HEADER, timeout=1000)
        self.device.write(0x01, data.tobytes(), timeout=1000)
