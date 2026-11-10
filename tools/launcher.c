// launcher.c — тонкий лаунчер: запускает APP\ADB-WiFi-Connector-RU.exe рядом с собой
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <string.h>

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE hPrev, LPWSTR cmdLine, int showCmd)
{
    (void)hInst; (void)hPrev; (void)showCmd;
    WCHAR dir[MAX_PATH];
    DWORD n = GetModuleFileNameW(NULL, dir, MAX_PATH);
    if (n == 0 || n == MAX_PATH) return 1;
    // обрезаем до каталога
    WCHAR *slash = wcsrchr(dir, L'\\');
    if (!slash) return 1;
    *slash = L'\0';
    WCHAR target[MAX_PATH];
    wcscpy(target, dir);
    wcscat(target, L"\\APP\\ADB-WiFi-Connector-RU.exe");
    if (GetFileAttributesW(target) == INVALID_FILE_ATTRIBUTES) {
        MessageBoxW(NULL, L"Не найден файл APP\\ADB-WiFi-Connector-RU.exe\r\nРаспакуйте архив целиком.", L"ADB Wi-Fi Коннектор", MB_ICONERROR);
        return 1;
    }
    SHELLEXECUTEINFOW sei;
    memset(&sei, 0, sizeof(sei));
    sei.cbSize = sizeof(sei);
    sei.fMask = SEE_MASK_NOASYNC;
    sei.lpVerb = L"open";
    sei.lpFile = target;
    sei.lpParameters = cmdLine && cmdLine[0] ? cmdLine : NULL;
    sei.lpDirectory = dir;
    sei.nShow = SW_SHOWNORMAL;
    if (!ShellExecuteExW(&sei)) {
        MessageBoxW(NULL, L"Не удалось запустить приложение. Возможно, сработал SmartScreen:\r\nнажмите «Подробнее» → «Выполнить в любом случае».", L"ADB Wi-Fi Коннектор", MB_ICONWARNING);
        return 1;
    }
    return 0;
}
