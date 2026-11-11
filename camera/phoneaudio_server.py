import argparse
import datetime
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import sounddevice as sd

import PhoneAudio


worker = None
listen_device = None
virtual_device = None
DEVICES = []
DEVICES_AT = 0.0
DEVICES_LOCK = threading.Lock()


def output_devices(refresh=False):
    global DEVICES, DEVICES_AT
    with DEVICES_LOCK:
        now = time.time()
        if not refresh and DEVICES and now - DEVICES_AT < 5:
            return DEVICES
        devices = []
        hostapis = sd.query_hostapis()
        for index, device in enumerate(sd.query_devices()):
            if device["max_output_channels"] < 2:
                continue
            hostapi = hostapis[device["hostapi"]]["name"]
            if "WDM-KS" in hostapi:
                continue
            name = device["name"]
            devices.append({
                "id": index,
                "name": name,
                "cable": "CABLE In" in name or "CABLE Input" in name,
            })
        DEVICES = devices
        DEVICES_AT = now
        return devices


def find_cable(devices):
    for device in devices:
        if "CABLE In 16ch" in device["name"]:
            return device["id"]
    for device in devices:
        if device["cable"]:
            return device["id"]
    return None


def find_listen(devices):
    skip = ("переназнач", "primary", "aaa", "digital", "cable", "vb-audio")
    for needle in ("realtek hd audio 2nd output", "realtek", "speakers", "динамики", "headphones", "наушники"):
        for device in devices:
            name = device["name"].lower()
            if not device["cable"] and needle in name:
                return device["id"]
    for device in devices:
        name = device["name"].lower()
        if not device["cable"] and not any(word in name for word in skip):
            return device["id"]
    for device in devices:
        if not device["cable"]:
            return device["id"]
    return devices[0]["id"] if devices else None


def status_payload():
    if worker is None:
        return {
            "ok": True,
            "running": False,
            "status": "Готов",
            "level": [0.0, 0.0],
            "wave": [0.0] * 64,
            "recording": False,
            "seconds": 0.0,
            "path": None,
            "listen": listen_device,
            "virtual": virtual_device,
            "devices": output_devices(),
        }
    status, level, recording, seconds, path = worker.get_state()
    thread = worker.thread
    return {
        "ok": True,
        "running": bool(thread is not None and thread.is_alive()),
        "status": status,
        "level": [float(level[0]), float(level[1])],
        "wave": worker.get_wave(),
        "recording": bool(recording),
        "seconds": float(seconds),
        "path": path,
        "listen": worker.output_device if worker.output_device is not None else listen_device,
        "virtual": worker.virtual_device if worker.virtual_device is not None else virtual_device,
        "devices": output_devices(),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Cache-Control", "no-store")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            self._do_GET()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as error:
            try:
                self.json({"ok": False, "error": str(error)}, 500)
            except Exception:
                pass

    def _do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path == "/status":
            return self.json(status_payload())
        if path == "/devices":
            return self.json({"ok": True, "devices": output_devices(True)})
        if path == "/start":
            if worker is None:
                return self.json({"ok": False, "error": "worker"}, 500)
            global listen_device
            raw_device = query.get("device", [""])[0]
            if raw_device:
                try:
                    requested = int(raw_device)
                except ValueError:
                    requested = None
                for device in output_devices():
                    if device["id"] == requested and not device["cable"]:
                        listen_device = requested
                        break
            monitor = query.get("listen", ["0"])[0] != "0"
            use_virtual = query.get("virtual", ["1"])[0] != "0"
            worker.start(monitor, listen_device, virtual_device if use_virtual else None)
            return self.json({"ok": True, **status_payload()})
        if path == "/stop":
            if worker is not None:
                worker.stop()
            return self.json({"ok": True, **status_payload()})
        if path == "/shutdown":
            if worker is not None:
                worker.stop()
            PhoneAudio.stop_audio_service()
            self.json({"ok": True})
            threading.Timer(0.25, self.server.shutdown).start()
            return
        if path == "/record/start":
            if worker is None or worker.thread is None or not worker.thread.is_alive():
                return self.json({"ok": False, "error": "Микрофон не запущен"}, 409)
            if worker.recording_active():
                return self.json({"ok": False, "error": "Запись уже идёт"}, 409)
            stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            target = PhoneAudio.RECORDINGS / f"phone-mic-{stamp}.mp3"
            worker.start_recording(target)
            return self.json({"ok": True, "path": str(target)})
        if path == "/record/stop":
            if worker is not None:
                worker.stop_recording()
            return self.json({"ok": True})
        self.send_response(404)
        self.cors()
        self.end_headers()


def main():
    global worker, listen_device, virtual_device
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=27191)
    parser.add_argument("--adb", default="")
    parser.add_argument("--serial", default="")
    args = parser.parse_args()
    if args.adb:
        PhoneAudio.ADB = args.adb
    if args.serial:
        PhoneAudio.SERIAL = args.serial
    devices = output_devices()
    listen_device = find_listen(devices)
    virtual_device = find_cable(devices)
    worker = PhoneAudio.AudioWorker()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

