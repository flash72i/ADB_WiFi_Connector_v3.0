#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <cstdio>

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "ole32.lib")

int wmain()
{
    setvbuf(stdout, nullptr, _IONBF, 0);
    SetConsoleOutputCP(CP_UTF8);
    wprintf(L"probe start\n");

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr))
    {
        wprintf(L"CoInitializeEx 0x%08X\n", static_cast<unsigned int>(hr));
        return 1;
    }
    hr = MFStartup(MF_VERSION, MFSTARTUP_FULL);
    if (FAILED(hr))
    {
        wprintf(L"MFStartup 0x%08X\n", static_cast<unsigned int>(hr));
        CoUninitialize();
        return 1;
    }

    IMFAttributes* attributes = nullptr;
    hr = MFCreateAttributes(&attributes, 1);
    if (SUCCEEDED(hr))
    {
        hr = attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
    }

    IMFActivate** devices = nullptr;
    UINT32 count = 0;
    if (SUCCEEDED(hr))
    {
        hr = MFEnumDeviceSources(attributes, &devices, &count);
    }
    wprintf(L"enumerate hr=0x%08X count=%u\n", static_cast<unsigned int>(hr), count);

    int selected = -1;
    for (UINT32 i = 0; i < count; i++)
    {
        wchar_t name[512] = {};
        UINT32 length = 0;
        devices[i]->GetString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, name, 512, &length);
        wprintf(L"[%u] %s\n", i, name);
        if (selected < 0 && (wcsstr(name, L"ADB Phone") || wcsstr(name, L"Virtual Camera")))
        {
            selected = static_cast<int>(i);
        }
    }

    if (selected < 0)
    {
        wprintf(L"No virtual camera found\n");
    }
    else
    {
        IMFMediaSource* source = nullptr;
        hr = devices[selected]->ActivateObject(IID_PPV_ARGS(&source));
        wprintf(L"activate hr=0x%08X\n", static_cast<unsigned int>(hr));

        IMFSourceReader* reader = nullptr;
        IMFAttributes* readerAttributes = nullptr;
        if (SUCCEEDED(hr))
        {
            hr = MFCreateAttributes(&readerAttributes, 1);
        }
        if (SUCCEEDED(hr))
        {
            hr = readerAttributes->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE);
        }
        if (SUCCEEDED(hr))
        {
            hr = MFCreateSourceReaderFromMediaSource(source, readerAttributes, &reader);
        }
        if (SUCCEEDED(hr))
        {
            reader->SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS, FALSE);
            reader->SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM, TRUE);
        }

        IMFMediaType* type = nullptr;
        if (SUCCEEDED(hr))
        {
            hr = MFCreateMediaType(&type);
        }
        if (SUCCEEDED(hr))
        {
            hr = type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        }
        if (SUCCEEDED(hr))
        {
            hr = type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
        }
        if (SUCCEEDED(hr))
        {
            hr = reader->SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, type);
        }
        wprintf(L"media type hr=0x%08X\n", static_cast<unsigned int>(hr));

        IMFSample* sample = nullptr;
        for (int i = 0; SUCCEEDED(hr) && i < 100 && !sample; i++)
        {
            DWORD streamIndex = 0;
            DWORD flags = 0;
            LONGLONG timestamp = 0;
            hr = reader->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, &streamIndex, &flags, &timestamp, &sample);
            if (FAILED(hr))
            {
                wprintf(L"ReadSample 0x%08X\n", static_cast<unsigned int>(hr));
                break;
            }
            if (!sample)
            {
                Sleep(50);
            }
        }

        if (sample)
        {
            IMFMediaBuffer* buffer = nullptr;
            hr = sample->ConvertToContiguousBuffer(&buffer);
            if (SUCCEEDED(hr))
            {
                DWORD length = 0;
                buffer->GetCurrentLength(&length);
                BYTE* pixels = nullptr;
                hr = buffer->Lock(&pixels, nullptr, nullptr);
                if (SUCCEEDED(hr))
                {
                    wprintf(L"FRAME length=%u first=%u,%u,%u\n", length, pixels[0], pixels[1], pixels[2]);
                    buffer->Unlock();
                }
                buffer->Release();
            }
            sample->Release();
        }
        else
        {
            wprintf(L"No sample\n");
        }

        if (type) type->Release();
        if (reader) reader->Release();
        if (readerAttributes) readerAttributes->Release();
        if (source) source->Release();
    }

    for (UINT32 i = 0; i < count; i++)
    {
        devices[i]->Release();
    }
    if (devices)
    {
        CoTaskMemFree(devices);
    }
    if (attributes) attributes->Release();
    MFShutdown();
    CoUninitialize();
    return 0;
}
