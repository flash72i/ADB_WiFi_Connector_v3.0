#include <sdkddkver.h>
#ifndef WINVER
#define WINVER NTDDI_WIN10_CO
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT NTDDI_WIN10_CO
#endif

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mfapi.h>
#include <mfvirtualcamera.h>
#include <cstdio>
#include <cstdlib>

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "mfsensorgroup.lib")
#pragma comment(lib, "ole32.lib")

static const wchar_t* kCameraName = L"ADB Phone Camera";
static const wchar_t* kSourceId = L"{7E7B7A4C-2E6B-4C1A-9D3F-9B7A6E2F1C01}";

static void PrintHr(const wchar_t* step, HRESULT hr)
{
    wprintf(L"%s: 0x%08X\n", step, static_cast<unsigned int>(hr));
}

int wmain(int argc, wchar_t** argv)
{
    int seconds = 0;
    for (int i = 1; i < argc; i++)
    {
        if (wcscmp(argv[i], L"--seconds") == 0 && i + 1 < argc)
        {
            seconds = _wtoi(argv[++i]);
        }
    }

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr))
    {
        PrintHr(L"CoInitializeEx", hr);
        return 1;
    }

    hr = MFStartup(MF_VERSION, MFSTARTUP_FULL);
    if (FAILED(hr))
    {
        PrintHr(L"MFStartup", hr);
        CoUninitialize();
        return 1;
    }

    BOOL supported = FALSE;
    hr = MFIsVirtualCameraTypeSupported(MFVirtualCameraType_SoftwareCameraSource, &supported);
    if (FAILED(hr) || !supported)
    {
        wprintf(L"Virtual camera type is not supported (hr=0x%08X, supported=%d)\n",
            static_cast<unsigned int>(hr), supported);
        MFShutdown();
        CoUninitialize();
        return 2;
    }

    IMFVirtualCamera* camera = nullptr;
    hr = MFCreateVirtualCamera(
        MFVirtualCameraType_SoftwareCameraSource,
        MFVirtualCameraLifetime_Session,
        MFVirtualCameraAccess_CurrentUser,
        kCameraName,
        kSourceId,
        nullptr,
        0,
        &camera);
    if (FAILED(hr))
    {
        PrintHr(L"MFCreateVirtualCamera", hr);
        MFShutdown();
        CoUninitialize();
        return 3;
    }

    hr = camera->Start(nullptr);
    if (FAILED(hr))
    {
        PrintHr(L"IMFVirtualCamera::Start", hr);
        camera->Release();
        MFShutdown();
        CoUninitialize();
        return 4;
    }

    wprintf(L"Virtual camera started: %s\n", kCameraName);
    wprintf(L"Open Camera, Chrome or OBS and choose the camera.\n");

    if (seconds > 0)
    {
        wprintf(L"Stopping after %d seconds...\n", seconds);
        Sleep(static_cast<DWORD>(seconds) * 1000);
    }
    else
    {
        wprintf(L"Press Enter to stop...\n");
        getwchar();
    }

    camera->Stop();
    camera->Shutdown();
    camera->Release();
    MFShutdown();
    CoUninitialize();
    wprintf(L"Stopped.\n");
    return 0;
}
