import argparse
import ctypes
import os
import secrets
import socket
import struct
import subprocess
import threading
import time
import tkinter as tk
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps, ImageTk

os.environ.setdefault(
    "OPENCV_FFMPEG_CAPTURE_OPTIONS",
    "fflags;nobuffer|flags;low_delay|max_delay;0|probesize;100000|analyzeduration;0",
)

BASE = Path(__file__).resolve().parent
FRAME_DIR = Path(r"C:\ProgramData\PhoneVirtualCam")
FRAME_TMP = FRAME_DIR / "frame.tmp"
FRAME_OUT = FRAME_DIR / "frame.bin"
PACKAGE = "com.officialdad.androidcam"
SERVICE = f"{PACKAGE}/.CamService"
TOKEN_FILE = "control-token-camera"
WIDTH = 1280
HEIGHT = 720
REQUESTED_FPS = 60


def find_adb():
    direct = BASE.parent / "ADB_WiFi_Connector_v3.0" / "release" / "ADB Wi-Fi Connector" / "APP" / "resources" / "adb" / "adb.exe"
    if direct.exists():
        return str(direct)
    for candidate in BASE.parent.rglob("adb.exe"):
        return str(candidate)
    return "adb"


ADB = find_adb()
SERIAL = ""  # set by phonecam_server.py --serial

CONTROL_PORT = 27186
CONTROL_SOCKET = "android-cam-control"
_control_sock = None
_control_lock = threading.Lock()


def _control_connect():
    adb("forward", f"tcp:{CONTROL_PORT}", "localabstract:" + CONTROL_SOCKET)
    return socket.create_connection(("127.0.0.1", CONTROL_PORT), timeout=2)


def reset_control():
    """Drop the control socket so the next zoom reaches a freshly started service."""
    global _control_sock
    with _control_lock:
        if _control_sock is not None:
            try:
                _control_sock.close()
            except Exception:
                pass
            _control_sock = None


def wait_for_camera_service():
    for _ in range(24):
        try:
            out = adb("shell", "dumpsys", "activity", "services", PACKAGE, timeout=4).stdout or ""
        except Exception:
            out = ""
        if "CamService" in out and "isForeground=true" in out:
            return True
        time.sleep(0.2)
    return False


def stop_camera_service():
    try:
        adb("shell", "am", "stopservice", "-n", SERVICE)
    except Exception:
        return
    for _ in range(24):
        try:
            out = adb("shell", "dumpsys", "activity", "services", PACKAGE, timeout=4).stdout or ""
        except Exception:
            out = ""
        if "CamService" not in out:
            return
        time.sleep(0.25)


def send_zoom(percent):
    """Send a live zoom command to CamService. Returns False if the phone is not listening."""
    global _control_sock
    value = max(58, min(800, int(percent)))
    with _control_lock:
        for _ in range(2):
            try:
                if _control_sock is None:
                    _control_sock = _control_connect()
                _control_sock.sendall(("zoom=" + str(value) + "\n").encode())
                return True
            except Exception:
                if _control_sock is not None:
                    try:
                        _control_sock.close()
                    except Exception:
                        pass
                    _control_sock = None
        return False


def adb(*args, timeout=6):
    command = [ADB]
    if SERIAL:
        command += ["-s", SERIAL]
    command += list(args)
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )


def control_token():
    token = secrets.token_hex(16)
    command = (
        f"run-as {PACKAGE} sh -c 'mkdir -p files; "
        f"echo -n {token} > files/{TOKEN_FILE}'"
    )
    result = adb("shell", command)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "run-as failed").strip()
        raise RuntimeError(detail)
    return token


_virtual_cam_job = None


def _assign_kill_on_close_job(proc):
    global _virtual_cam_job
    if os.name != "nt":
        return
    job = None
    try:
        from ctypes import wintypes

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD
        ]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = 0x2000
        if not kernel32.SetInformationJobObject(
            job, 9, ctypes.byref(info), ctypes.sizeof(info)
        ):
            kernel32.CloseHandle(job)
            return
        if not kernel32.AssignProcessToJobObject(job, wintypes.HANDLE(int(proc._handle))):
            kernel32.CloseHandle(job)
            return
        _virtual_cam_job = job
    except Exception:
        if job:
            try:
                ctypes.WinDLL("kernel32").CloseHandle(job)
            except Exception:
                pass


def ensure_virtual_camera():
    try:
        listed = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq PhoneVirtualCam.exe", "/NH"],
            capture_output=True,
            text=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
        ).stdout
        if "PhoneVirtualCam.exe" not in listed:
            exe = BASE / "bin" / "PhoneVirtualCam.exe"
            if exe.exists():
                proc = subprocess.Popen(
                    [str(exe), "--seconds", "86400"],
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                _assign_kill_on_close_job(proc)
    except Exception:
        pass


def transform_frame(frame, rotation=0, mirror_h=False, mirror_v=False):
    rotation %= 360
    if rotation == 90:
        image = cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
    elif rotation == 180:
        image = cv2.rotate(frame, cv2.ROTATE_180)
    elif rotation == 270:
        image = cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
    else:
        image = frame
    if mirror_h:
        image = cv2.flip(image, 1)
    if mirror_v:
        image = cv2.flip(image, 0)
    height, width = image.shape[:2]
    scale = min(WIDTH / width, HEIGHT / height)
    target_w = max(1, int(round(width * scale)))
    target_h = max(1, int(round(height * scale)))
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR
    resized = cv2.resize(image, (target_w, target_h), interpolation=interpolation)
    canvas = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    left = (WIDTH - target_w) // 2
    top = (HEIGHT - target_h) // 2
    canvas[top:top + target_h, left:left + target_w] = resized
    return canvas


class CameraWorker:
    def __init__(self):
        self.lock = threading.Lock()
        self.frame = None
        self.status = "Запуск..."
        self.fps = 0.0
        self._generation = 0
        self._thread = None
        self._stop_event = None
        self._switch_lock = threading.Lock()
        self.rotation = 90
        self.base_rotation = 90
        self.device_rotation = 0
        self.auto_rotate = True
        self.mirror_h = False
        self.mirror_v = False
        self.zoom = 100

    def _set_status(self, generation, text):
        with self.lock:
            if generation == self._generation:
                self.status = text

    def set_status(self, text):
        with self.lock:
            self.status = text

    def get_state(self):
        with self.lock:
            frame = self.frame
            self.frame = None
            return frame, self.status, self.fps

    def start(self, camera_id, zoom=100):
        with self.lock:
            self._generation += 1
            generation = self._generation
            self.fps = 0.0
            self.rotation = 90 if camera_id != 1 else 270
            self.base_rotation = self.rotation
            self.mirror_h = False
            self.mirror_v = False
            self.zoom = max(58, min(800, int(zoom)))
            self.status = "Переключаю камеру..."
        threading.Thread(
            target=self._switch,
            args=(camera_id, generation),
            daemon=True,
        ).start()

    def rotate_by(self, delta):
        with self.lock:
            self.auto_rotate = False
            self.rotation = (self.rotation + delta) % 360

    def set_rotation(self, angle):
        with self.lock:
            self.auto_rotate = False
            self.rotation = angle % 360

    def toggle_mirror(self, horizontal=True):
        with self.lock:
            if horizontal:
                self.mirror_h = not self.mirror_h
            else:
                self.mirror_v = not self.mirror_v

    def reset_transform(self, camera_id):
        with self.lock:
            self.auto_rotate = False
            self.rotation = 90 if camera_id != 1 else 270
            self.mirror_h = False
            self.mirror_v = False

    def set_auto(self, enabled):
        with self.lock:
            self.auto_rotate = bool(enabled)
            if enabled:
                self.rotation = (self.base_rotation + self.device_rotation) % 360

    def auto_enabled(self):
        with self.lock:
            return self.auto_rotate

    def set_device_rotation(self, angle):
        with self.lock:
            self.device_rotation = angle % 360
            if self.auto_rotate:
                self.rotation = (self.base_rotation + self.device_rotation) % 360

    def get_transform(self):
        with self.lock:
            return self.rotation, self.mirror_h, self.mirror_v

    def set_zoom(self, percent):
        value = max(58, min(800, int(percent)))
        with self.lock:
            self.zoom = value
        return send_zoom(value)

    def get_zoom(self):
        with self.lock:
            return self.zoom

    def stop(self):
        with self.lock:
            self._generation += 1
            self.fps = 0.0
            event = self._stop_event
            thread = self._thread
            self._stop_event = None
            self._thread = None
            self.status = "Остановлено"
        if event is not None:
            event.set()
        threading.Thread(
            target=self._shutdown,
            args=(thread,),
            daemon=True,
        ).start()

    def _shutdown(self, thread):
        self._stop_phone()
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)

    def _switch(self, camera_id, generation):
        with self._switch_lock:
            self._stop_current()
            with self.lock:
                if generation != self._generation:
                    return
            event = threading.Event()
            with self.lock:
                if generation != self._generation:
                    return
                self._stop_event = event
                thread = threading.Thread(
                    target=self._run,
                    args=(camera_id, generation, event),
                    daemon=True,
                )
                self._thread = thread
            thread.start()

    def _stop_current(self):
        with self.lock:
            event = self._stop_event
            thread = self._thread
            self._stop_event = None
            self._thread = None
        if event is not None:
            event.set()
        self._stop_phone()
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)

    def _stop_phone(self):
        stop_camera_service()

    def _run(self, camera_id, generation, stop_event):
        name = "передняя" if camera_id == 1 else ("ультраширокая" if camera_id in (2, 3, 4) else "задняя")
        fps = 120 if (WIDTH <= 1280 and HEIGHT <= 720) else 30
        bitrate = max(8_000_000, min(50_000_000, int(WIDTH * HEIGHT * fps * 0.15)))
        self._set_status(generation, f"Запускаю камеру: {name}...")
        cap = None
        try:
            if stop_event.is_set():
                return
            reset_control()
            if stop_event.is_set():
                return
            token = control_token()
            adb(
                "shell", "am", "start-foreground-service", "-n", SERVICE,
                "--ei", "width", str(WIDTH),
                "--ei", "height", str(HEIGHT),
                "--ei", "fps", str(fps),
                "--ei", "bitrate", str(bitrate),
                "--es", "camera", str(camera_id),
                "--es", "control_token", token,
            )
            wait_for_camera_service()
            adb("forward", "tcp:27183", "localabstract:android-cam")
            time.sleep(0.6)
            if stop_event.is_set():
                return
            initial_zoom = self.get_zoom()
            for _ in range(8):
                if stop_event.is_set():
                    return
                if send_zoom(initial_zoom):
                    break
                time.sleep(0.15)

            cap = None
            for _ in range(20):
                if stop_event.is_set():
                    return
                cap = cv2.VideoCapture("tcp://127.0.0.1:27183", cv2.CAP_FFMPEG)
                if cap.isOpened():
                    break
                cap.release()
                cap = None
                time.sleep(0.4)
            if cap is None:
                self._set_status(generation, f"{name.capitalize()} камера недоступна")
                return

            send_zoom(self.get_zoom())
            try:
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            except Exception:
                pass

            self._set_status(generation, f"{name.capitalize()} камера • подключено")
            frame_count = 0
            fps_start = time.time()
            last_write = 0.0
            while not stop_event.is_set():
                try:
                    ok, frame = cap.read()
                except cv2.error:
                    if not stop_event.is_set():
                        self._set_status(
                            generation,
                            f"{name.capitalize()} камера • поток потерян",
                        )
                    break
                if not ok or frame is None:
                    if not stop_event.is_set():
                        self._set_status(
                            generation,
                            f"{name.capitalize()} камера • поток потерян",
                        )
                    break
                with self.lock:
                    if self.auto_rotate:
                        # device_rotation is the clockwise rotation reported by the
                        # phone sensor; the raw camera frame is rotated by the same
                        # amount, so add it to the sensor's base orientation. The old
                        # subtraction put one landscape side upside down.
                        rotation = (self.base_rotation + self.device_rotation) % 360
                    else:
                        rotation = self.rotation
                    mirror_h = self.mirror_h
                    mirror_v = self.mirror_v
                oriented = transform_frame(frame, rotation, mirror_h, mirror_v)
                now = time.time()
                frame_count += 1
                with self.lock:
                    if generation != self._generation:
                        break
                    self.frame = oriented
                    if now - fps_start >= 1.0:
                        self.fps = frame_count / (now - fps_start)
                        frame_count = 0
                        fps_start = now
                if now - last_write >= 1.0 / 30.0:
                    last_write = now
                    self._write_bridge_frame(oriented)
        except Exception as error:
            if not stop_event.is_set():
                self._set_status(generation, f"Ошибка: {error}")
        finally:
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass
            with self.lock:
                if self._thread is threading.current_thread():
                    self._thread = None
                    self._stop_event = None

    def _write_bridge_frame(self, frame):
        try:
            if frame.shape[1] != WIDTH or frame.shape[0] != HEIGHT:
                frame = cv2.resize(frame, (WIDTH, HEIGHT))
            payload = cv2.cvtColor(frame, cv2.COLOR_BGR2BGRA).tobytes()
            FRAME_DIR.mkdir(parents=True, exist_ok=True)
            header = struct.pack("<4sIII", b"PCAM", WIDTH, HEIGHT, len(payload))
            with open(FRAME_TMP, "wb") as file:
                file.write(header)
                file.write(payload)
            os.replace(FRAME_TMP, FRAME_OUT)
        except Exception:
            pass


class PhoneCamApp(tk.Tk):
    def __init__(self, initial_camera):
        super().__init__()
        self.title("ADB Phone Camera — MultiTool")
        self.geometry("1020x780")
        self.configure(bg="#17191d")
        self.initial_camera = initial_camera
        self.current_camera = initial_camera
        self.worker = CameraWorker()
        self.last_image = None
        self.last_frame = None

        header = tk.Frame(self, bg="#17191d")
        header.pack(fill="x", padx=18, pady=(14, 6))
        self.status = tk.Label(header, text="Запуск...", font=("Segoe UI", 12), fg="white", bg="#17191d")
        self.status.pack(side="left")
        self.fps = tk.Label(header, text="0 FPS", font=("Segoe UI", 11), fg="#7bd88f", bg="#17191d")
        self.fps.pack(side="right")

        self.video = tk.Label(self, bg="#070809", width=960, height=540)
        self.video.pack(padx=18, pady=8)
        self.video.pack_propagate(False)

        controls = tk.Frame(self, bg="#17191d")
        controls.pack(fill="x", padx=18, pady=(4, 12))
        self.front_button = tk.Button(
            controls, text="Передняя", font=("Segoe UI", 11),
            bg="#1e90ff", fg="white", activebackground="#1676d2",
            relief="flat", command=lambda: self.select_camera(1),
        )
        self.front_button.pack(side="left", expand=True, fill="x", padx=(0, 5))
        self.back_button = tk.Button(
            controls, text="Задняя", font=("Segoe UI", 11),
            bg="#3a3f47", fg="white", activebackground="#4a505a",
            relief="flat", command=lambda: self.select_camera(0),
        )
        self.back_button.pack(side="left", expand=True, fill="x", padx=5)
        self.stop_button = tk.Button(
            controls, text="Стоп", font=("Segoe UI", 11),
            bg="#3a3f47", fg="white", activebackground="#4a505a",
            relief="flat", command=self.stop_camera,
        )
        self.stop_button.pack(side="left", expand=True, fill="x", padx=(5, 0))

        transform = tk.Frame(self, bg="#17191d")
        transform.pack(fill="x", padx=18, pady=(0, 10))
        transform_buttons = [
            ("Влево 90", lambda: self.rotate(-90)),
            ("Вправо 90", lambda: self.rotate(90)),
            ("180°", lambda: self.rotate(180)),
            ("Зеркало", self.toggle_mirror),
            ("Сброс", self.reset_transform),
        ]
        for text, command in transform_buttons:
            tk.Button(
                transform, text=text, font=("Segoe UI", 9),
                bg="#252a31", fg="white", activebackground="#333a44",
                relief="flat", command=command,
            ).pack(side="left", expand=True, fill="x", padx=3)
        self.auto_button = tk.Button(
            transform, text="Авто", font=("Segoe UI", 9),
            bg="#252a31", fg="white", activebackground="#333a44",
            relief="flat", command=self.toggle_auto,
        )
        self.auto_button.pack(side="left", expand=True, fill="x", padx=3)

        zoom_row = tk.Frame(self, bg="#17191d")
        zoom_row.pack(fill="x", padx=18, pady=(0, 10))
        tk.Label(
            zoom_row, text="Зум", font=("Segoe UI", 9),
            fg="#9fb0ba", bg="#17191d",
        ).pack(side="left", padx=(0, 8))
        self.zoom_value = tk.Label(
            zoom_row, text="1.0×", font=("Segoe UI", 9), width=6,
            fg="white", bg="#17191d",
        )
        self.zoom_value.pack(side="right")
        self.zoom_scale = tk.Scale(
            zoom_row, from_=60, to=800, resolution=10, orient=tk.HORIZONTAL,
            showvalue=False, bg="#17191d", fg="white", troughcolor="#252a31",
            highlightthickness=0, sliderrelief="flat", command=self.on_zoom,
        )
        self.zoom_scale.set(100)
        self.zoom_scale.pack(side="left", expand=True, fill="x")

        self.bind("<Key-1>", lambda event: self.select_camera(1))
        self.bind("<Key-2>", lambda event: self.select_camera(0))
        self.bind("<Escape>", lambda event: self.stop_camera())
        self.protocol("WM_DELETE_WINDOW", self.close)

        ensure_virtual_camera()
        self.orientation_stop = threading.Event()
        self.orientation_sock = None
        self.orientation_thread = threading.Thread(
            target=self._orientation_loop, daemon=True
        )
        self.orientation_thread.start()
        self.after(200, lambda: self.select_camera(self.initial_camera))
        self.after(15, self.update_view)

    def on_zoom(self, value):
        percent = int(float(value))
        self.zoom_value.config(text=f"{percent / 100:.1f}×")
        pending = getattr(self, "_zoom_after", None)
        if pending is not None:
            try:
                self.after_cancel(pending)
            except Exception:
                pass
        self._zoom_after = self.after(80, lambda: self.worker.set_zoom(percent))

    def update_auto_button(self):
        self.auto_button.config(
            bg="#1e90ff" if self.worker.auto_enabled() else "#252a31"
        )

    def toggle_auto(self):
        self.worker.set_auto(not self.worker.auto_enabled())
        self.update_auto_button()

    def rotate(self, delta):
        self.worker.rotate_by(delta)
        self.update_auto_button()

    def toggle_mirror(self):
        self.worker.toggle_mirror(True)

    def reset_transform(self):
        self.worker.reset_transform(self.current_camera)
        self.update_auto_button()

    def select_camera(self, camera_id):
        self.current_camera = camera_id
        self.front_button.config(bg="#1e90ff" if camera_id == 1 else "#3a3f47")
        self.back_button.config(bg="#1e90ff" if camera_id == 0 else "#3a3f47")
        if hasattr(self, "zoom_scale"):
            self.zoom_scale.set(100)
            self.zoom_value.config(text="1.0×")
        self.worker.start(camera_id)

    def _orientation_loop(self):
        while not self.orientation_stop.is_set():
            sock = None
            try:
                adb("forward", "tcp:27185", "localabstract:android-cam-orientation")
                sock = socket.create_connection(("127.0.0.1", 27185), timeout=2)
                sock.settimeout(2)
                self.orientation_sock = sock
                buffer = b""
                while not self.orientation_stop.is_set():
                    try:
                        data = sock.recv(64)
                    except socket.timeout:
                        continue
                    if not data:
                        break
                    buffer += data
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        try:
                            value = int(line.strip())
                        except ValueError:
                            continue
                        if value in (0, 90, 180, 270):
                            self.worker.set_device_rotation(value)
            except Exception:
                if not self.orientation_stop.is_set():
                    time.sleep(1)
            finally:
                self.orientation_sock = None
                if sock is not None:
                    try:
                        sock.close()
                    except Exception:
                        pass

    def stop_camera(self):
        self.worker.stop()
        self.status.config(text="Остановлено")

    def update_view(self):
        frame, status, fps = self.worker.get_state()
        self.status.config(text=status)
        self.fps.config(text=f"{fps:.0f} FPS")
        if frame is not None:
            self.last_frame = frame
        if self.last_frame is not None:
            rgb = cv2.cvtColor(self.last_frame, cv2.COLOR_BGR2RGB)
            image = ImageOps.pad(Image.fromarray(rgb), (960, 540), color=(7, 8, 9))
            self.last_image = ImageTk.PhotoImage(image)
            self.video.config(image=self.last_image)
        self.after(30, self.update_view)

    def close(self):
        self.orientation_stop.set()
        sock = self.orientation_sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
            try:
                sock.close()
            except Exception:
                pass
        self.worker.stop()
        self.destroy()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--camera", type=int, choices=[0, 1], default=1)
    args = parser.parse_args()
    PhoneCamApp(args.camera).mainloop()
