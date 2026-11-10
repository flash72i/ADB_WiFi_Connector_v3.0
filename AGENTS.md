# AGENTS.md — ADB Wi-Fi Connector RU 3.0

Инструкция для агента (и человека), который будет менять проект.
Читать целиком перед правками. Все пути ниже — относительно этой папки (`ADB_WiFi_Connector_v3.0`),
если не указано иное.

## 1. Что это за проект

- **Приложение**: Electron-программа «ADB Wi-Fi Коннектор» для Windows x64 —
  беспроводная отладка Android по Wi-Fi (adb + scrcpy), русский интерфейс.
- **Установщик**: собственный установщик на C#/WinForms (`installer/src`),
  один EXE с двумя режимами: установка в `C:\Program Files\ADB Wi-Fi Connector`
  для всех пользователей и портативная распаковка рядом с установщиком.
- **Версия продукта**: 3.0. Версия приложения берётся из `package.json`
  (`app.getVersion()`), версия установщика — из строк в `Installer.cs`.

## 2. Структура

```
ADB_WiFi_Connector_v3.0/
  package.json            версия приложения (3.0)
  main.js                 главный процесс Electron
  adb.js                  обёртка над adb.exe
  mdns.js                 обнаружение mDNS
  preload.js              мост renderer ↔ main
  agent-mcp.js            MCP-сервер (порт 3939)
  apkicon.js, apkmini…    разбор APK/иконок
  renderer/               интерфейс: index.html, styles.css, app.js, lib/
  assets/                 иконки приложения
  shellext/               готовая оболочка Explorer (DLL + лицензии)
  tools/                  launcher.c, launcher.rc, patch-icon.js
  README-BUILD.md         исходная инструкция сборки приложения (Linux-цикл)
  README-RU.md            описание продукта, версия 3.0

  installer/
    src/Installer.cs      весь UI и логика установщика
    src/Uninstaller.cs    удаление программы
    src/app.manifest      requireAdministrator
    bin/                  icon.ico; остальное создаётся при сборке
    preview/              6 PNG-экранов установщика (генерируются)
    design/               утверждённый HTML-макет v2

  release/
    ADB_WiFi_Connector_v3.0.exe   готовый установщик (126 МБ)

  AGENTS.md               этот файл
  .gitignore
  .gitattributes          Git LFS для exe/dll/zip
```

Рядом с `ADB_WiFi_Connector_v3.0` (в родительской папке пакета) лежит собранное приложение:
`APP/`, лаунчер `ADB-WiFi-Connector-RU.exe`, `README-RU.md`. Установщик собирается
из этой родительской папки; `ADB_WiFi_Connector_v3.0` — только исходники.

## 3. Инструменты

| Задача | Инструмент |
|---|---|
| Компиляция установщика | `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` (C# 5) |
| Упаковка payload | `C:\Windows\System32\tar.exe` (bsdtar) + `System.IO.Compression` |
| Сборка/правка приложения | Node.js 22, npm, Electron 33.4.11 win32-x64, `resedit` |
| Git + большие файлы | `git`, `git-lfs` (установлен, версия 3.7+) |
| Проверка картинок | PowerShell + `System.Drawing` |

Чего **нет** и не нужно искать: Inno Setup, NSIS, 7-Zip. Установщик — свой.
`npm.ps1` может быть заблокирован ExecutionPolicy — использовать `npm.cmd` или `node`.

## 4. Приложение: как менять

- Версия читается из `package.json` через `app.getVersion()` (main.js, обработчик
  `state:get`). В интерфейсе версия намеренно скрыта (`#tb-version` очищается).
- **Быстрая правка без пересборки**: изменить файлы в `ADB_WiFi_Connector_v3.0` и скопировать
  изменённые файлы в `..\APP\resources\app\` (та же структура). Перезапустить
  `ADB-WiFi-Connector-RU.exe` из родительской папки. Electron читает JS при старте.
- **Полная пересборка приложения** — по `README-BUILD.md`: Node 22, Electron
  33.4.11 win32-x64, `npm i resedit jsqr`, `tools/patch-icon.js`, mingw-лаунчер.
  Учтите: в этой папке нет `tools/bootstrap-rea.sh`, а цикл описан для Linux.
  На Windows проще собрать установщик из уже готового `..\APP`.
- Метаданные `APP\ADB-WiFi-Connector-RU.exe` и лаунчера — 2.7.2 (косметика).
  Версия продукта от них не зависит; не гоняться за ними без запроса.

- **Сохранения**: `BASE_DIR` — папка лаунчера (`dirname(process.execPath)`; если она
  называется `APP`, берётся родительская). Папка `Сохранения` создаётся при каждом
  старте (`ensureDirs`) рядом с лаунчером: в портативной версии — в папке программы,
  при установке — в `C:\Program Files\ADB Wi-Fi Connector\Сохранения`. Внутри:
  `config.json`, `history.json` (до 50 устройств), `favorites.json`, `saved.json`,
  `Мои команды.json`, `unlock.json` (DPAPI-шифр), `Захваты\`, `Агент\`, `labels-*.json`.

## 5. Установщик: архитектура

- Один EXE: `Setup.exe` + ZIP-payload, дописанный в конец файла.
  Формат хвоста: ASCII `ADBWIFISETUP0001` (16 байт) + `int64` длина payload
  (little-endian). `Payload` читает последние 24 байта и открывает ZIP.
- `Installer.cs` — owner-drawn WinForms: шаги 0 (режим), 1 (параметры установки),
  2 (прогресс), 3 (готово), 4 (портативная папка), 6 (готово портативно).
  Ключевые методы: `BeginInstall`, `InstallOps`, `Payload.ExtractAll`, `Preview`.
- Установка: `Program Files\ADB Wi-Fi Connector`, ключ
  `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\ADBWiFiConnector`,
  ярлыки в `CommonDesktopDirectory` и `CommonPrograms`, автозапуск в `HKCU\...\Run`,
  `icacls`-грант группе «Пользователи» на папку (запись «Сохранений»),
  запуск приложения через `explorer.exe` (без наследования elevation).
- Портативный режим: распаковка в папку рядом с установщиком (по умолчанию).
- `Uninstaller.exe`: копирует себя в `%TEMP%`, запускает `/cleanup` и удаляет
  папку установки; чистит реестр и общие ярлыки.
- Служебные режимы: `/extract "<папка>"` — только распаковать payload;
  `/preview "<папка>"` — отрисовать 6 PNG без запуска установки.
- `SetupTest.exe` — та же сборка **без** манифеста администратора: используется
  для превью и тестов, чтобы не вызывать UAC. Итоговый `Setup.exe` — с манифестом.

## 6. Сборка установщика (Windows PowerShell)

Открыть PowerShell в `ADB_WiFi_Connector_v3.0` (рядом с этим файлом):

```powershell
$SRC   = (Get-Location).Path
$INST  = Join-Path $SRC "installer"
$BIN   = Join-Path $INST "bin"
$REL   = Join-Path $SRC "release"
$APPROOT = Split-Path -Parent $SRC          # папка с APP и лаунчером
$CSC = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$REFS = @("/r:System.dll","/r:System.Core.dll","/r:System.Drawing.dll",
          "/r:System.Windows.Forms.dll","/r:System.IO.Compression.dll",
          "/r:System.IO.Compression.FileSystem.dll")
```

### 6.1. Uninstall.exe

```powershell
& $CSC /nologo /target:winexe /platform:x64 /optimize+ `
  "/win32icon:$BIN\icon.ico" "/win32manifest:$INST\src\app.manifest" `
  "/out:$BIN\Uninstall.exe" @REFS "$INST\src\Uninstaller.cs"
```

### 6.2. Setup.exe (с манифестом) и SetupTest.exe (без манифеста)

```powershell
& $CSC /nologo /target:winexe /platform:x64 /optimize+ `
  "/win32icon:$BIN\icon.ico" "/win32manifest:$INST\src\app.manifest" `
  "/resource:$BIN\icon.ico,ADBWiFiSetup.icon.ico" `
  "/out:$BIN\Setup.exe" @REFS "$INST\src\Installer.cs"

& $CSC /nologo /target:winexe /platform:x64 /optimize+ `
  "/win32icon:$BIN\icon.ico" `
  "/resource:$BIN\icon.ico,ADBWiFiSetup.icon.ico" `
  "/out:$BIN\SetupTest.exe" @REFS "$INST\src\Installer.cs"
```

### 6.3. payload.zip

Собирается из родительской папки: `APP`, лаунчер, `README-RU.md`; затем в ZIP
добавляется `Uninstall.exe`.

```powershell
& "$env:SystemRoot\System32\tar.exe" -a -c -f "$BIN\payload.zip" `
  -C $APPROOT APP ADB-WiFi-Connector-RU.exe README-RU.md

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open(
  "$BIN\payload.zip", [System.IO.Compression.ZipArchiveMode]::Update)
[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
  $zip, "$BIN\Uninstall.exe", "Uninstall.exe",
  [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
$zip.Dispose()
```

Ожидается 143 записи, ~126 МБ; в корне ZIP — `APP/`, лаунчер, `README-RU.md`,
`Uninstall.exe`. Никаких `Сохранения/`, `app.log`, `config.json` там быть не должно.

### 6.4. Финальный EXE

```powershell
$payload = "$BIN\payload.zip"
$len = (Get-Item -LiteralPath $payload).Length
$VER = (Get-Content "$SRC\package.json" -Raw | ConvertFrom-Json).version
$final = "$REL\ADB_WiFi_Connector_v$VER.exe"
Copy-Item -LiteralPath "$BIN\Setup.exe" -Destination $final -Force
$fs = [System.IO.File]::Open($final, [System.IO.FileMode]::Append)
$srcZip = [System.IO.File]::OpenRead($payload)
$srcZip.CopyTo($fs); $srcZip.Dispose()
$fs.Write([System.Text.Encoding]::ASCII.GetBytes('ADBWIFISETUP0001'), 0, 16)
$fs.Write([BitConverter]::GetBytes([Int64]$len), 0, 8)
$fs.Close()
Get-FileHash -LiteralPath $final -Algorithm SHA256
```

### 6.5. Превью

```powershell
& "$BIN\SetupTest.exe" /preview "$INST\preview"
```

`Preview.Run` подставляет нейтральные пути (`C:\Program Files\ADB Wi-Fi Connector`
и `D:\ADB-WiFi-Connector`), чтобы в PNG не попадали имена пользователей.
Не удалять этот вызов при правках превью.

### 6.6. Проверка распаковки

Собрать тестовый EXE (SetupTest + payload) и распаковать:

```powershell
$test = "$BIN\SetupTestPayload.exe"
Copy-Item "$BIN\SetupTest.exe" $test -Force
# дописать payload и хвост тем же способом, что в 6.4, затем:
& $test /extract "$env:TEMP\adbwifi-check"
```

Ожидается: 133 файла, ~306 МБ, `APP\resources\app\package.json` с `"version": "3.0"`,
`README-RU.md` с заголовком «версия 3.0». После проверки временную папку удалить.

## 7. Выпуск новой версии (например, 3.1)

1. `package.json` — `"version"`.
2. `..\APP\resources\app\package.json` — та же версия (её читает `app.getVersion()`).
3. `README-RU.md` в этой папке и в родительской (попадает в payload): заголовок
   с новой версией. Changelog-разделов в README нет.
4. `installer\src\Installer.cs` — три строки:
   - `DisplayVersion` в `InstallOps.Register`;
   - `Txt(g, "v3.0-setup", …)` в шапке;
   - `Txt(g, "v3.0", …)` в статус-баре.
5. Имя файла: `release\ADB_WiFi_Connector_v<version>.exe`, где `<version>` — поле
   `version` из `package.json`.
6. Пересобрать: payload (6.3) → Setup/SetupTest (6.2) → финальный EXE (6.4) →
   превью (6.5) → проверка (6.6).

Проверка, что старых версий не осталось:

```powershell
Get-ChildItem -Recurse -File -Include *.js,*.json,*.md,*.cs,*.html |
  Select-String "2\.8\.0|3\.0"
```

## 8. Личные данные и публикация на GitHub

Правила жёсткие: репозиторий публичный.

- **Нельзя** коммитить: `C:\Users\<имя>`, реальные serial/IP устройств, e-mail,
  токены, `app.log`, `Сохранения/`, `config.json`, скриншоты с путями пользователя.
- Примеры IP — только документационные: `192.0.2.42:5555` (TEST-NET-1, диапазон `192.0.2.0/24`).
- Превью установщика обязаны использовать `PreviewSetPaths(...)`; иначе в PNG
  попадёт путь вида `C:\Users\<имя>\Downloads\...`.
- Быстрая проверка перед коммитом:

```powershell
Get-ChildItem -Recurse -File -Include *.js,*.html,*.json,*.md,*.cs,*.txt,*.c,*.rc |
  Where-Object { $_.FullName -notmatch "\\shellext\\" -and $_.Name -ne "AGENTS.md" } |
  Select-String "C:\\Users|192\.168\.|@gmail|@yandex|api[_-]?key|secret"
```

- **Git LFS**: `.gitattributes` отправляет `*.exe`, `*.dll`, `*.zip` в LFS.
  Один раз выполнить `git lfs install`. GitHub не принимает файлы >100 МБ
  обычным способом; LFS-квота бесплатного аккаунта — 1 ГБ хранилища и трафика.
  В репозитории ~126 МБ LFS: `release\...Setup.exe`. `payload.zip` создаётся
  при сборке и в git не хранится (исключён в `.gitignore`).
- **APP не дублируется** в репозитории: он уже внутри `release\...Setup.exe`
  и лежит в родительской папке для сборки. Если понадобится положить APP в git —
  только осознанно, через LFS (≈306 МБ, квота расходуется).
- `installer\bin\` — только `icon.ico`; остальное создаётся при сборке.

## 9. Чек-лист перед выдачей

- [ ] `SetupTest.exe /preview` отрисовал 6 PNG; в шапке `v3.0-setup`, в статусе `v3.0`.
- [ ] Окно по центру; X закрывает сразу; лицензия открывается/закрывается.
- [ ] Иконка в панели задач совпадает с иконкой программы.
- [ ] Портативный путь по умолчанию — рядом с установщиком.
- [ ] `/extract` даёт 133 файла / ~306 МБ; версия в `package.json` — 3.0.
- [ ] В `payload.zip` нет `Сохранения/`, `app.log`, `config.json`.
- [ ] Поиск личных данных (раздел 8) ничего не находит.
- [ ] SHA-256 финального EXE записан в ответ/README.

## 10. Известные ограничения

- Итоговый `Setup.exe` помечен `requireAdministrator`: UAC появится и при
  портативной распаковке. Если это мешает — нужна отдельная сборка без манифеста
  либо самоэлевация только для режима установки (задача на будущее).
- Метаданные лаунчера и `APP\...exe` — 2.7.2; версия продукта берётся из
  `package.json` и строк установщика.
- Полный цикл сборки приложения описан для Linux и требует Electron/Nodes;
  на этой машине проверена только сборка установщика вокруг готового `APP`.
- Внешняя папка пакета сохранила старое имя дистрибутива; это не версия
  продукта. При выпуске 3.0 её можно переименовать.
