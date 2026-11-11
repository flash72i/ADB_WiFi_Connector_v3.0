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
#include <mfidl.h>
#include <mferror.h>
#include <mfvirtualcamera.h>
#include <mftransform.h>
#include <shlwapi.h>
#include <new>
#include <deque>
#include <vector>
#include <cstring>

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "mf.lib")
#pragma comment(lib, "mfsensorgroup.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shlwapi.lib")

static const CLSID CLSID_PhoneVirtualCameraSource =
{ 0x7e7b7a4c, 0x2e6b, 0x4c1a, { 0x9d, 0x3f, 0x9b, 0x7a, 0x6e, 0x2f, 0x1c, 0x01 } };

static const GUID kPinNameVideoCapture =
{ 0xfb6c4281, 0x0353, 0x11d1, { 0x90, 0x5f, 0x00, 0x00, 0xc0, 0xcc, 0x16, 0xba } };

static const GUID kProfileLegacy =
{ 0xb4894d81, 0x62b7, 0x4eec, { 0x87, 0x40, 0x80, 0x65, 0x8c, 0x4a, 0x9d, 0x3e } };

static const GUID kProfileHighFrameRate =
{ 0x566e6113, 0x8c35, 0x48e7, { 0xb8, 0x9f, 0xd2, 0x3f, 0xdc, 0x12, 0x19, 0xdc } };

static const wchar_t* kSourceName = L"ADB Phone Camera Source";
static const UINT32 kWidth = 1280;
static const UINT32 kHeight = 720;
static const UINT32 kFps = 30;
static const UINT32 kFrameBytes = kWidth * kHeight * 4;
static const LONGLONG kFrameDuration = 10000000LL / kFps;

static volatile LONG g_objectCount = 0;
static HMODULE g_module = nullptr;

static bool g_traceEnabled = true;

static void Trace(const wchar_t* text)
{
    if (!g_traceEnabled)
    {
        return;
    }
    HANDLE file = CreateFileW(L"C:\\ProgramData\\PhoneVirtualCam\\source.log",
        FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
        OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file != INVALID_HANDLE_VALUE)
    {
        DWORD written = 0;
        WriteFile(file, text, static_cast<DWORD>(wcslen(text) * sizeof(wchar_t)), &written, nullptr);
        WriteFile(file, L"\r\n", 4, &written, nullptr);
        CloseHandle(file);
    }
}

static bool ReadPhoneFrame(BYTE* pixels)
{
    HANDLE file = CreateFileW(L"C:\\ProgramData\\PhoneVirtualCam\\frame.bin",
        GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE)
    {
        return false;
    }

    LARGE_INTEGER size = {};
    if (!GetFileSizeEx(file, &size) || size.QuadPart < 16 || size.QuadPart > 32 * 1024 * 1024)
    {
        CloseHandle(file);
        return false;
    }

    std::vector<BYTE> data(static_cast<size_t>(size.QuadPart));
    DWORD read = 0;
    BOOL ok = ReadFile(file, data.data(), static_cast<DWORD>(data.size()), &read, nullptr);
    CloseHandle(file);
    if (!ok || read != data.size() || memcmp(data.data(), "PCAM", 4) != 0)
    {
        return false;
    }

    UINT32 width = 0;
    UINT32 height = 0;
    UINT32 length = 0;
    memcpy(&width, data.data() + 4, sizeof(width));
    memcpy(&height, data.data() + 8, sizeof(height));
    memcpy(&length, data.data() + 12, sizeof(length));
    if (width != kWidth || height != kHeight || length != kFrameBytes || data.size() < 16 + length)
    {
        return false;
    }

    memcpy(pixels, data.data() + 16, kFrameBytes);
    return true;
}

template <class T>
static void SafeRelease(T** pp)
{
    if (*pp)
    {
        (*pp)->Release();
        *pp = nullptr;
    }
}

class CVirtualCameraSource;

class CVirtualCameraStream : public IMFMediaStream2
{
public:
    CVirtualCameraStream(CVirtualCameraSource* source, IMFStreamDescriptor* descriptor);
    virtual ~CVirtualCameraStream();

    HRESULT Initialize();

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override;
    STDMETHODIMP_(ULONG) AddRef() override;
    STDMETHODIMP_(ULONG) Release() override;

    STDMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** ppEvent) override;
    STDMETHODIMP BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) override;
    STDMETHODIMP EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** ppEvent) override;
    STDMETHODIMP QueueEvent(MediaEventType met, REFGUID guidExtendedType, HRESULT hrStatus, const PROPVARIANT* pvValue) override;

    STDMETHODIMP GetMediaSource(IMFMediaSource** ppMediaSource) override;
    STDMETHODIMP GetStreamDescriptor(IMFStreamDescriptor** ppStreamDescriptor) override;
    STDMETHODIMP RequestSample(IUnknown* token) override;

    STDMETHODIMP SetStreamState(MF_STREAM_STATE state) override;
    STDMETHODIMP GetStreamState(MF_STREAM_STATE* pState) override;

    HRESULT Start();
    HRESULT Stop();
    HRESULT Shutdown();
    HRESULT GetAttributes(IMFAttributes** ppAttributes);
    IMFStreamDescriptor* Descriptor() const { return m_descriptor; }

private:
    static DWORD WINAPI ThreadProc(LPVOID context);
    void Loop();
    HRESULT CreateSample(IMFSample** ppSample);
    void FillFrame(BYTE* pixels);

    volatile LONG m_ref;
    CRITICAL_SECTION m_lock;
    IMFMediaEventQueue* m_eventQueue;
    IMFStreamDescriptor* m_descriptor;
    IMFAttributes* m_attributes;
    CVirtualCameraSource* m_source;
    HANDLE m_thread;
    HANDLE m_wake;
    volatile BOOL m_running;
    volatile BOOL m_shutdown;
    volatile LONG m_active;
    MF_STREAM_STATE m_state;
    std::deque<IUnknown*> m_requests;
    LONGLONG m_frame;
};

enum SourceState
{
    SourceStopped,
    SourceStarted
};

class CVirtualCameraSource : public IMFMediaSourceEx, public IMFGetService, public IMFRateControl
{
public:
    CVirtualCameraSource();
    virtual ~CVirtualCameraSource();

    HRESULT Initialize();

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override;
    STDMETHODIMP_(ULONG) AddRef() override;
    STDMETHODIMP_(ULONG) Release() override;

    STDMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** ppEvent) override;
    STDMETHODIMP BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) override;
    STDMETHODIMP EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** ppEvent) override;
    STDMETHODIMP QueueEvent(MediaEventType met, REFGUID guidExtendedType, HRESULT hrStatus, const PROPVARIANT* pvValue) override;

    STDMETHODIMP GetCharacteristics(DWORD* pdwCharacteristics) override;
    STDMETHODIMP CreatePresentationDescriptor(IMFPresentationDescriptor** ppPresentationDescriptor) override;
    STDMETHODIMP Start(IMFPresentationDescriptor* pPresentationDescriptor, const GUID* pguidTimeFormat, const PROPVARIANT* pvarStartPosition) override;
    STDMETHODIMP Stop() override;
    STDMETHODIMP Pause() override;
    STDMETHODIMP Shutdown() override;

    STDMETHODIMP GetSourceAttributes(IMFAttributes** ppAttributes) override;
    STDMETHODIMP GetStreamAttributes(DWORD dwStreamIdentifier, IMFAttributes** ppAttributes) override;
    STDMETHODIMP SetD3DManager(IUnknown* pManager) override;

    STDMETHODIMP GetService(REFGUID guidService, REFIID riid, LPVOID* ppvObject) override;

    STDMETHODIMP SetRate(BOOL thin, float rate) override;
    STDMETHODIMP GetRate(BOOL* thin, float* rate) override;

private:
    HRESULT CheckShutdown() const;
    HRESULT CheckState() const;

    volatile LONG m_ref;
    CRITICAL_SECTION m_lock;
    IMFMediaEventQueue* m_eventQueue;
    IMFAttributes* m_attributes;
    CVirtualCameraStream* m_stream;
    SourceState m_state;
    volatile BOOL m_shutdown;
};

class CVirtualCameraActivator : public IMFActivate
{
public:
    CVirtualCameraActivator()
        : m_ref(1)
        , m_attributes(nullptr)
        , m_source(nullptr)
    {
        InitializeCriticalSection(&m_lock);
        InterlockedIncrement(&g_objectCount);
    }

    virtual ~CVirtualCameraActivator()
    {
        SafeRelease(&m_source);
        SafeRelease(&m_attributes);
        DeleteCriticalSection(&m_lock);
        InterlockedDecrement(&g_objectCount);
    }

    HRESULT Initialize()
    {
        HRESULT hr = MFCreateAttributes(&m_attributes, 2);
        if (SUCCEEDED(hr))
        {
            hr = m_attributes->SetGUID(MFT_TRANSFORM_CLSID_Attribute, CLSID_PhoneVirtualCameraSource);
        }
        if (SUCCEEDED(hr))
        {
            hr = m_attributes->SetUINT32(MF_VIRTUALCAMERA_PROVIDE_ASSOCIATED_CAMERA_SOURCES, 1);
        }
        return hr;
    }

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override
    {
        if (!ppv)
        {
            return E_POINTER;
        }
        *ppv = nullptr;
        if (riid == IID_IUnknown || riid == IID_IMFActivate || riid == IID_IMFAttributes)
        {
            *ppv = static_cast<IMFActivate*>(this);
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }

    STDMETHODIMP_(ULONG) AddRef() override
    {
        return static_cast<ULONG>(InterlockedIncrement(&m_ref));
    }

    STDMETHODIMP_(ULONG) Release() override
    {
        ULONG ref = static_cast<ULONG>(InterlockedDecrement(&m_ref));
        if (ref == 0)
        {
            delete this;
        }
        return ref;
    }

    STDMETHODIMP GetItem(REFGUID key, PROPVARIANT* value) override { return m_attributes->GetItem(key, value); }
    STDMETHODIMP GetItemType(REFGUID key, MF_ATTRIBUTE_TYPE* type) override { return m_attributes->GetItemType(key, type); }
    STDMETHODIMP CompareItem(REFGUID key, REFPROPVARIANT value, BOOL* result) override { return m_attributes->CompareItem(key, value, result); }
    STDMETHODIMP Compare(IMFAttributes* theirs, MF_ATTRIBUTES_MATCH_TYPE matchType, BOOL* result) override { return m_attributes->Compare(theirs, matchType, result); }
    STDMETHODIMP GetUINT32(REFGUID key, UINT32* value) override { return m_attributes->GetUINT32(key, value); }
    STDMETHODIMP GetUINT64(REFGUID key, UINT64* value) override { return m_attributes->GetUINT64(key, value); }
    STDMETHODIMP GetDouble(REFGUID key, double* value) override { return m_attributes->GetDouble(key, value); }
    STDMETHODIMP GetGUID(REFGUID key, GUID* value) override { return m_attributes->GetGUID(key, value); }
    STDMETHODIMP GetStringLength(REFGUID key, UINT32* length) override { return m_attributes->GetStringLength(key, length); }
    STDMETHODIMP GetString(REFGUID key, LPWSTR value, UINT32 size, UINT32* length) override { return m_attributes->GetString(key, value, size, length); }
    STDMETHODIMP GetAllocatedString(REFGUID key, LPWSTR* value, UINT32* length) override { return m_attributes->GetAllocatedString(key, value, length); }
    STDMETHODIMP GetBlobSize(REFGUID key, UINT32* size) override { return m_attributes->GetBlobSize(key, size); }
    STDMETHODIMP GetBlob(REFGUID key, UINT8* buffer, UINT32 size, UINT32* actual) override { return m_attributes->GetBlob(key, buffer, size, actual); }
    STDMETHODIMP GetAllocatedBlob(REFGUID key, UINT8** buffer, UINT32* size) override { return m_attributes->GetAllocatedBlob(key, buffer, size); }
    STDMETHODIMP GetUnknown(REFGUID key, REFIID riid, LPVOID* value) override { return m_attributes->GetUnknown(key, riid, value); }
    STDMETHODIMP SetItem(REFGUID key, REFPROPVARIANT value) override { return m_attributes->SetItem(key, value); }
    STDMETHODIMP DeleteItem(REFGUID key) override { return m_attributes->DeleteItem(key); }
    STDMETHODIMP DeleteAllItems() override { return m_attributes->DeleteAllItems(); }
    STDMETHODIMP SetUINT32(REFGUID key, UINT32 value) override { return m_attributes->SetUINT32(key, value); }
    STDMETHODIMP SetUINT64(REFGUID key, UINT64 value) override { return m_attributes->SetUINT64(key, value); }
    STDMETHODIMP SetDouble(REFGUID key, double value) override { return m_attributes->SetDouble(key, value); }
    STDMETHODIMP SetGUID(REFGUID key, REFGUID value) override { return m_attributes->SetGUID(key, value); }
    STDMETHODIMP SetString(REFGUID key, LPCWSTR value) override { return m_attributes->SetString(key, value); }
    STDMETHODIMP SetBlob(REFGUID key, const UINT8* buffer, UINT32 size) override { return m_attributes->SetBlob(key, buffer, size); }
    STDMETHODIMP SetUnknown(REFGUID key, IUnknown* value) override { return m_attributes->SetUnknown(key, value); }
    STDMETHODIMP LockStore() override { return m_attributes->LockStore(); }
    STDMETHODIMP UnlockStore() override { return m_attributes->UnlockStore(); }
    STDMETHODIMP GetCount(UINT32* count) override { return m_attributes->GetCount(count); }
    STDMETHODIMP GetItemByIndex(UINT32 index, GUID* key, PROPVARIANT* value) override { return m_attributes->GetItemByIndex(index, key, value); }
    STDMETHODIMP CopyAllItems(IMFAttributes* destination) override { return m_attributes->CopyAllItems(destination); }

    STDMETHODIMP ActivateObject(REFIID riid, void** ppv) override
    {
        Trace(L"activator ActivateObject");
        if (!ppv)
        {
            return E_POINTER;
        }
        *ppv = nullptr;
        CVirtualCameraSource* source = new (std::nothrow) CVirtualCameraSource();
        if (!source)
        {
            return E_OUTOFMEMORY;
        }
        HRESULT hr = source->Initialize();
        if (SUCCEEDED(hr))
        {
            hr = source->QueryInterface(riid, ppv);
        }
        source->Release();
        return hr;
    }

    STDMETHODIMP ShutdownObject() override
    {
        return S_OK;
    }

    STDMETHODIMP DetachObject() override
    {
        EnterCriticalSection(&m_lock);
        SafeRelease(&m_source);
        LeaveCriticalSection(&m_lock);
        return S_OK;
    }

private:
    volatile LONG m_ref;
    IMFAttributes* m_attributes;
    CVirtualCameraSource* m_source;
    CRITICAL_SECTION m_lock;
};

CVirtualCameraStream::CVirtualCameraStream(CVirtualCameraSource* source, IMFStreamDescriptor* descriptor)
    : m_ref(1)
    , m_eventQueue(nullptr)
    , m_descriptor(descriptor)
    , m_attributes(nullptr)
    , m_source(source)
    , m_thread(nullptr)
    , m_wake(nullptr)
    , m_running(FALSE)
    , m_shutdown(FALSE)
    , m_active(0)
    , m_state(MF_STREAM_STATE_STOPPED)
    , m_frame(0)
{
    InitializeCriticalSection(&m_lock);
    if (m_descriptor)
    {
        m_descriptor->AddRef();
    }
    InterlockedIncrement(&g_objectCount);
}

CVirtualCameraStream::~CVirtualCameraStream()
{
    Shutdown();
    if (m_wake)
    {
        CloseHandle(m_wake);
        m_wake = nullptr;
    }
    SafeRelease(&m_attributes);
    SafeRelease(&m_descriptor);
    DeleteCriticalSection(&m_lock);
    InterlockedDecrement(&g_objectCount);
}

HRESULT CVirtualCameraStream::Initialize()
{
    HRESULT hr = MFCreateEventQueue(&m_eventQueue);
    if (SUCCEEDED(hr))
    {
        hr = MFCreateAttributes(&m_attributes, 6);
    }
    if (SUCCEEDED(hr))
    {
        hr = m_attributes->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, kPinNameVideoCapture);
    }
    if (SUCCEEDED(hr))
    {
        hr = m_attributes->SetUINT32(MF_DEVICESTREAM_STREAM_ID, 1);
    }
    if (SUCCEEDED(hr))
    {
        hr = m_attributes->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1);
    }
    if (SUCCEEDED(hr))
    {
        hr = m_attributes->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES, MFFrameSourceTypes_Color);
    }
    if (SUCCEEDED(hr))
    {
        m_wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!m_wake)
        {
            hr = HRESULT_FROM_WIN32(GetLastError());
        }
    }
    return hr;
}

STDMETHODIMP CVirtualCameraStream::QueryInterface(REFIID riid, void** ppv)
{
    if (!ppv)
    {
        return E_POINTER;
    }
    *ppv = nullptr;
    if (riid == IID_IUnknown || riid == IID_IMFMediaStream || riid == IID_IMFMediaStream2)
    {
        *ppv = static_cast<IMFMediaStream2*>(this);
    }
    else if (riid == IID_IMFMediaEventGenerator)
    {
        *ppv = static_cast<IMFMediaEventGenerator*>(this);
    }
    else
    {
        return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
}

STDMETHODIMP_(ULONG) CVirtualCameraStream::AddRef()
{
    return static_cast<ULONG>(InterlockedIncrement(&m_ref));
}

STDMETHODIMP_(ULONG) CVirtualCameraStream::Release()
{
    ULONG ref = static_cast<ULONG>(InterlockedDecrement(&m_ref));
    if (ref == 0)
    {
        delete this;
    }
    return ref;
}

STDMETHODIMP CVirtualCameraStream::GetEvent(DWORD flags, IMFMediaEvent** ppEvent)
{
    if (!m_eventQueue)
    {
        return MF_E_SHUTDOWN;
    }
    return m_eventQueue->GetEvent(flags, ppEvent);
}

STDMETHODIMP CVirtualCameraStream::BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state)
{
    if (!m_eventQueue)
    {
        return MF_E_SHUTDOWN;
    }
    return m_eventQueue->BeginGetEvent(callback, state);
}

STDMETHODIMP CVirtualCameraStream::EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** ppEvent)
{
    if (!m_eventQueue)
    {
        return MF_E_SHUTDOWN;
    }
    return m_eventQueue->EndGetEvent(result, ppEvent);
}

STDMETHODIMP CVirtualCameraStream::QueueEvent(MediaEventType met, REFGUID guidExtendedType, HRESULT hrStatus, const PROPVARIANT* pvValue)
{
    if (!m_eventQueue)
    {
        return MF_E_SHUTDOWN;
    }
    return m_eventQueue->QueueEventParamVar(met, guidExtendedType, hrStatus, pvValue);
}

STDMETHODIMP CVirtualCameraStream::GetMediaSource(IMFMediaSource** ppMediaSource)
{
    if (!ppMediaSource)
    {
        return E_POINTER;
    }
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    *ppMediaSource = m_source;
    if (*ppMediaSource)
    {
        (*ppMediaSource)->AddRef();
    }
    return S_OK;
}

STDMETHODIMP CVirtualCameraStream::GetStreamDescriptor(IMFStreamDescriptor** ppStreamDescriptor)
{
    if (!ppStreamDescriptor)
    {
        return E_POINTER;
    }
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    *ppStreamDescriptor = m_descriptor;
    if (*ppStreamDescriptor)
    {
        (*ppStreamDescriptor)->AddRef();
    }
    return S_OK;
}

STDMETHODIMP CVirtualCameraStream::RequestSample(IUnknown* token)
{
    Trace(L"stream RequestSample");
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    if (!m_running || m_state != MF_STREAM_STATE_RUNNING)
    {
        return MF_E_INVALIDREQUEST;
    }

    EnterCriticalSection(&m_lock);
    if (token)
    {
        token->AddRef();
    }
    m_requests.push_back(token);
    LeaveCriticalSection(&m_lock);

    SetEvent(m_wake);
    return S_OK;
}

STDMETHODIMP CVirtualCameraStream::SetStreamState(MF_STREAM_STATE state)
{
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    if (state == MF_STREAM_STATE_RUNNING)
    {
        return Start();
    }
    if (state == MF_STREAM_STATE_STOPPED)
    {
        return Stop();
    }
    m_state = state;
    return S_OK;
}

STDMETHODIMP CVirtualCameraStream::GetStreamState(MF_STREAM_STATE* pState)
{
    if (!pState)
    {
        return E_POINTER;
    }
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    *pState = m_state;
    return S_OK;
}

HRESULT CVirtualCameraStream::Start()
{
    Trace(L"stream Start");
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    if (m_running)
    {
        return S_OK;
    }

    m_running = TRUE;
    m_state = MF_STREAM_STATE_RUNNING;
    m_thread = CreateThread(nullptr, 0, ThreadProc, this, 0, nullptr);
    if (!m_thread)
    {
        m_running = FALSE;
        m_state = MF_STREAM_STATE_STOPPED;
        return HRESULT_FROM_WIN32(GetLastError());
    }
    m_eventQueue->QueueEventParamVar(MEStreamStarted, GUID_NULL, S_OK, nullptr);
    return S_OK;
}

HRESULT CVirtualCameraStream::Stop()
{
    if (m_thread)
    {
        m_running = FALSE;
        m_state = MF_STREAM_STATE_STOPPED;
        SetEvent(m_wake);
        WaitForSingleObject(m_thread, 3000);
        CloseHandle(m_thread);
        m_thread = nullptr;
    }
    m_state = MF_STREAM_STATE_STOPPED;

    EnterCriticalSection(&m_lock);
    while (!m_requests.empty())
    {
        IUnknown* token = m_requests.front();
        m_requests.pop_front();
        SafeRelease(&token);
    }
    LeaveCriticalSection(&m_lock);
    if (m_eventQueue)
    {
        m_eventQueue->QueueEventParamVar(MEStreamStopped, GUID_NULL, S_OK, nullptr);
    }
    return S_OK;
}

HRESULT CVirtualCameraStream::Shutdown()
{
    if (m_shutdown)
    {
        return S_OK;
    }
    m_shutdown = TRUE;
    Stop();
    if (m_eventQueue)
    {
        m_eventQueue->Shutdown();
    }
    return S_OK;
}

HRESULT CVirtualCameraStream::GetAttributes(IMFAttributes** ppAttributes)
{
    if (!ppAttributes)
    {
        return E_POINTER;
    }
    *ppAttributes = m_attributes;
    if (*ppAttributes)
    {
        (*ppAttributes)->AddRef();
    }
    return S_OK;
}

DWORD WINAPI CVirtualCameraStream::ThreadProc(LPVOID context)
{
    static_cast<CVirtualCameraStream*>(context)->Loop();
    return 0;
}

void CVirtualCameraStream::Loop()
{
    while (m_running)
    {
        WaitForSingleObject(m_wake, 100);
        if (!m_running)
        {
            break;
        }

        IUnknown* token = nullptr;
        BOOL haveRequest = FALSE;
        EnterCriticalSection(&m_lock);
        if (!m_requests.empty())
        {
            token = m_requests.front();
            m_requests.pop_front();
            haveRequest = TRUE;
        }
        LeaveCriticalSection(&m_lock);

        if (!haveRequest)
        {
            continue;
        }

        Trace(L"stream Loop request");
        IMFSample* sample = nullptr;
        HRESULT hr = CreateSample(&sample);
        if (SUCCEEDED(hr) && sample)
        {
            if (token)
            {
                sample->SetUnknown(MFSampleExtension_Token, token);
            }
            hr = m_eventQueue->QueueEventParamUnk(MEMediaSample, GUID_NULL, S_OK, sample);
            Trace(SUCCEEDED(hr) ? L"stream sample queued" : L"stream sample queue failed");
        }
        if (FAILED(hr) && m_eventQueue)
        {
            m_eventQueue->QueueEventParamVar(MEError, GUID_NULL, hr, nullptr);
        }
        SafeRelease(&sample);
        SafeRelease(&token);
    }
}

HRESULT CVirtualCameraStream::CreateSample(IMFSample** ppSample)
{
    if (!ppSample)
    {
        return E_POINTER;
    }
    *ppSample = nullptr;

    IMFMediaBuffer* buffer = nullptr;
    IMFSample* sample = nullptr;
    BYTE* pixels = nullptr;

    HRESULT hr = MFCreateMemoryBuffer(kFrameBytes, &buffer);
    if (SUCCEEDED(hr))
    {
        hr = buffer->Lock(&pixels, nullptr, nullptr);
    }
    if (SUCCEEDED(hr))
    {
        if (!ReadPhoneFrame(pixels))
        {
            FillFrame(pixels);
        }
        buffer->Unlock();
        pixels = nullptr;
        hr = buffer->SetCurrentLength(kFrameBytes);
    }
    if (SUCCEEDED(hr))
    {
        hr = MFCreateSample(&sample);
    }
    if (SUCCEEDED(hr))
    {
        hr = sample->AddBuffer(buffer);
    }
    if (SUCCEEDED(hr))
    {
        LONGLONG time = MFGetSystemTime();
        hr = sample->SetSampleTime(time);
        if (SUCCEEDED(hr))
        {
            hr = sample->SetSampleDuration(kFrameDuration);
        }
        m_frame++;
    }
    if (SUCCEEDED(hr))
    {
        *ppSample = sample;
        sample = nullptr;
    }

    if (pixels)
    {
        buffer->Unlock();
    }
    SafeRelease(&sample);
    SafeRelease(&buffer);
    return hr;
}

void CVirtualCameraStream::FillFrame(BYTE* pixels)
{
    static const BYTE colors[6][3] =
    {
        { 40, 70, 210 },
        { 190, 180, 40 },
        { 40, 180, 90 },
        { 200, 230, 40 },
        { 40, 120, 220 },
        { 230, 60, 120 }
    };

    const UINT32 barWidth = kWidth / 12;
    const UINT32 offset = static_cast<UINT32>((m_frame * 8) % (kWidth + barWidth)) - barWidth;

    for (UINT32 y = 0; y < kHeight; y++)
    {
        BYTE* row = pixels + static_cast<size_t>(y) * kWidth * 4;
        for (UINT32 x = 0; x < kWidth; x++)
        {
            UINT32 index = (x * 6) / kWidth;
            BYTE b = colors[index][0];
            BYTE g = colors[index][1];
            BYTE r = colors[index][2];
            if (x >= offset && x < offset + barWidth)
            {
                b = 245;
                g = 245;
                r = 245;
            }
            size_t p = static_cast<size_t>(x) * 4;
            row[p + 0] = b;
            row[p + 1] = g;
            row[p + 2] = r;
            row[p + 3] = 255;
        }
    }
}

CVirtualCameraSource::CVirtualCameraSource()
    : m_ref(1)
    , m_eventQueue(nullptr)
    , m_attributes(nullptr)
    , m_stream(nullptr)
    , m_state(SourceStopped)
    , m_shutdown(FALSE)
{
    InitializeCriticalSection(&m_lock);
    InterlockedIncrement(&g_objectCount);
}

CVirtualCameraSource::~CVirtualCameraSource()
{
    Shutdown();
    SafeRelease(&m_stream);
    SafeRelease(&m_attributes);
    SafeRelease(&m_eventQueue);
    DeleteCriticalSection(&m_lock);
    InterlockedDecrement(&g_objectCount);
}

HRESULT CVirtualCameraSource::Initialize()
{
    HRESULT hr = MFCreateEventQueue(&m_eventQueue);
    if (SUCCEEDED(hr))
    {
        hr = MFCreateAttributes(&m_attributes, 4);
    }
    if (SUCCEEDED(hr))
    {
        hr = m_attributes->SetGUID(MFT_TRANSFORM_CLSID_Attribute, CLSID_PhoneVirtualCameraSource);
    }
    if (SUCCEEDED(hr))
    {
        hr = m_attributes->SetUINT32(MF_VIRTUALCAMERA_PROVIDE_ASSOCIATED_CAMERA_SOURCES, 1);
    }

    IMFSensorProfileCollection* profiles = nullptr;
    IMFSensorProfile* profile = nullptr;
    if (SUCCEEDED(hr))
    {
        hr = MFCreateSensorProfileCollection(&profiles);
    }
    if (SUCCEEDED(hr))
    {
        hr = MFCreateSensorProfile(kProfileLegacy, 0, nullptr, &profile);
    }
    if (SUCCEEDED(hr))
    {
        hr = profile->AddProfileFilter(1, L"((RES==;FRT<=30,1;SUT==))");
    }
    if (SUCCEEDED(hr))
    {
        hr = profiles->AddProfile(profile);
    }
    SafeRelease(&profile);
    if (SUCCEEDED(hr))
    {
        hr = MFCreateSensorProfile(kProfileHighFrameRate, 0, nullptr, &profile);
    }
    if (SUCCEEDED(hr))
    {
        hr = profile->AddProfileFilter(1, L"((RES==;FRT>=60,1;SUT==))");
    }
    if (SUCCEEDED(hr))
    {
        hr = profiles->AddProfile(profile);
    }
    if (SUCCEEDED(hr))
    {
        hr = m_attributes->SetUnknown(MF_DEVICEMFT_SENSORPROFILE_COLLECTION, profiles);
    }
    SafeRelease(&profile);
    SafeRelease(&profiles);

    IMFMediaType* mediaType = nullptr;
    IMFStreamDescriptor* descriptor = nullptr;
    if (SUCCEEDED(hr))
    {
        hr = MFCreateMediaType(&mediaType);
    }
    if (SUCCEEDED(hr))
    {
        hr = mediaType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    }
    if (SUCCEEDED(hr))
    {
        hr = mediaType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
    }
    if (SUCCEEDED(hr))
    {
        hr = MFSetAttributeSize(mediaType, MF_MT_FRAME_SIZE, kWidth, kHeight);
    }
    if (SUCCEEDED(hr))
    {
        hr = MFSetAttributeRatio(mediaType, MF_MT_FRAME_RATE, kFps, 1);
    }
    if (SUCCEEDED(hr))
    {
        hr = MFSetAttributeRatio(mediaType, MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    }
    if (SUCCEEDED(hr))
    {
        hr = mediaType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    }
    if (SUCCEEDED(hr))
    {
        hr = mediaType->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
    }
    if (SUCCEEDED(hr))
    {
        hr = MFCreateStreamDescriptor(1, 1, &mediaType, &descriptor);
    }
    if (SUCCEEDED(hr))
    {
        m_stream = new (std::nothrow) CVirtualCameraStream(this, descriptor);
        if (!m_stream)
        {
            hr = E_OUTOFMEMORY;
        }
    }
    if (SUCCEEDED(hr))
    {
        hr = m_stream->Initialize();
    }

    SafeRelease(&descriptor);
    SafeRelease(&mediaType);
    return hr;
}

STDMETHODIMP CVirtualCameraSource::QueryInterface(REFIID riid, void** ppv)
{
    if (!ppv)
    {
        return E_POINTER;
    }
    *ppv = nullptr;
    if (riid == IID_IUnknown || riid == IID_IMFMediaSource || riid == IID_IMFMediaSourceEx)
    {
        *ppv = static_cast<IMFMediaSourceEx*>(this);
    }
    else if (riid == IID_IMFMediaEventGenerator)
    {
        *ppv = static_cast<IMFMediaEventGenerator*>(this);
    }
    else if (riid == IID_IMFGetService)
    {
        *ppv = static_cast<IMFGetService*>(this);
    }
    else if (riid == IID_IMFRateControl)
    {
        *ppv = static_cast<IMFRateControl*>(this);
    }
    else
    {
        return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
}

STDMETHODIMP_(ULONG) CVirtualCameraSource::AddRef()
{
    return static_cast<ULONG>(InterlockedIncrement(&m_ref));
}

STDMETHODIMP_(ULONG) CVirtualCameraSource::Release()
{
    ULONG ref = static_cast<ULONG>(InterlockedDecrement(&m_ref));
    if (ref == 0)
    {
        delete this;
    }
    return ref;
}

STDMETHODIMP CVirtualCameraSource::GetEvent(DWORD flags, IMFMediaEvent** ppEvent)
{
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    return m_eventQueue->GetEvent(flags, ppEvent);
}

STDMETHODIMP CVirtualCameraSource::BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state)
{
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    return m_eventQueue->BeginGetEvent(callback, state);
}

STDMETHODIMP CVirtualCameraSource::EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** ppEvent)
{
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    return m_eventQueue->EndGetEvent(result, ppEvent);
}

STDMETHODIMP CVirtualCameraSource::QueueEvent(MediaEventType met, REFGUID guidExtendedType, HRESULT hrStatus, const PROPVARIANT* pvValue)
{
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    return m_eventQueue->QueueEventParamVar(met, guidExtendedType, hrStatus, pvValue);
}

HRESULT CVirtualCameraSource::CheckShutdown() const
{
    return m_shutdown ? MF_E_SHUTDOWN : S_OK;
}

HRESULT CVirtualCameraSource::CheckState() const
{
    return m_state == SourceStarted ? S_OK : MF_E_INVALIDREQUEST;
}

STDMETHODIMP CVirtualCameraSource::GetCharacteristics(DWORD* pdwCharacteristics)
{
    if (!pdwCharacteristics)
    {
        return E_POINTER;
    }
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    *pdwCharacteristics = MFMEDIASOURCE_IS_LIVE;
    return S_OK;
}

STDMETHODIMP CVirtualCameraSource::CreatePresentationDescriptor(IMFPresentationDescriptor** ppPresentationDescriptor)
{
    if (!ppPresentationDescriptor)
    {
        return E_POINTER;
    }
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }

    IMFStreamDescriptor* descriptor = m_stream->Descriptor();
    if (!descriptor)
    {
        return E_FAIL;
    }

    IMFPresentationDescriptor* presentation = nullptr;
    HRESULT hr = MFCreatePresentationDescriptor(1, &descriptor, &presentation);
    if (SUCCEEDED(hr))
    {
        hr = presentation->SelectStream(0);
    }
    if (SUCCEEDED(hr))
    {
        *ppPresentationDescriptor = presentation;
        presentation = nullptr;
    }
    SafeRelease(&presentation);
    return hr;
}

STDMETHODIMP CVirtualCameraSource::Start(IMFPresentationDescriptor* pPresentationDescriptor, const GUID* pguidTimeFormat, const PROPVARIANT* pvarStartPosition)
{
    Trace(L"source Start enter");
    if (m_shutdown)
    {
        Trace(L"source reset after shutdown");
        m_shutdown = FALSE;
        m_state = SourceStopped;
        SafeRelease(&m_stream);
        SafeRelease(&m_attributes);
        SafeRelease(&m_eventQueue);
        HRESULT resetHr = Initialize();
        if (FAILED(resetHr))
        {
            m_shutdown = TRUE;
            return resetHr;
        }
    }
    if (!pPresentationDescriptor || !pvarStartPosition)
    {
        return E_POINTER;
    }
    if (pguidTimeFormat && *pguidTimeFormat != GUID_NULL)
    {
        return MF_E_UNSUPPORTED_TIME_FORMAT;
    }
    if (pvarStartPosition->vt != VT_EMPTY && pvarStartPosition->vt != VT_I8)
    {
        return MF_E_UNSUPPORTED_TIME_FORMAT;
    }

    EnterCriticalSection(&m_lock);
    HRESULT hr = CheckShutdown();
    if (SUCCEEDED(hr) && m_state == SourceStarted)
    {
        Trace(L"source restart while started");
        m_stream->Stop();
        m_state = SourceStopped;
    }
    if (SUCCEEDED(hr))
    {
        m_state = SourceStarted;
        hr = m_eventQueue->QueueEventParamUnk(MENewStream, GUID_NULL, S_OK, m_stream);
    }
    if (SUCCEEDED(hr))
    {
        hr = m_stream->Start();
    }
    if (SUCCEEDED(hr))
    {
        hr = m_eventQueue->QueueEventParamVar(MESourceStarted, GUID_NULL, S_OK, nullptr);
    }
    Trace(L"source Start done");
    LeaveCriticalSection(&m_lock);
    return hr;
}

STDMETHODIMP CVirtualCameraSource::Stop()
{
    EnterCriticalSection(&m_lock);
    HRESULT hr = CheckShutdown();
    if (SUCCEEDED(hr) && m_state == SourceStopped)
    {
        LeaveCriticalSection(&m_lock);
        return S_OK;
    }
    if (SUCCEEDED(hr))
    {
        hr = m_stream->Stop();
    }
    if (SUCCEEDED(hr))
    {
        m_state = SourceStopped;
        hr = m_eventQueue->QueueEventParamVar(MESourceStopped, GUID_NULL, S_OK, nullptr);
    }
    LeaveCriticalSection(&m_lock);
    return hr;
}

STDMETHODIMP CVirtualCameraSource::Pause()
{
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    return MF_E_INVALID_STATE_TRANSITION;
}

STDMETHODIMP CVirtualCameraSource::Shutdown()
{
    EnterCriticalSection(&m_lock);
    if (m_shutdown)
    {
        LeaveCriticalSection(&m_lock);
        return S_OK;
    }
    m_shutdown = TRUE;
    m_state = SourceStopped;
    if (m_stream)
    {
        m_stream->Shutdown();
    }
    if (m_eventQueue)
    {
        m_eventQueue->Shutdown();
    }
    LeaveCriticalSection(&m_lock);
    return S_OK;
}

STDMETHODIMP CVirtualCameraSource::GetSourceAttributes(IMFAttributes** ppAttributes)
{
    if (!ppAttributes)
    {
        return E_POINTER;
    }
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    *ppAttributes = m_attributes;
    m_attributes->AddRef();
    return S_OK;
}

STDMETHODIMP CVirtualCameraSource::GetStreamAttributes(DWORD dwStreamIdentifier, IMFAttributes** ppAttributes)
{
    if (!ppAttributes)
    {
        return E_POINTER;
    }
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    if (dwStreamIdentifier != 1)
    {
        return MF_E_INVALIDSTREAMNUMBER;
    }
    return m_stream->GetAttributes(ppAttributes);
}

STDMETHODIMP CVirtualCameraSource::SetD3DManager(IUnknown* pManager)
{
    UNREFERENCED_PARAMETER(pManager);
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    return S_OK;
}

STDMETHODIMP CVirtualCameraSource::GetService(REFGUID guidService, REFIID riid, LPVOID* ppvObject)
{
    if (!ppvObject)
    {
        return E_POINTER;
    }
    *ppvObject = nullptr;
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    if (IsEqualGUID(guidService, MF_RATE_CONTROL_SERVICE) && IsEqualIID(riid, IID_IMFRateControl))
    {
        *ppvObject = static_cast<IMFRateControl*>(this);
        AddRef();
        return S_OK;
    }
    return MF_E_UNSUPPORTED_SERVICE;
}

STDMETHODIMP CVirtualCameraSource::SetRate(BOOL thin, float rate)
{
    UNREFERENCED_PARAMETER(thin);
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    return rate == 1.0f ? S_OK : MF_E_UNSUPPORTED_RATE;
}

STDMETHODIMP CVirtualCameraSource::GetRate(BOOL* thin, float* rate)
{
    if (!thin || !rate)
    {
        return E_POINTER;
    }
    if (m_shutdown)
    {
        return MF_E_SHUTDOWN;
    }
    *thin = FALSE;
    *rate = 1.0f;
    return S_OK;
}

class CClassFactory : public IClassFactory
{
public:
    CClassFactory() : m_ref(1)
    {
        InterlockedIncrement(&g_objectCount);
    }

    virtual ~CClassFactory()
    {
        InterlockedDecrement(&g_objectCount);
    }

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override
    {
        if (!ppv)
        {
            return E_POINTER;
        }
        *ppv = nullptr;
        if (riid == IID_IUnknown || riid == IID_IClassFactory)
        {
            *ppv = static_cast<IClassFactory*>(this);
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }

    STDMETHODIMP_(ULONG) AddRef() override
    {
        return static_cast<ULONG>(InterlockedIncrement(&m_ref));
    }

    STDMETHODIMP_(ULONG) Release() override
    {
        ULONG ref = static_cast<ULONG>(InterlockedDecrement(&m_ref));
        if (ref == 0)
        {
            delete this;
        }
        return ref;
    }

    STDMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** ppv) override
    {
        if (outer)
        {
            return CLASS_E_NOAGGREGATION;
        }
        if (!ppv)
        {
            return E_POINTER;
        }
        *ppv = nullptr;

        CVirtualCameraActivator* activator = new (std::nothrow) CVirtualCameraActivator();
        if (!activator)
        {
            return E_OUTOFMEMORY;
        }
        HRESULT hr = activator->Initialize();
        if (SUCCEEDED(hr))
        {
            hr = activator->QueryInterface(riid, ppv);
        }
        activator->Release();
        return hr;
    }

    STDMETHODIMP LockServer(BOOL lock) override
    {
        if (lock)
        {
            InterlockedIncrement(&g_objectCount);
        }
        else
        {
            InterlockedDecrement(&g_objectCount);
        }
        return S_OK;
    }

private:
    volatile LONG m_ref;
};

static HRESULT SetKeyString(HKEY key, LPCWSTR name, LPCWSTR value)
{
    return RegSetValueExW(key, name, 0, REG_SZ, reinterpret_cast<const BYTE*>(value),
        static_cast<DWORD>((wcslen(value) + 1) * sizeof(wchar_t)));
}

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, void** ppv)
{
    if (!ppv)
    {
        return E_POINTER;
    }
    *ppv = nullptr;
    if (clsid != CLSID_PhoneVirtualCameraSource)
    {
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    CClassFactory* factory = new (std::nothrow) CClassFactory();
    if (!factory)
    {
        return E_OUTOFMEMORY;
    }
    HRESULT hr = factory->QueryInterface(riid, ppv);
    factory->Release();
    return hr;
}

STDAPI DllCanUnloadNow()
{
    return g_objectCount == 0 ? S_OK : S_FALSE;
}

STDAPI DllRegisterServer()
{
    wchar_t modulePath[MAX_PATH] = {};
    if (!GetModuleFileNameW(g_module, modulePath, MAX_PATH))
    {
        return HRESULT_FROM_WIN32(GetLastError());
    }

    wchar_t clsid[64] = {};
    if (StringFromGUID2(CLSID_PhoneVirtualCameraSource, clsid, 64) == 0)
    {
        return E_FAIL;
    }

    wchar_t keyPath[256] = {};
    swprintf_s(keyPath, L"Software\\Classes\\CLSID\\%s", clsid);

    HKEY clsidKey = nullptr;
    LSTATUS status = RegCreateKeyExW(HKEY_LOCAL_MACHINE, keyPath, 0, nullptr, 0, KEY_WRITE, nullptr, &clsidKey, nullptr);
    if (status != ERROR_SUCCESS)
    {
        return HRESULT_FROM_WIN32(status);
    }
    SetKeyString(clsidKey, nullptr, kSourceName);

    HKEY inprocKey = nullptr;
    status = RegCreateKeyExW(clsidKey, L"InprocServer32", 0, nullptr, 0, KEY_WRITE, nullptr, &inprocKey, nullptr);
    if (status == ERROR_SUCCESS)
    {
        SetKeyString(inprocKey, nullptr, modulePath);
        SetKeyString(inprocKey, L"ThreadingModel", L"Both");
        RegCloseKey(inprocKey);
    }
    RegCloseKey(clsidKey);

    return status == ERROR_SUCCESS ? S_OK : HRESULT_FROM_WIN32(status);
}

STDAPI DllUnregisterServer()
{
    wchar_t clsid[64] = {};
    if (StringFromGUID2(CLSID_PhoneVirtualCameraSource, clsid, 64) == 0)
    {
        return E_FAIL;
    }
    wchar_t keyPath[256] = {};
    swprintf_s(keyPath, L"Software\\Classes\\CLSID\\%s", clsid);
    LSTATUS status = RegDeleteTreeW(HKEY_LOCAL_MACHINE, keyPath);
    return status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND ? S_OK : HRESULT_FROM_WIN32(status);
}

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID reserved)
{
    UNREFERENCED_PARAMETER(reserved);
    if (reason == DLL_PROCESS_ATTACH)
    {
        g_module = module;
        DisableThreadLibraryCalls(module);
    }
    return TRUE;
}
