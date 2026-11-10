# Сборка и редактирование ADB Wi-Fi Коннектор (RU)

## Быстрые правки БЕЗ пересборки (рекомендуется)

Вся логика приложения лежит в виде обычного JS:

- `APP/resources/app/main.js` — главный процесс (окно, трей, IPC, adb-команды)
- `APP/resources/app/adb.js` — обёртка над adb.exe
- `APP/resources/app/mdns.js` — обнаружение mDNS
- `APP/resources/app/preload.js` — мост renderer↔main
- `APP/resources/app/renderer/` — интерфейс (index.html, styles.css, app.js, lib/jsQR.js)
- `APP/resources/app/package.json` — версия приложения

Отредактируйте файл и перезапустите `ADB-WiFi-Connector-RU.exe` (корневой лаунчер).
Пересборка не нужна: Electron читает эти файлы при каждом запуске.

## Полный цикл пересборки (Linux)

1. Node.js >= 22: `bash tools/bootstrap-rea.sh` поставит Node 22 в /tmp/node22 (или свой node).
2. Зависимости времени разработки: `npm i resedit jsqr` (resedit — правка иконки/версии exe).
3. Скачать runtime Electron для Windows:
   `https://github.com/electron/electron/releases/download/v33.4.11/electron-v33.4.11-win32-x64.zip`
   распаковать в каталог `APP/`; удалить `APP/resources/default_app.asar`.
4. Уложить приложение: скопировать `main.js adb.js mdns.js preload.js package.json renderer/ assets/`
   в `APP/resources/app/`; скопировать adb (platform-tools: adb.exe, AdbWinApi.dll, AdbWinUsbApi.dll)
   в `APP/resources/adb/`; scrcpy (win64) — в `APP/resources/scrcpy/`.
5. Заменить иконку и version-info у `APP/electron.exe`:
   `NODE_PATH=<путь к node_modules> node tools/patch-icon.js APP/electron.exe assets/icon.ico APP/ADB-WiFi-Connector-RU.exe`
   затем удалить `APP/electron.exe`.
6. Лаунчер в корне: `x86_64-w64-mingw32-windres tools/launcher.rc -o launcher.o &&
   x86_64-w64-mingw32-gcc -mwindows -municode -O2 tools/launcher.c launcher.o -o ADB-WiFi-Connector-RU.exe -lshell32 -luser32`
   (нужен пакет gcc-mingw-w64-x86-64).
7. Упаковать: zip всей папки (см. структуру в README-RU.md).

## Журнал

`app.log` в корне папки: старт, путь adb, результаты сканов/подключений/сопряжений,
ошибки рендера. Прикладывайте его к багрепортам.

## Внешние компоненты и лицензии

- Electron (MIT), jsQR (MIT), scrcpy (Apache-2.0), adb = Android SDK Platform-Tools (лицензия Google).
- Код этой сборки — MIT.
