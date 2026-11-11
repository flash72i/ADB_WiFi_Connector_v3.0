$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Join-Path $root 'android-cam'
$out = Join-Path $repo 'build'
$apk = Join-Path $root 'android-cam.apk'

$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$jdk = $env:JAVA_HOME
if (-not $jdk) { throw 'JAVA_HOME is not set. Install JDK 21 and set JAVA_HOME.' }

$buildTools = Get-ChildItem -LiteralPath (Join-Path $sdk 'build-tools') -Directory -ErrorAction Stop |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
$platform = Get-ChildItem -LiteralPath (Join-Path $sdk 'platforms') -Directory -ErrorAction Stop |
    Where-Object { $_.Name -match '^android-\d+$' } |
    Sort-Object { [int]($_.Name -replace '^android-', '') } -Descending | Select-Object -First 1
if (-not $buildTools -or -not $platform) { throw "Android SDK build-tools/platform not found under $sdk" }

$jar = Join-Path $platform.FullName 'android.jar'
$javac = Join-Path $jdk 'bin\javac.exe'
$keytool = Join-Path $jdk 'bin\keytool.exe'
$d8 = Join-Path $buildTools.FullName 'd8.bat'
$aapt2 = Join-Path $buildTools.FullName 'aapt2.exe'
$aapt = Join-Path $buildTools.FullName 'aapt.exe'
$zipalign = Join-Path $buildTools.FullName 'zipalign.exe'
$apksigner = Join-Path $buildTools.FullName 'apksigner.bat'
$keystore = Join-Path $repo 'debug.keystore'

$env:JAVA_HOME = $jdk
$env:PATH = (Join-Path $jdk 'bin') + ';' + $env:PATH

Remove-Item -LiteralPath $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $out 'classes') | Out-Null

$javaFiles = @(Get-ChildItem -LiteralPath (Join-Path $repo 'app\src') -Recurse -Filter '*.java' | Select-Object -ExpandProperty FullName)
& $javac -nowarn -source 8 -target 8 -bootclasspath "$jar;$($buildTools.FullName)\core-lambda-stubs.jar" -d (Join-Path $out 'classes') $javaFiles
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

$classFiles = @(Get-ChildItem -LiteralPath (Join-Path $out 'classes') -Recurse -Filter '*.class' | Select-Object -ExpandProperty FullName)
& $d8 --min-api 21 --lib "$jar" --output "$out" $classFiles
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }

$resDir = Join-Path $repo 'app\res'
$resZip = Join-Path $out 'res.zip'
& $aapt2 compile --dir $resDir -o $resZip
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }

& $aapt2 link -I "$jar" --manifest (Join-Path $repo 'app\AndroidManifest.xml') $resZip --min-sdk-version 21 --target-sdk-version 32 -o (Join-Path $out 'unsigned.apk')
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

Push-Location $out
try {
    & $aapt add -f unsigned.apk classes.dex
    if ($LASTEXITCODE -ne 0) { throw 'aapt add failed' }
} finally {
    Pop-Location
}

& $zipalign -p -f 4 (Join-Path $out 'unsigned.apk') (Join-Path $out 'aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

if (-not (Test-Path -LiteralPath $keystore)) {
    & $keytool -genkeypair -keystore $keystore -storepass android -keypass android -alias androidcam -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=android-cam'
    if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
}

& $apksigner sign --ks $keystore --ks-pass pass:android --key-pass pass:android --out $apk (Join-Path $out 'aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }

Write-Output "APK: $apk"
