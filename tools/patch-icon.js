const fs = require('fs');
const { NtExecutable, NtExecutableResource, Resource } = require('resedit');
const IconFile = require('resedit').Data.IconFile;
const [exePath, icoPath, outPath] = process.argv.slice(2);
const pe = NtExecutable.from(fs.readFileSync(exePath));
const res = NtExecutableResource.from(pe);
const ico = IconFile.from(fs.readFileSync(icoPath));
const groups = Resource.IconGroupEntry.fromEntries(res.entries);
for (const g of groups) {
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang || 1033, ico.icons.map(i => i.data));
}
try {
  const viList = Resource.VersionInfo.fromEntries(res.entries);
  for (const vi of viList) {
    vi.setFileVersion('1.0.0'); vi.setProductVersion('1.0.0');
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
      ProductName: 'ADB Wi-Fi Коннектор (RU)',
      FileDescription: 'ADB Wi-Fi Коннектор — беспроводная отладка Android (RU)',
      CompanyName: 'RU clean-room build',
      ProductVersion: '1.0.0', FileVersion: '1.0.0',
      OriginalFilename: 'ADB-WiFi-Connector-RU.exe',
      LegalCopyright: 'MIT; adb (c) Google, Android SDK Platform-Tools'
    }, true);
  }
  console.log('version info set for', viList.length);
} catch (e) { console.log('version info skipped:', e.message); }
res.outputResource(pe);
fs.writeFileSync(outPath, Buffer.from(pe.generate()));
console.log('icons replaced:', groups.length, '->', outPath);
