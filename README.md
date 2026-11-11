# ADB Wi-Fi Connector RU 3.0

> [!CAUTION]
> **Бета-версия.** Возможны ошибки и нестабильная работа. Функциональность и дальнейшая разработка могут измениться или быть приостановлены. Используйте на свой риск.

Русская программа для Windows, которая подключается к Android-телефону по Wi-Fi и позволяет управлять им с компьютера: файлы и приложения, экран и управление, терминал adb. Root не нужен — используется официальный adb. Без рекламы и пробного периода.

## Скачать

**[ADB_WiFi_Connector_v3.0.exe](https://github.com/flash72i/ADB_WiFi_Connector_v3.0/releases/latest/download/ADB_WiFi_Connector_v3.0.exe)** — Windows 10/11 x64, 128 МБ.

Установщик предлагает два режима: установить программу в систему или распаковать portable-версию в выбранную папку.

## Программа

![Обзор экранов ADB Wi-Fi Connector RU](docs/screenshots/overview.gif)

<sub>Подключение → Инструменты → Файлы → Приложения → Установка APK → Веб-камера → Микрофон → Настройки. Смена кадра каждые 2 секунды.</sub>

<details>
<summary>Отдельные скриншоты</summary>

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/app-main.png" alt="Подключение"></td>
    <td width="50%"><img src="docs/screenshots/02-tools.png" alt="Инструменты"></td>
  </tr>
  <tr>
    <td align="center"><sub>Подключение</sub></td>
    <td align="center"><sub>Инструменты</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/03-files.png" alt="Файлы"></td>
    <td width="50%"><img src="docs/screenshots/04-apps.png" alt="Приложения"></td>
  </tr>
  <tr>
    <td align="center"><sub>Файлы</sub></td>
    <td align="center"><sub>Приложения</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/05-apk.png" alt="Установка APK"></td>
    <td width="50%"><img src="docs/screenshots/06-camera.png" alt="Веб-камера"></td>
  </tr>
  <tr>
    <td align="center"><sub>Установка APK</sub></td>
    <td align="center"><sub>Веб-камера</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/07-mic.png" alt="Микрофон"></td>
    <td width="50%"><img src="docs/screenshots/08-settings.png" alt="Настройки"></td>
  </tr>
  <tr>
    <td align="center"><sub>Микрофон</sub></td>
    <td align="center"><sub>Настройки</sub></td>
  </tr>
</table>
</details>

## Что умеет

- Подключение по Wi-Fi: QR-код, IP:порт, mDNS; история и избранное устройств.
- Файлы телефона: просмотр, скачивание и загрузка, переименование, удаление, ZIP-архивы, просмотр DOCX и контактов VCF, работа с USB/OTG-флешками.
- Приложения: список, установка APK, запуск и остановка, очистка данных и кэша.
- Экран и управление: scrcpy, скриншоты, запись видео, буфер обмена.
- Веб-камера и микрофон телефона на компьютере через ADB.
- Терминал adb и MCP-сервер для ИИ-агентов.
- Иконки APK в Проводнике Windows.

## Установщик

<table>
  <tr>
    <td width="50%"><img src="installer/preview/01-mode.png" alt="Выбор режима"></td>
    <td width="50%"><img src="installer/preview/02-install-options.png" alt="Параметры установки"></td>
  </tr>
  <tr>
    <td align="center"><sub>Выбор режима: установка или portable</sub></td>
    <td align="center"><sub>Параметры установки</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="installer/preview/05-portable-options.png" alt="Параметры portable-версии"></td>
    <td width="50%"><img src="installer/preview/06-portable-done.png" alt="Portable-версия готова"></td>
  </tr>
  <tr>
    <td align="center"><sub>Параметры portable-версии</sub></td>
    <td align="center"><sub>Portable-версия готова</sub></td>
  </tr>
</table>

## Как подключить

1. На телефоне: «Для разработчиков» → «Беспроводная отладка».
2. Телефон и компьютер — в одной сети Wi-Fi; сеть Windows должна быть «Частной».
3. В программе: «QR-код на телефон» или ввести IP:порт с экрана отладки. При первом подключении телефон попросит сопряжение.

## Состав репозитория

- `main.js`, `adb.js`, `mdns.js`, `preload.js`, `qrpair.js` — основная логика приложения (Electron).
- `renderer/` — интерфейс: HTML, CSS, JS.
- `camera/` — камера и микрофон: Python-серверы, C++ исходники виртуальной камеры, Android-приложение и драйвер VB-CABLE.
- `installer/src/` — установщик на C#/WinForms.
- `shellext/` — расширение Проводника Windows.
- `tools/` — лаунчер и служебные скрипты.
- `installer/preview/`, `docs/screenshots/` — скриншоты.
- `README-BUILD.md`, `AGENTS.md` — сборка и правила проекта.

## Сборка

Кратко: Electron 33, официальный adb и scrcpy. Установщик собирается из `installer/src` компилятором C# (`csc.exe`). Подробности — в `README-BUILD.md` и `AGENTS.md`.

## Лицензия

Код этой сборки — MIT. adb — Android SDK Platform-Tools (© Google), scrcpy — Apache-2.0. VB-CABLE — сторонний подписанный драйвер, условия — в `camera/drivers/VBCABLE/readme.txt`. Лицензии сторонних компонентов лежат в `shellext/` и описаны в `README-BUILD.md`.
