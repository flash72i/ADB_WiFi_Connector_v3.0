# MCP-сервер «ADB Wi-Fi Коннектор» (v2.11)

Встроенный MCP-сервер для ИИ-агента. Даёт агенту два режима управления программой:
**визуальный** (интерфейс) и **прямой** (логика + полный доступ к устройству), без участия человека.

## Как включить

1. Запустите приложение.
2. Настройки → «Управление агентом (MCP)» → включите тумблер «Управление агентом включено».
3. Сервер слушает `http://127.0.0.1:3939/mcp` (порт меняется аргументом `--mcp-port=NNNN`).
4. Если задана переменная окружения `MCP_TOKEN` — агент должен слать заголовок
   `Authorization: Bearer <токен>`.

Аварийная остановка: кнопка «■ Аварийно остановить агента» в Настройках
или метод `cancel_task` c id `all`.

## Обнаружение любым агентом

При запуске сервер создаёт файл-дескриптор
`%APPDATA%\ADB Wi-Fi Коннектор\mcp-endpoint.json` — в нём endpoint, версия, список
ключевых инструментов и подсказки по включению. Любой агент (Claude Code, Codex,
Cursor, OpenCode и т.п.) может найти программу по этому файлу, прочитать
`GET /mcp` и сразу начать работу. `describe_capabilities` возвращает
самоописание возможностей в структурированном виде.

## Протокол

- `GET /mcp` — описание, список tools и функций, discovery-блок.
- `GET /mcp/schema` — JSON Schema инструментов (для MCP-клиентов).
- `POST /mcp` — JSON-RPC 2.0:
  - `tools/list` — список tools;
  - `tools/call` — вызов tool, параметры в `params.arguments`;
  - `agent/set-enabled` — включить/выключить управление (`{enabled: bool}`);
  - `agent/stop` — аварийная остановка;
  - `ping` — проверка соединения.

## Режим 1 — визуальное управление (UI)

| tool | назначение |
|---|---|
| `get_app_window` | список окон программы |
| `get_ui_tree` | дерево интерфейса: разделы, кнопки, поля, координаты, доступность |
| `get_active_tab` | активный раздел и экран |
| `click_element` | клик по id/тексту/селектору |
| `double_click_element` | двойной клик |
| `right_click_element` | контекстное меню |
| `hover_element` | наведение курсора |
| `scroll` | прокрутка up/down/left/right/top/bottom, `px` |
| `set_text` | ввод текста в поле |
| `clear_text` | очистка поля |
| `select_option` | выбор пункта в `<select>` |
| `set_checkbox` | установить/снять галочку |
| `select_tab` | переключение раздела/вкладки по названию |
| `open_window` | открыть раздел |
| `close_window` | закрыть диалог/окно |
| `drag_and_drop` | перетаскивание в координаты |
| `read_element` | текст/значение/состояние элемента |
| `read_table` | строки и колонки таблиц/списков |
| `wait_for_element` | ожидание появления/исчезновения/изменения (opts.timeoutMs, opts.mode, opts.until) |
| `take_screenshot` | скриншот окна/элемента (base64 PNG + файл) |
| `get_visual_state` | скриншот + текстовое описание интерфейса |

## Режим 2 — прямое управление (логика)

| tool | назначение |
|---|---|
| `get_app_state` | активное устройство, вкладка, настройки, задачи |
| `call_app_function` | вызов внутренней функции (см. список ниже) |
| `run_command` | синоним call_app_function |
| `get_task_list` / `cancel_task` | реестр задач, отмена (id=all — стоп) |
| `get_logs` / `get_errors` | журнал программы и ошибки |
| `set_setting` / `get_setting` | настройки (белый список ключей) |
| `connect_device` / `disconnect_device` | подключение/отключение устройства |
| `execute_device_action` | действие с телефоном (обёртка над функциями) |

Доступные функции (`call_app_function`): `adbDevices`, `adbConnect`, `adbDisconnect`,
`adbPing`, `appsList`, `appsRun`, `appsAction`, `fsList`, `fsCat`, `procsList`,
`procsKill`, `devFull`, `logcat`, `settingsGet`, `usbRestart`, `mirror`,
`adbShell`, `adbRaw`, `settingsCmd`, `settingsList`, `inputTap`, `inputSwipe`,
`inputKey`, `inputText`, `inputKeyCombo`, `deviceScreenshot`, `pkgInfo`,
`findPackages`, `installApk`, `pullFile`, `pushFile`, `rebootDevice`.

## Полный доступ к устройству (v2.11)

| tool | назначение |
|---|---|
| `adb_shell` | ЛЮБАЯ shell-команда: `pm`, `settings`, `cmd`, `dumpsys`, `am`, `service call`, `input`… |
| `adb_raw` | произвольные аргументы adb: `push`, `pull`, `install`, `forward`, `reboot` |
| `device_settings` | скрытые настройки Android: `op=get/put/list`, `ns=global/secure/system` |
| `device_input` | ввод на телефоне: `tap`, `swipe`, `text`, `key`, `combo` |
| `device_screenshot` | снимок экрана ТЕЛЕФОНА в PNG (в «Сохранения\Агент») |
| `app_action` | `disable`, `enable`, `restore`, `uninstall`, `clear`, `clearCache`, `forceStop`, `run`, `phoneInfo` |
| `pkg_info` | версия, код, путь APK, даты установки, установлен ли |
| `find_packages` | поиск пакетов по подстроке |
| `install_apk` | установка APK с ПК (push + `pm install -r -g`) |
| `pull_file` / `push_file` | скачать/загрузить файл |
| `reboot_device` | перезагрузка: `system`/`bootloader`/`recovery`/`sideload` |
| `unlock_device` | разблокировать телефон сохранённым паролем: пробуждение → свайп → PIN → Enter (`step`: `full`/`wake`/`swipe`/`type`) |
| `unlock_status` | сохранён ли пароль для устройства (сам пароль не возвращается, только длина) |
| `unlock_set` | сохранить PIN/пароль разблокировки (шифруется Windows DPAPI, открытым текстом на диск не пишется) |
| `unlock_delete` | удалить сохранённый пароль устройства |
| `describe_capabilities` | самоописание всех возможностей |
| `run_js` | произвольное JS-выражение в окне программы (диагностика) |

**serial можно не указывать** — подставится активное устройство или первое живое
из `adb devices`.

### Отключение системных приложений (как в ADB AppControl)

`app_action("disable", "com.miui.videoplayer")` сам выбирает рабочий способ:
сначала `pm disable-user --user 0`, а если прошивка отвечает
`Cannot disable system packages` — `pm uninstall -k --user 0`
(обратимо: `app_action("restore", pkg)` → `cmd package install-existing --user 0`).
<br>Проверено на POCO F6 / HyperOS: отключение и восстановление работают.

## Примеры

### 1. Состояние программы

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_app_state","arguments":{}}}
```
Ответ:
```json
{"jsonrpc":"2.0","id":1,"result":{"ok":true,"activeSerial":"192.0.2.42:5555","pages":["devices","tools","files","apps","apk","settings"],"config":{"theme":"dark"},...}}
```

### 2. Перейти на вкладку «Файлы» и прочитать список

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"select_tab","arguments":{"p":"Файлы"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_table","arguments":{"p":"page-files"}}}
```

### 3. Ввести текст в поле поиска приложений

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"set_text","arguments":{"p":"#apps-search","text":"избранное"}}}
```

### 4. Скриншот

```json
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"take_screenshot","arguments":{}}}
```
Ответ: `data` (base64 PNG), `file` (путь), `bytes`.

### 5. Автоустановка последнего APK из /sdcard/Download (сценарий из ТЗ)

```json
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"call_app_function","arguments":{"name":"fsList","params":{"serial":"192.0.2.42:5555","path":"/sdcard/Download"}}}}
```
→ выбрать последний `.apk` → `call_app_function` → `adbConnect` при необходимости,
затем UI-очередь установки или `appsAction`-подобные операции, `get_logs` для проверки.

## Ошибки

Все ошибки возвращаются как `{ok:false, error:"причина"}` внутри `result`.
Типовые: «Окно программы закрыто», «Элемент не найден: …», «Управление агентом выключено»,
«Остановлено аварийной кнопкой», «Tool не найден: …».

## Логирование

Все действия агента пишутся в `%APPDATA%\ADB Wi-Fi Коннектор\agent-log.json`
и доступны через `get_logs`. Программный журнал — в `app.log` рядом с программой.

## План тестирования

1. Клики: `click_element` по кнопке, по тексту, по координатам; `wait_for_element` после нажатия.
2. Вкладки: `select_tab` по названию с эмодзи-иконкой («Настройки», «Подключение») и по `data-page`.
3. Прокрутка: `scroll` up/down/top/bottom на страницах «Файлы», «Приложения».
4. Поля: `set_text`/`clear_text` в `#apps-search`, `#in-ip`, `#fs-path`; `select_option` в селекторах.
5. Таблицы: `read_table` на `#device-list`, `#fs-list`, `#apps-list`, `#hist-list`.
6. Скриншоты: `take_screenshot` всего окна и элемента; `get_visual_state`.
7. Прямые команды: `get_app_state`, `adbDevices`, `fsList`, `procsList`, `get_logs`, `get_errors`.
8. Восстановление после ошибок: выключенный тумблер → понятная ошибка;
   `cancel_task("all")` останавливает серию; `agent/reset` снимает флаг остановки.