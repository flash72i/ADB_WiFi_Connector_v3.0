import argparse
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import cv2

import PhoneCamViewer as viewer


worker = None
current_camera = 0
orientation_stop = threading.Event()


def orientation_loop():
    while not orientation_stop.is_set():
        sock = None
        try:
            viewer.adb("forward", "tcp:27185", "localabstract:android-cam-orientation")
            sock = socket.create_connection(("127.0.0.1", 27185), timeout=2)
            sock.settimeout(2)
            buf = b""
            while not orientation_stop.is_set():
                try:
                    data = sock.recv(64)
                except socket.timeout:
                    continue
                if not data:
                    break
                buf += data
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    try:
                        value = int(line.strip())
                    except ValueError:
                        continue
                    if value in (0, 90, 180, 270) and worker is not None:
                        worker.set_device_rotation(value)
        except Exception:
            if not orientation_stop.is_set():
                time.sleep(1)
        finally:
            if sock is not None:
                try:
                    sock.close()
                except Exception:
                    pass


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
        global current_camera
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/stream":
            return self.stream()
        if path == "/status":
            frame, status, fps = worker.get_state()
            return self.json({
                "ok": True,
                "status": status,
                "fps": round(fps, 1),
                "camera": current_camera,
                "auto": worker.auto_enabled(),
                "rotation": worker.get_transform()[0],
                "zoom": worker.get_zoom(),
            })
        if path.startswith("/camera/"):
            try:
                cam = int(path.rsplit("/", 1)[1])
            except ValueError:
                return self.json({"ok": False, "error": "camera"}, 400)
            if cam not in range(0, 8):
                return self.json({"ok": False, "error": "camera"}, 400)
            raw_zoom = parse_qs(parsed.query).get("zoom", ["100"])[0]
            try:
                zoom = int(round(float(raw_zoom)))
            except ValueError:
                zoom = 100
            current_camera = cam
            worker.start(cam, zoom)
            return self.json({"ok": True, "camera": cam, "zoom": worker.get_zoom()})
        if path == "/rotate/left":
            worker.rotate_by(-90)
            return self.json({"ok": True})
        if path == "/rotate/right":
            worker.rotate_by(90)
            return self.json({"ok": True})
        if path == "/rotate/180":
            worker.rotate_by(180)
            return self.json({"ok": True})
        if path == "/mirror":
            worker.toggle_mirror(True)
            return self.json({"ok": True})
        if path == "/reset":
            worker.reset_transform(current_camera)
            return self.json({"ok": True})
        if path == "/auto":
            worker.set_auto(not worker.auto_enabled())
            return self.json({"ok": True, "auto": worker.auto_enabled()})
        if path == "/zoom":
            raw = parse_qs(parsed.query).get("value", ["100"])[0]
            try:
                percent = int(round(float(raw)))
            except ValueError:
                return self.json({"ok": False, "error": "zoom"}, 400)
            ok = worker.set_zoom(percent)
            return self.json({"ok": ok, "zoom": worker.get_zoom()})
        if path == "/stop":
            worker.stop()
            return self.json({"ok": True})
        if path == "/shutdown":
            try:
                viewer.stop_camera_service()
            except Exception:
                pass
            worker.stop()
            orientation_stop.set()
            self.json({"ok": True})
            threading.Timer(0.25, self.server.shutdown).start()
            return
        self.send_response(404)
        self.cors()
        self.end_headers()

    def stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.cors()
        self.end_headers()
        last = None
        try:
            self.connection.settimeout(5.0)
            while True:
                frame, status, fps = worker.get_state()
                if frame is not None:
                    last = frame
                if frame is None and status == "Остановлено":
                    break
                if last is not None:
                    ok, jpg = cv2.imencode(
                        ".jpg", last, [cv2.IMWRITE_JPEG_QUALITY, 82]
                    )
                    if ok:
                        data = jpg.tobytes()
                        self.wfile.write(b"--frame\r\n")
                        self.wfile.write(b"Content-Type: image/jpeg\r\n")
                        self.wfile.write(
                            ("Content-Length: " + str(len(data)) + "\r\n\r\n").encode()
                        )
                        self.wfile.write(data)
                        self.wfile.write(b"\r\n")
                        self.wfile.flush()
                time.sleep(0.03)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=27190)
    parser.add_argument("--camera", type=int, choices=range(0, 8), default=0)
    parser.add_argument("--adb", default="")
    parser.add_argument("--serial", default="")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--fps", type=int, default=60)
    args = parser.parse_args()

    if args.adb:
        viewer.ADB = args.adb
    if args.serial:
        viewer.SERIAL = args.serial
    viewer.WIDTH = max(320, min(3840, args.width))
    viewer.HEIGHT = max(240, min(2160, args.height))
    viewer.REQUESTED_FPS = max(15, min(120, args.fps))

    global worker, current_camera
    current_camera = args.camera
    viewer.ensure_virtual_camera()
    worker = viewer.CameraWorker()
    worker.start(current_camera)

    orientation = threading.Thread(target=orientation_loop, daemon=True)
    orientation.start()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
