"""Synthteam hardware bridge for the Ableton Push 3.

Connects the physical Push directly to the Synthteam server as a
dedicated `push-join` hardware client — an alternative to driving the
Push through Chrome's Web MIDI in the central console. Because it talks
to the Push over USB it can also use the 960x160 display, which Web
MIDI cannot: mission phase, the live vector path, score/integrity, and
a red HULL BREACH flash whenever the ship takes damage.

No grid learning is needed: the Push 3 pad grid is fixed at notes
36-99, bottom-left origin, matching the server's (x, y) convention of
the learned-corner setup (bottom-left = (0, 0)).

Run:  uv run bridge.py  [--server ws://127.0.0.1:4179/ws]
"""

import argparse
import asyncio
import json
import threading
import time

import aiohttp
import mido
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from push3_display import HEIGHT, WIDTH, Push3Display

PORT_NAME = "Ableton Push 3 Live Port"
PAD_LOW, PAD_HIGH = 36, 99
LED_OFF, LED_WHITE, LED_RED = 0, 3, 6

# Push palette index + screen RGB for each PushPathColor the game uses.
PATH_COLORS = {
    "violet": (79, (170, 80, 255)),
    "cyan": (34, (0, 220, 220)),
    "amber": (10, (255, 160, 0)),
    "lime": (18, (150, 255, 40)),
}

HULL_FLASH_SECONDS = 1.5


def pad_note(x, y):
    return PAD_LOW + y * 8 + x


class State:
    """Shared between the MIDI callback thread, render thread and asyncio."""

    def __init__(self):
        self.lock = threading.Lock()
        self.connected = False
        self.phase = {"kind": "lobby"}
        self.task = None            # PushPathTask dict from the server
        self.flash_until = 0.0      # HULL BREACH deadline
        self.last_integrity = None


class PushBridge:
    def __init__(self):
        self.state = State()
        self.display = Push3Display()
        self.midi_out = mido.open_output(PORT_NAME)
        self.event_queue = asyncio.Queue()
        self.loop = asyncio.get_running_loop()
        self.lit_notes = set()
        self.midi_in = mido.open_input(PORT_NAME, callback=self.on_midi)

    # ---- Pads (MIDI callback thread) -> server events ----

    def on_midi(self, msg):
        if msg.type not in ("note_on", "note_off"):
            return
        if not PAD_LOW <= msg.note <= PAD_HIGH:
            return
        x = (msg.note - PAD_LOW) % 8
        y = (msg.note - PAD_LOW) // 8
        down = msg.type == "note_on" and msg.velocity > 0
        event = {
            "type": "hardware-event",
            "event": {
                "kind": "push-pad",
                "point": {"x": x, "y": y},
                "phase": "down" if down else "up",
                "velocity": msg.velocity,
            },
        }
        self.loop.call_soon_threadsafe(self.event_queue.put_nowait, event)

    # ---- Server state -> pad LEDs ----

    def apply_state(self, push_state):
        with self.state.lock:
            self.state.phase = push_state.get("phase", {"kind": "lobby"})
            self.state.task = push_state.get("task")
            integrity = (
                self.state.phase.get("integrity")
                if self.state.phase.get("kind") == "playing"
                else None
            )
            if (
                integrity is not None
                and self.state.last_integrity is not None
                and integrity < self.state.last_integrity
            ):
                self.state.flash_until = time.monotonic() + HULL_FLASH_SECONDS
            self.state.last_integrity = integrity
            task = self.state.task
        self.light_path(task)

    def light_path(self, task):
        """Light the remaining path in its color; next expected pad is white."""
        wanted = {}
        if task is not None:
            led, _ = PATH_COLORS.get(task["color"], (LED_WHITE, None))
            progress = task["progress"]
            for index, point in enumerate(task["path"]):
                if index < progress:
                    continue  # already traced
                note = pad_note(point["x"], point["y"])
                wanted[note] = LED_WHITE if index == progress else led
        for note in self.lit_notes - set(wanted):
            self.midi_out.send(mido.Message("note_on", note=note, velocity=LED_OFF))
        for note, velocity in wanted.items():
            self.midi_out.send(mido.Message("note_on", note=note, velocity=velocity))
        self.lit_notes = set(wanted)

    # ---- Screen (render thread) ----

    def render_loop(self):
        font = ImageFont.load_default(size=26)
        small = ImageFont.load_default(size=18)
        big = ImageFont.load_default(size=80)
        huge = ImageFont.load_default(size=96)
        while True:
            with self.state.lock:
                phase = self.state.phase
                task = self.state.task
                connected = self.state.connected
                flash_left = self.state.flash_until - time.monotonic()
            try:
                self.display.send_image(
                    self.render(phase, task, connected, flash_left,
                                font, small, big, huge))
            except Exception:
                pass
            time.sleep(0.03)

    def render(self, phase, task, connected, flash_left, font, small, big, huge):
        now = time.monotonic()

        if flash_left > 0:
            pulse = 0.55 + 0.45 * np.sin(now * 30)
            image = Image.new("RGB", (WIDTH, HEIGHT), (int(160 + 95 * pulse), 0, 0))
            draw = ImageDraw.Draw(image)
            text = "HULL BREACH!!!"
            tw = draw.textlength(text, font=huge)
            tx = (WIDTH - tw) / 2 + np.sin(now * 47) * 8
            ty = (HEIGHT - 96) / 2 + np.cos(now * 61) * 6
            draw.text((tx + 4, ty + 4), text, font=huge, fill=(60, 0, 0))
            draw.text((tx, ty), text, font=huge, fill=(255, 255, 255))
            return image

        image = Image.new("RGB", (WIDTH, HEIGHT), (8, 12, 24))
        draw = ImageDraw.Draw(image)
        kind = phase.get("kind", "lobby")

        if kind == "lobby":
            draw.text((20, 30), "SYNTHTEAM", font=big, fill=(127, 212, 255))
            status = "linked to central" if connected else "waiting for central..."
            draw.text((22, 120), f"PUSH STATION  ·  {status}",
                      font=small, fill=(140, 150, 173))
        elif kind == "countdown":
            remaining = max(0.0, phase["endsAt"] / 1000 - time.time())
            text = f"{remaining:.0f}"
            tw = draw.textlength(text, font=huge)
            draw.text(((WIDTH - tw) / 2, 25), text, font=huge, fill=(255, 230, 0))
        elif kind == "playing" and task is not None:
            _, rgb = PATH_COLORS.get(task["color"], (LED_WHITE, (255, 255, 255)))
            # Mini grid mirroring the pads, path + progress
            cell, ox, oy = 17, 12, 8
            for gx in range(8):
                for gy in range(8):
                    x0 = ox + gx * cell
                    y0 = oy + (7 - gy) * cell
                    draw.rectangle([x0, y0, x0 + cell - 3, y0 + cell - 3],
                                   fill=(20, 26, 42))
            for index, point in enumerate(task["path"]):
                x0 = ox + point["x"] * cell
                y0 = oy + (7 - point["y"]) * cell
                traced = index < task["progress"]
                is_next = index == task["progress"]
                color = ((60, 66, 82) if traced
                         else (255, 255, 255) if is_next else rgb)
                draw.rectangle([x0, y0, x0 + cell - 3, y0 + cell - 3], fill=color)
            # Status block
            draw.text((170, 8), f"{task['color'].upper()} VECTOR",
                      font=font, fill=rgb)
            draw.text((170, 44), f"{task['progress']}/{len(task['path'])} traced",
                      font=small, fill=(200, 205, 215))
            score = phase.get("score", 0)
            combo = phase.get("combo", 0)
            draw.text((420, 8), f"SCORE {score}", font=font, fill=(127, 212, 255))
            if combo > 1:
                draw.text((420, 44), f"combo x{combo}", font=small,
                          fill=(255, 230, 0))
            # Integrity bar
            integrity = max(0, min(100, phase.get("integrity", 100)))
            draw.text((660, 8), "INTEGRITY", font=small, fill=(140, 150, 173))
            bar_color = ((70, 214, 140) if integrity > 50
                         else (255, 160, 0) if integrity > 25 else (224, 85, 85))
            draw.rectangle([660, 34, 940, 52], outline=(60, 66, 82), width=2)
            draw.rectangle([662, 36, 662 + int(276 * integrity / 100), 50],
                           fill=bar_color)
            # Mission clock + task deadline
            remaining = max(0.0, phase["endsAt"] / 1000 - time.time())
            draw.text((660, 66), f"mission {remaining:.0f}s", font=small,
                      fill=(140, 150, 173))
            order_left = max(0.0, task["deadlineAt"] / 1000 - time.time())
            draw.text((170, 100), f"order expires {order_left:.1f}s",
                      font=small,
                      fill=(224, 85, 85) if order_left < 3 else (140, 150, 173))
        elif kind == "game-over":
            survived = phase.get("reason") == "survived"
            text = "MISSION SURVIVED" if survived else "SHIP LOST"
            color = (70, 214, 140) if survived else (224, 85, 85)
            tw = draw.textlength(text, font=big)
            draw.text(((WIDTH - tw) / 2, 25), text, font=big, fill=color)
            score = phase.get("score", 0)
            sub = f"final score {score}"
            sw = draw.textlength(sub, font=font)
            draw.text(((WIDTH - sw) / 2, 115), sub, font=font, fill=(200, 205, 215))

        return image

    # ---- WebSocket ----

    async def sender(self, ws):
        while True:
            await ws.send_json(await self.event_queue.get())

    async def run(self, server_url):
        threading.Thread(target=self.render_loop, daemon=True).start()
        async with aiohttp.ClientSession() as session:
            while True:
                try:
                    async with session.ws_connect(server_url, heartbeat=30) as ws:
                        await ws.send_json({"type": "push-join"})
                        with self.state.lock:
                            self.state.connected = True
                        print("linked to", server_url, flush=True)
                        send_task = asyncio.ensure_future(self.sender(ws))
                        try:
                            async for raw in ws:
                                if raw.type != aiohttp.WSMsgType.TEXT:
                                    continue
                                msg = json.loads(raw.data)
                                if msg.get("type") == "push-state":
                                    self.apply_state(msg["state"])
                        finally:
                            send_task.cancel()
                except aiohttp.ClientError:
                    pass
                with self.state.lock:
                    self.state.connected = False
                    self.state.phase = {"kind": "lobby"}
                    self.state.task = None
                    self.state.last_integrity = None
                self.light_path(None)
                await asyncio.sleep(1.0)


async def amain():
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", default="ws://127.0.0.1:4179/ws")
    args = parser.parse_args()
    bridge = PushBridge()
    try:
        await bridge.run(args.server)
    finally:
        bridge.light_path(None)


def main():
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
