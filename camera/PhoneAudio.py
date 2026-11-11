import datetime
import secrets
import socket
import struct
import subprocess
import threading
import time
import tkinter as tk

import lameenc
import numpy as np
import sounddevice as sd

from pathlib import Path

BASE = Path(__file__).resolve().parent
RECORDINGS = BASE / "recordings"
PACKAGE = "com.officialdad.androidcam"
SERVICE = f"{PACKAGE}/.AudioService"
TOKEN_FILE = "control-token-audio"
PORT = 27184
SAMPLE_RATE = 48000
CHANNELS = 2
BITS = 16
CHUNK = SAMPLE_RATE * CHANNELS * (BITS // 8) // 50


def find_adb():
    candidates = (
        BASE.parent / "ADB_WiFi_Connector_v3.0" / "release" / "ADB Wi-Fi Connector" / "APP" / "resources" / "adb" / "adb.exe",
        BASE.parents[1] / "adb" / "adb.exe",
        BASE.parents[1] / "scrcpy" / "adb.exe",
    )
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    for candidate in BASE.parent.rglob("adb.exe"):
        return str(candidate)
    return "adb"


ADB = find_adb()
SERIAL = ""


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


def ensure_audio_service():
    token = control_token()
    adb(
        "shell", "am", "start-foreground-service", "-n", SERVICE,
        "--es", "control_token", token,
    )
    adb("forward", f"tcp:{PORT}", "localabstract:android-cam-audio")


def stop_audio_service():
    try:
        adb("shell", "am", "stopservice", "-n", SERVICE)
    except Exception:
        pass


def recv_exact(sock, size):
    data = bytearray()
    while len(data) < size:
        part = sock.recv(size - len(data))
        if not part:
            return None
        data += part
    return bytes(data)


class AudioWorker:
    def __init__(self):
        self.lock = threading.Lock()
        self.status = "Готов"
        self.level = (0.0, 0.0)
        self.thread = None
        self.sock = None
        self.stop_event = threading.Event()
        self.monitor = False
        self.output_device = None
        self.virtual_device = None
        self.wave = [0.0] * 64
        self.record_active = False
        self.record_path = None
        self.record_started = 0.0
        self.record_seconds = 0.0
        self.encoder = None
        self.record_file = None

    def set_status(self, text):
        with self.lock:
            self.status = text

    def get_state(self):
        with self.lock:
            return (
                self.status,
                self.level,
                self.recording_active(),
                self.record_seconds,
                self.record_path,
            )

    def get_wave(self):
        with self.lock:
            return list(self.wave)

    def recording_active(self):
        return self.record_active or self.encoder is not None

    def start(self, monitor, output_device, virtual_device=None):
        self.stop()
        with self.lock:
            self.monitor = monitor
            self.output_device = output_device
            self.virtual_device = virtual_device
            self.level = (0.0, 0.0)
            self.wave = [0.0] * 64
            self.record_seconds = 0.0
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        sock = self.sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
            try:
                sock.close()
            except Exception:
                pass
        thread = self.thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)
        self.thread = None
        self.sock = None

    def start_recording(self, path):
        with self.lock:
            self.record_active = True
            self.record_path = str(path)
            self.record_started = time.time()
            self.record_seconds = 0.0
            self.status = "Запись MP3..."

    def stop_recording(self):
        with self.lock:
            self.record_active = False

    def _run(self):
        out = None
        vout = None
        sock = None
        try:
            self.set_status("Запускаю микрофон...")
            ensure_audio_service()
            sock = socket.create_connection(("127.0.0.1", PORT), timeout=6)
            sock.settimeout(5)
            header = recv_exact(sock, 16)
            if header is None:
                raise RuntimeError("нет заголовка аудиопотока")
            magic, rate, channels, bits = struct.unpack("<4sIII", header)
            if magic != b"AUD0" or rate != SAMPLE_RATE or channels != CHANNELS or bits != BITS:
                raise RuntimeError(
                    f"неподдерживаемый поток: {magic!r}, {rate} Гц, {channels} каналов, {bits} бит"
                )
            self.sock = sock
            sock.settimeout(10.0)

            errors = []

            def open_output(device):
                try:
                    stream = sd.RawOutputStream(
                        samplerate=rate,
                        channels=channels,
                        dtype="int16",
                        blocksize=CHUNK // (channels * (bits // 8)),
                        latency="low",
                        device=device,
                    )
                    stream.start()
                    return stream
                except Exception as error:
                    errors.append(str(error))
                    return None

            if self.monitor:
                out = open_output(self.output_device)
            if self.virtual_device is not None and (out is None or self.virtual_device != self.output_device):
                vout = open_output(self.virtual_device)
            routes = []
            if out is not None:
                routes.append("динамики")
            if vout is not None:
                routes.append("Микрофон Android")
            if routes:
                self.set_status("Стерео 48 кГц • " + " + ".join(routes))
            else:
                self.set_status("Стерео 48 кГц • без вывода" + (": " + errors[-1] if errors else ""))

            while not self.stop_event.is_set():
                try:
                    data = recv_exact(sock, CHUNK)
                except socket.timeout:
                    if not self.stop_event.is_set():
                        self.set_status("Поток аудио остановлен: нет данных")
                    break
                if data is None:
                    break

                with self.lock:
                    record_active = self.record_active
                    record_path = self.record_path

                if out is not None:
                    out.write(data)
                if vout is not None:
                    vout.write(data)

                if record_active and self.encoder is None:
                    try:
                        RECORDINGS.mkdir(parents=True, exist_ok=True)
                        self.record_file = open(record_path, "wb")
                        self.encoder = lameenc.Encoder()
                        self.encoder.set_bit_rate(192)
                        self.encoder.set_in_sample_rate(rate)
                        self.encoder.set_channels(channels)
                        self.encoder.set_quality(2)
                        self.set_status(f"Слушаю и пишу MP3: {Path(record_path).name}")
                    except Exception as error:
                        self._close_recording()
                        self.set_status(f"Ошибка записи MP3: {error}")

                if not record_active and self.encoder is not None:
                    self._close_recording()
                    self.set_status("Запись сохранена")

                if self.encoder is not None:
                    try:
                        self.record_file.write(self.encoder.encode(data))
                    except Exception as error:
                        self._close_recording()
                        self.set_status(f"Ошибка MP3: {error}")

                samples = np.frombuffer(data, dtype="<i2").reshape(-1, channels)
                rms = np.sqrt((samples.astype(np.float64) ** 2).mean(axis=0))
                mono = samples.mean(axis=1).astype(np.float64) / 32768.0
                buckets = 64
                if len(mono) >= buckets:
                    step = len(mono) / buckets
                    wave = [
                        float(np.max(np.abs(mono[int(i * step):max(int((i + 1) * step), int(i * step) + 1)])))
                        for i in range(buckets)
                    ]
                else:
                    wave = [float(np.max(np.abs(mono)))] * buckets
                with self.lock:
                    self.level = tuple(float(min(1.0, value / 6000.0)) for value in rms)
                    self.wave = wave
                    if self.encoder is not None:
                        self.record_seconds = time.time() - self.record_started
        except Exception as error:
            if not self.stop_event.is_set():
                self.set_status(f"Ошибка: {error}")
        finally:
            if out is not None:
                try:
                    out.stop()
                except Exception:
                    pass
                try:
                    out.close()
                except Exception:
                    pass
            if vout is not None:
                try:
                    vout.stop()
                except Exception:
                    pass
                try:
                    vout.close()
                except Exception:
                    pass
            if sock is not None:
                try:
                    sock.close()
                except Exception:
                    pass
            self.sock = None
            self._close_recording()
            if not self.stop_event.is_set():
                self.set_status("Поток остановлен")

    def _close_recording(self):
        encoder = self.encoder
        file = self.record_file
        self.encoder = None
        self.record_file = None
        if encoder is None or file is None:
            return
        try:
            file.write(encoder.flush())
        except Exception:
            pass
        try:
            file.close()
        except Exception:
            pass


class PhoneAudioApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("ADB Phone Microphone — MultiTool")
        self.geometry("820x520")
        self.configure(bg="#17191d")
        self.worker = AudioWorker()
        self.running = False

        hostapis = sd.query_hostapis()
        self.outputs = []
        for index, device in enumerate(sd.query_devices()):
            if device["max_output_channels"] < 2:
                continue
            hostapi = hostapis[device["hostapi"]]["name"]
            if "WDM-KS" in hostapi:
                continue
            self.outputs.append((index, device["name"]))

        preferred = next(
            (
                index
                for index, name in self.outputs
                if "CABLE In" in name or "CABLE Input" in name
            ),
            None,
        )
        if preferred is None:
            preferred = next(
                (
                    index
                    for index, name in self.outputs
                    if "Realtek" in name and "Digital" not in name
                ),
                None,
            )
        default_output = preferred if preferred is not None else sd.default.device[1]
        if not any(index == default_output for index, _ in self.outputs):
            default_output = self.outputs[0][0] if self.outputs else None

        header = tk.Frame(self, bg="#17191d")
        header.pack(fill="x", padx=18, pady=(16, 4))
        self.status = tk.Label(
            header,
            text="Готов",
            font=("Segoe UI", 13),
            fg="white",
            bg="#17191d",
            anchor="w",
        )
        self.status.pack(side="left", fill="x", expand=True)
        self.timer = tk.Label(
            header,
            text="",
            font=("Segoe UI", 11),
            fg="#7bd88f",
            bg="#17191d",
        )
        self.timer.pack(side="right")

        info = tk.Label(
            self,
            text="Стерео 48 кГц, PCM 16 бит • для прослушивания лучше наушники",
            font=("Segoe UI", 10),
            fg="#a8b0bd",
            bg="#17191d",
            anchor="w",
        )
        info.pack(fill="x", padx=18, pady=(0, 10))

        level_frame = tk.Frame(self, bg="#17191d")
        level_frame.pack(fill="x", padx=18, pady=4)
        self.level_canvas = tk.Canvas(
            level_frame,
            height=32,
            bg="#0b0d10",
            highlightthickness=0,
        )
        self.level_canvas.pack(fill="x")

        controls = tk.Frame(self, bg="#17191d")
        controls.pack(fill="x", padx=18, pady=(12, 6))
        self.start_button = tk.Button(
            controls,
            text="Старт",
            font=("Segoe UI", 11),
            bg="#1e90ff",
            fg="white",
            activebackground="#1676d2",
            relief="flat",
            command=self.toggle_stream,
        )
        self.start_button.pack(side="left", expand=True, fill="x", padx=(0, 5))
        self.record_button = tk.Button(
            controls,
            text="Записать MP3",
            font=("Segoe UI", 11),
            bg="#3a3f47",
            fg="white",
            activebackground="#4a505a",
            relief="flat",
            state="disabled",
            command=self.toggle_recording,
        )
        self.record_button.pack(side="left", expand=True, fill="x", padx=5)
        self.stop_button = tk.Button(
            controls,
            text="Стоп",
            font=("Segoe UI", 11),
            bg="#3a3f47",
            fg="white",
            activebackground="#4a505a",
            relief="flat",
            command=self.stop_all,
        )
        self.stop_button.pack(side="left", expand=True, fill="x", padx=(5, 0))

        options = tk.Frame(self, bg="#17191d")
        options.pack(fill="x", padx=18, pady=(4, 10))
        self.monitor_var = tk.BooleanVar(value=False)
        self.monitor_check = tk.Checkbutton(
            options,
            text="Слушать",
            variable=self.monitor_var,
            font=("Segoe UI", 10),
            fg="white",
            bg="#17191d",
            activebackground="#17191d",
            selectcolor="#17191d",
        )
        self.monitor_check.pack(side="left")
        self.device_var = tk.StringVar()
        labels = [f"{index}: {name}" for index, name in self.outputs]
        if labels:
            self.device_var.set(f"{default_output}: {dict(self.outputs)[default_output]}")
        self.device_menu = tk.OptionMenu(options, self.device_var, *labels)
        self.device_menu.config(
            font=("Segoe UI", 9),
            bg="#252a31",
            fg="white",
            activebackground="#333a44",
            relief="flat",
            highlightthickness=0,
        )
        self.device_menu.pack(side="right", fill="x", expand=True, padx=(12, 0))

        self.file_label = tk.Label(
            self,
            text="",
            font=("Segoe UI", 9),
            fg="#7f8895",
            bg="#17191d",
            anchor="w",
        )
        self.file_label.pack(fill="x", padx=18, pady=(0, 12))

        self.protocol("WM_DELETE_WINDOW", self.close)
        self.after(50, self.update_view)

    def selected_device(self):
        text = self.device_var.get()
        if ":" not in text:
            return None
        try:
            return int(text.split(":", 1)[0])
        except ValueError:
            return None

    def toggle_stream(self):
        if self.running:
            self.stop_stream()
        else:
            self.worker.start(self.monitor_var.get(), self.selected_device())
            self.running = True
            self.start_button.config(text="Стоп")
            self.record_button.config(state="normal")
            self.monitor_check.config(state="disabled")
            self.device_menu.config(state="disabled")

    def stop_stream(self):
        if self.worker.encoder is not None:
            self.worker.stop_recording()
        self.worker.stop()
        self.running = False
        self.start_button.config(text="Старт")
        self.record_button.config(text="Записать MP3", state="disabled")
        self.monitor_check.config(state="normal")
        self.device_menu.config(state="normal")

    def stop_all(self):
        self.stop_stream()
        self.worker.set_status("Остановлено")
        self.file_label.config(text="")

    def toggle_recording(self):
        if not self.running:
            return
        if self.worker.encoder is not None or self.worker.record_active:
            self.worker.stop_recording()
            self.record_button.config(text="Записать MP3")
        else:
            stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            path = RECORDINGS / f"phone-mic-{stamp}.mp3"
            self.worker.start_recording(path)
            self.record_button.config(text="Остановить запись")
            self.file_label.config(text=f"Пишу: {path.name}")

    def update_view(self):
        status, level, recording, seconds, path = self.worker.get_state()
        self.status.config(text=status)
        self.timer.config(text=f"{seconds:0.1f} с" if recording else "")
        self.draw_levels(level)
        if not recording and path and "Запись сохранена" in status:
            self.file_label.config(text=f"Сохранено: {Path(path).name}")
        self.after(50, self.update_view)

    def draw_levels(self, level):
        width = max(1, self.level_canvas.winfo_width())
        self.level_canvas.delete("all")
        for row, value in enumerate(level):
            y0 = 2 + row * 15
            self.level_canvas.create_rectangle(
                0, y0, width, y0 + 11, fill="#1b2027", outline=""
            )
            self.level_canvas.create_rectangle(
                0, y0, int(width * value), y0 + 11,
                fill="#38d978" if value < 0.8 else "#e0b341",
                outline="",
            )

    def close(self):
        self.worker.stop()
        self.destroy()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--adb", default="")
    parser.add_argument("--serial", default="")
    args = parser.parse_args()
    if args.adb:
        ADB = args.adb
    if args.serial:
        SERIAL = args.serial
    PhoneAudioApp().mainloop()

