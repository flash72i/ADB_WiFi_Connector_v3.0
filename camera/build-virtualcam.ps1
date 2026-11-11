$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $root 'src'
$out = Join-Path $root 'bin'
$vcvars = $env:VCVARS64
if (-not $vcvars) { $vcvars = 'C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat' }
if (-not (Test-Path -LiteralPath $vcvars)) {
    throw "vcvars64.bat not found: $vcvars. Set VCVARS64 to the Visual Studio Build Tools environment script."
}

New-Item -ItemType Directory -Force -Path $out | Out-Null

$source = Join-Path $src 'VirtualCameraSource.cpp'
$def = Join-Path $src 'VirtualCameraSource.def'
$driver = Join-Path $src 'VirtualCameraDriver.cpp'
$dll = Join-Path $out 'VirtualCameraSource.dll'
$exe = Join-Path $out 'PhoneVirtualCam.exe'

$lines = @(
    "call `"$vcvars`" >nul",
    "cd /d `"$out`"",
    "cl /nologo /std:c++17 /EHsc /W4 /MT /DUNICODE /D_UNICODE /DWINVER=0x0A00000C /D_WIN32_WINNT=0x0A00000C /LD `"$source`" /Fe:`"$dll`" /link /DEF:`"$def`" /OUT:`"$dll`" advapi32.lib",
    "if errorlevel 1 exit /b 1",
    "cl /nologo /std:c++17 /EHsc /W4 /MT /DUNICODE /D_UNICODE /DWINVER=0x0A00000C /D_WIN32_WINNT=0x0A00000C `"$driver`" /Fe:`"$exe`" /link /OUT:`"$exe`"",
    "if errorlevel 1 exit /b 1",
    "echo BUILD_OK"
)

$batchPath = Join-Path $env:TEMP ("build-virtualcam-{0}.cmd" -f $PID)
$code = 0
try {
    [System.IO.File]::WriteAllText($batchPath, ($lines -join "`r`n"), [System.Text.Encoding]::Default)
    & cmd.exe /c $batchPath
    $code = $LASTEXITCODE
} finally {
    Remove-Item -LiteralPath $batchPath -Force -ErrorAction SilentlyContinue
}
if ($code -ne 0) { throw "Build failed with exit code $code" }

Write-Output "DLL: $dll"
Write-Output "EXE: $exe"
