# camera — камера и микрофон с телефона

Здесь лежит всё, что нужно для вкладок «Веб-камера» и «Микрофон»: Python-серверы,
исходники виртуальной камеры Windows, Android-приложение и подписанный драйвер VB-CABLE.

## Что где

- `phonecam_server.py`, `PhoneAudio.py`, `phoneaudio_server.py`, `PhoneCamViewer.py` —
  Python-серверы, которые запускает `main.js`.
- `win-audio.ps1` — настройка аудиоустройств Windows.
- `bin/PhoneVirtualCam.exe`, `bin/VirtualCameraSource.dll` — готовая виртуальная камера
  Windows (собрана из `src/`).
- `src/` — C++ исходники виртуальной камеры.
- `android-cam/` — исходник APK для телефона (`CamService.java`, `AudioService.java`).
- `android-cam.apk` — готовая сборка для установки на телефон.
- `drivers/VBCABLE/` — сторонний подписанный драйвер VB-CABLE; не изменяйте его.

## Сборка виртуальной камеры

Нужны Visual Studio Build Tools с компонентом C++ (x64). По умолчанию скрипт ищет
`C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat`; другой путь задайте через `VCVARS64`.

```powershell
cd camera
powershell -ExecutionPolicy Bypass -File .\build-virtualcam.ps1
```

Скрипт пересобирает `bin/PhoneVirtualCam.exe` и `bin/VirtualCameraSource.dll`.
Промежуточные `.obj/.lib/.exp` в репозиторий не попадают.

## Сборка Android-приложения

Нужны JDK 21 (`JAVA_HOME`) и Android SDK с build-tools и platform (`ANDROID_HOME`
или `ANDROID_SDK_ROOT`; иначе берётся `%LOCALAPPDATA%\Android\Sdk`).

```powershell
cd camera
powershell -ExecutionPolicy Bypass -File .\build-android.ps1
```

Скрипт собирает `camera/android-cam.apk`. На Linux/macOS можно использовать
`camera/android-cam/build.sh` — он собирает APK внутри `android-cam/` и копирует
результат в `camera/android-cam.apk`.

APK подписан debug-ключом, который создаётся при первой сборке. Если после пересборки
`adb install -r` жалуется на несовпадение подписи, удалите старое приложение:

```bash
adb uninstall com.officialdad.androidcam
```

## Драйвер VB-CABLE

`drivers/VBCABLE/` — распакованный сторонний драйвер VB-CABLE. Он подписан
производителем; не пересобирайте и не изменяйте файлы. Условия распространения —
в `drivers/VBCABLE/readme.txt`.
