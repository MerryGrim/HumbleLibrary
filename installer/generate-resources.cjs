// Deterministic installer UI resources. No account data or private signing material.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = __dirname;
const checkOnly = process.argv.includes('--check');
const languages = JSON.parse(fs.readFileSync(path.join(root, 'languages.json'), 'utf8'));
const expectedCodes = ['ru', 'en', 'de', 'it', 'es', 'fr', 'zh', 'ja', 'ko'];
if (JSON.stringify(languages.map(value => value.code)) !== JSON.stringify(expectedCodes)) throw Error('Installer needs all nine application languages in the agreed order.');
const customKeys = Object.keys(languages[0].custom).sort();
for (const language of languages) {
  if (Object.keys(language.custom).sort().join('\n') !== customKeys.join('\n') || language.errors.length !== 4) throw Error(`Incomplete installer messages: ${language.code}`);
  for (const value of [language.name, language.title, language.hint, language.next, language.close, language.licenseIntro, ...language.errors, ...Object.values(language.custom)]) if (typeof value !== 'string' || !value.trim() || /[\u0000\r\n]/.test(value)) throw Error(`Invalid installer message: ${language.code}`);
}
const write = (name, value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  const target = path.join(root, name);
  if (checkOnly) { if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) throw Error(`Generated installer resource is stale: ${name}`); }
  else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); }
};
const literal = value => `L${JSON.stringify(value)}`;
const array = (name, values) => `constexpr const wchar_t* ${name}[LanguageCount] = {${values.map(literal).join(', ')}};`;
write('InstallerLanguages.h', '// Generated from languages.json; run node installer/generate-resources.cjs.\n#pragma once\nconstexpr int LanguageCount = 9;\n'
  + [array('LanguageCodes', languages.map(value => value.inno)), array('LanguageNames', languages.map(value => value.name)), array('Titles', languages.map(value => value.title)), array('Hints', languages.map(value => value.hint)), array('NextTexts', languages.map(value => value.next)), array('CloseTexts', languages.map(value => value.close))].join('\n')
  + '\nconstexpr const wchar_t* ErrorMessages[4][LanguageCount] = {\n' + [0, 1, 2, 3].map(index => '  {' + languages.map(value => literal(value.errors[index])).join(', ') + '}').join(',\n') + '\n};\n');
write('InstallerLanguages.iss', '\ufeff; Generated from languages.json. Original MIT text remains unchanged in every language.\n[Languages]\n'
  + languages.map(value => `Name: "${value.inno}"; MessagesFile: "compiler:${value.messages}"; LicenseFile: "licenses\\HumbleLibrary-${value.code}.txt"`).join('\n')
  + '\n\n[CustomMessages]\n' + languages.flatMap(value => Object.entries(value.custom).map(([key, text]) => `${value.inno}.${key}=${text}`)).join('\n') + '\n');
const mit = fs.readFileSync(path.join(root, '../LICENSE'));
const mintLicense = fs.readFileSync(path.join(root, 'licenses/MiraMint-MIT.txt'));
const stlLicense = fs.readFileSync(path.join(root, 'licenses/bootstrap/Microsoft-STL-LICENSE.txt'));
const receipts = [];
for (const language of languages) {
  const file = `HumbleLibrary-${language.code}.txt`;
  const bytes = Buffer.concat([Buffer.from('\ufeff' + language.licenseIntro + '\r\n\r\nMira Mint installer components\r\n\r\n', 'utf8'), mintLicense,
    Buffer.from('\r\n\r\nMicrosoft STL / static installer-bootstrap runtime notice\r\n\r\n', 'utf8'), stlLicense, Buffer.from('\r\n\r\nHumble Library\r\n\r\n', 'utf8'), mit]);
  write(`licenses/${file}`, bytes);
  receipts.push({ language: language.code, file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}
write('licenses/manifest.json', JSON.stringify({ schema: 1, projectLicenseSha256: crypto.createHash('sha256').update(mit).digest('hex'), installerComponentLicenseSha256: crypto.createHash('sha256').update(mintLicense).digest('hex'), microsoftStlLicenseSha256: crypto.createHash('sha256').update(stlLicense).digest('hex'), agreements: receipts }, null, 2) + '\n');
console.log(`${checkOnly ? 'Verified' : 'Generated'} nine installer languages and byte-preserved MIT agreements.`);
