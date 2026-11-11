param(
    [Parameter(Position = 0)][string]$Command = 'list',
    [Parameter(Position = 1)][string]$DeviceId = '',
    [Parameter(Position = 2)][string]$Name = ''
)

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    [PreserveSig] int GetDevice(string id, out IMMDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection
{
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
        [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore properties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
}

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore
{
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetAt(int index, out PROPERTYKEY key);
    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    [PreserveSig] int Commit();
}

[StructLayout(LayoutKind.Sequential)]
struct PROPERTYKEY
{
    public Guid fmtid;
    public int pid;
}

[StructLayout(LayoutKind.Explicit)]
struct PROPVARIANT
{
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(2)] public ushort wReserved1;
    [FieldOffset(4)] public ushort wReserved2;
    [FieldOffset(6)] public ushort wReserved3;
    [FieldOffset(8)] public IntPtr pointerValue;
}

[ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig
{
    [PreserveSig] int GetMixFormat(string pszDeviceName, IntPtr ppFormat);
    [PreserveSig] int GetDeviceFormat(string pszDeviceName, bool bDefault, IntPtr ppFormat);
    [PreserveSig] int ResetDeviceFormat(string pszDeviceName);
    [PreserveSig] int SetDeviceFormat(string pszDeviceName, IntPtr pEndpointFormat, IntPtr mixFormat);
    [PreserveSig] int GetProcessingPeriod(string pszDeviceName, bool bDefault, IntPtr pmftDefaultPeriod, IntPtr pmftMinimumPeriod);
    [PreserveSig] int SetProcessingPeriod(string pszDeviceName, IntPtr pmftPeriod);
    [PreserveSig] int GetShareMode(string pszDeviceName, IntPtr pMode);
    [PreserveSig] int SetShareMode(string pszDeviceName, IntPtr mode);
    [PreserveSig] int GetPropertyValue(string pszDeviceName, bool bFxStore, IntPtr key, IntPtr pv);
    [PreserveSig] int SetPropertyValue(string pszDeviceName, bool bFxStore, IntPtr key, IntPtr pv);
    [PreserveSig] int SetDefaultEndpoint(string pszDeviceName, int role);
    [PreserveSig] int SetEndpointVisibility(string pszDeviceName, bool bVisible);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject
{
}

[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
class PolicyConfigClient
{
}

public sealed class AudioEndpoint
{
    public string id { get; set; }
    public string name { get; set; }
    public bool @default { get; set; }
    public bool @virtual { get; set; }
}

public static class AudioPolicy
{
    private const int Capture = 1;
    private const int Active = 1;
    private const int RoleConsole = 0;
    private const int RoleMultimedia = 1;
    private const int RoleCommunications = 2;
    private const ushort VtLpwstr = 31;

    private static readonly PROPERTYKEY FriendlyName = new PROPERTYKEY
    {
        fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),
        pid = 14
    };

    private static IMMDeviceEnumerator Enumerator()
    {
        return (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
    }

    private static string ReadId(IMMDevice device)
    {
        string id;
        int hr = device.GetId(out id);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        return id;
    }

    private static string ReadName(IMMDevice device)
    {
        IPropertyStore store;
        int hr = device.OpenPropertyStore(0, out store);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);

        PROPERTYKEY key = FriendlyName;
        PROPVARIANT value;
        hr = store.GetValue(ref key, out value);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        if (value.vt != VtLpwstr || value.pointerValue == IntPtr.Zero) return "";
        return Marshal.PtrToStringUni(value.pointerValue) ?? "";
    }

    public static List<AudioEndpoint> ListCapture()
    {
        var result = new List<AudioEndpoint>();
        var enumerator = Enumerator();

        string defaultId = "";
        IMMDevice defaultDevice;
        if (enumerator.GetDefaultAudioEndpoint(Capture, RoleConsole, out defaultDevice) == 0 && defaultDevice != null)
        {
            try { defaultId = ReadId(defaultDevice); }
            catch (Exception) { }
            finally { Marshal.ReleaseComObject(defaultDevice); }
        }

        IMMDeviceCollection collection;
        int hr = enumerator.EnumAudioEndpoints(Capture, Active, out collection);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);

        int count;
        hr = collection.GetCount(out count);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);

        for (int i = 0; i < count; i++)
        {
            IMMDevice device;
            if (collection.Item(i, out device) != 0 || device == null) continue;
            try
            {
                string id = ReadId(device);
                string name = ReadName(device);
                result.Add(new AudioEndpoint
                {
                    id = id,
                    name = name,
                    @default = string.Equals(id, defaultId, StringComparison.OrdinalIgnoreCase),
                    @virtual = name.IndexOf("CABLE", StringComparison.OrdinalIgnoreCase) >= 0
                        || name.IndexOf("VB-Audio", StringComparison.OrdinalIgnoreCase) >= 0
                        || name.IndexOf("Android", StringComparison.OrdinalIgnoreCase) >= 0
                });
            }
            catch (Exception) { }
            finally { Marshal.ReleaseComObject(device); }
        }

        Marshal.ReleaseComObject(collection);
        Marshal.ReleaseComObject(enumerator);
        return result;
    }

    public static void SetDefault(string id)
    {
        if (string.IsNullOrWhiteSpace(id)) throw new ArgumentException("Device id is empty");
        var client = (IPolicyConfig)new PolicyConfigClient();
        int[] roles = { RoleConsole, RoleMultimedia, RoleCommunications };
        foreach (int role in roles)
        {
            int hr = client.SetDefaultEndpoint(id, role);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        }
        Marshal.ReleaseComObject(client);
    }

    public static void Rename(string id, string name)
    {
        if (string.IsNullOrWhiteSpace(id)) throw new ArgumentException("Device id is empty");
        if (string.IsNullOrWhiteSpace(name)) throw new ArgumentException("Device name is empty");

        var enumerator = Enumerator();
        IMMDevice device;
        int hr = enumerator.GetDevice(id, out device);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);

        IPropertyStore store;
        hr = device.OpenPropertyStore(2, out store);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);

        IntPtr text = IntPtr.Zero;
        try
        {
            PROPERTYKEY key = FriendlyName;
            PROPVARIANT value = new PROPVARIANT();
            value.vt = VtLpwstr;
            text = Marshal.StringToCoTaskMemUni(name);
            value.pointerValue = text;

            hr = store.SetValue(ref key, ref value);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            hr = store.Commit();
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        }
        finally
        {
            if (text != IntPtr.Zero) Marshal.FreeCoTaskMem(text);
            Marshal.ReleaseComObject(store);
            Marshal.ReleaseComObject(device);
            Marshal.ReleaseComObject(enumerator);
        }
    }
}
'@

try {
    switch ($Command.ToLowerInvariant()) {
        'list' {
            $items = [AudioPolicy]::ListCapture()
            ConvertTo-Json -InputObject @($items) -Compress -Depth 5
        }
        'set' {
            [AudioPolicy]::SetDefault($DeviceId)
            '{"ok":true}'
        }
        'rename' {
            [AudioPolicy]::Rename($DeviceId, $Name)
            '{"ok":true}'
        }
        default {
            throw "Unknown command: $Command"
        }
    }
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
