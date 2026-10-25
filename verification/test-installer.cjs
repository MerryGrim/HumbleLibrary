const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const project = path.resolve(__dirname, '..'), installer = path.join(project, 'installer');
const text = name => fs.readFileSync(path.join(installer, name), 'utf8');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const files = ['HumbleLibrary.exe', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'installed.marker'];
const languages = JSON.parse(text('languages.json'));
const codes = ['ru', 'en', 'de', 'it', 'es', 'fr', 'zh', 'ja', 'ko'];
const iss = text('HumbleLibrary.iss'), bootstrap = text('bootstrap.cpp'), buttons = text('MiraMintButtons.iss'), dialogs = text('MiraMintDialogs.iss');
let checks = 0;
const check = (name, action) => { action(); checks += 1; console.log(`PASS ${name}`); };
check('All nine application languages are present across picker, Inno messages and license pages', () => {
  assert.deepEqual(languages.map(language => language.code), codes);
  assert.equal(new Set(languages.map(language => language.inno)).size, 9);
  assert(text('InstallerLanguages.h').includes('LanguageCount = 9'));
  for (const language of languages) {
    assert(text('InstallerLanguages.h').includes(`L"${language.name}"`));
    assert(text('InstallerLanguages.iss').includes(`Name: "${language.inno}"`));
    for (const key of Object.keys(languages[0].custom)) assert(text('InstallerLanguages.iss').includes(`${language.inno}.${key}=`));
    assert.equal(language.errors.length, 4); assert(language.errors.every(value => typeof value === 'string' && value.trim()));
  }
});
check('Generated resources are current and component/application legal text stays byte-exact', () => {
  cp.execFileSync(process.execPath, [path.join(installer, 'generate-resources.cjs'), '--check'], { stdio: 'pipe' });
  const manifest = JSON.parse(text('licenses/manifest.json')), mit = fs.readFileSync(path.join(project, 'LICENSE'));
  const mint = fs.readFileSync(path.join(installer, 'licenses/MiraMint-MIT.txt')), stl = fs.readFileSync(path.join(installer, 'licenses/bootstrap/Microsoft-STL-LICENSE.txt'));
  assert.equal(manifest.projectLicenseSha256, sha(mit)); assert.equal(manifest.installerComponentLicenseSha256, sha(mint)); assert.equal(manifest.microsoftStlLicenseSha256, sha(stl));
  assert.equal(manifest.agreements.length, 9);
  for (const entry of manifest.agreements) {
    const bytes = fs.readFileSync(path.join(installer, 'licenses', entry.file));
    assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256);
    assert(bytes.subarray(-mit.length).equals(mit)); assert(bytes.includes(mint)); assert(bytes.includes(stl));
    assert(bytes.includes(Buffer.from(languages.find(value => value.code === entry.language).licenseIntro)));
  }
});
check('Only four exact release files and the exact installed marker can enter the payload', () => {
  const section = iss.split('[Files]')[1].split('[Icons]')[0];
  const sources = [...section.matchAll(/^Source: "([^"]+)"/gm)].map(match => match[1]);
  assert.deepEqual(sources, files.map(name => name === 'installed.marker' ? name : `{#InputPath}\\${name}`));
  assert(!/\*|recursesubdirs|createallsubdirs|portable\.marker|Data|\.release-secrets/i.test(section));
  assert.deepEqual(JSON.parse(text('installed.marker')), { schema: 1, application: 'HumbleLibrary', scope: 'current-user' });
  assert.equal(Object.keys(JSON.parse(text('installed.marker'))).length, 3);
});
check('Per-user install never elevates, downloads, launches the client or removes user data recursively', () => {
  for (const value of ['PrivilegesRequired=lowest', 'DefaultDirName={localappdata}\\Programs\\HumbleLibrary', 'CloseApplications=no', 'RestartApplications=no', 'AlwaysRestart=no', 'UninstallFilesDir={app}\\.uninstall']) assert(iss.includes(value), value);
  assert(!/^\[(?:Run|UninstallRun|UninstallDelete|InstallDelete)\]/m.test(iss));
  assert(!/DelTree|DeleteFile|ShellExec|ShellExecute|\bExec\(/.test(iss));
  assert(!/\bShellExecute/.test(bootstrap)); assert(bootstrap.includes('CreateProcessW(inner.c_str()'));
  assert(/desktopicon[^\n]+Flags: unchecked/.test(iss));
});
check('Mira Mint main/popup windows keep integrated X, native button gates, DWM hints and no HRGN mask', () => {
  for (const value of ['WS_CAPTION', 'Style and not WS_CAPTION', "WindowCloseButton.Caption := '×'", 'WizardForm.Close', 'WizardForm.CancelButton.Enabled', 'MintInitializeButtons']) assert(iss.includes(value), value);
  assert(dialogs.includes('MintPopup.BorderStyle := bsNone')); assert(dialogs.includes('CreateCustomForm'));
  assert(dialogs.includes('MintDwmAttribute(Window, 33')); assert(dialogs.includes('MintSetWindowRegion(Window, 0, False)'));
  assert(bootstrap.includes('DWMWCP_ROUND')); assert(bootstrap.includes('WS_POPUP|WS_CLIPCHILDREN'));
  assert(buttons.includes('MintOwnerDraw')); assert(!/SetWindowRgn\([^\n]*CreateRoundRectRgn/.test(bootstrap));
  assert(!/MintRunCommandProof|MintRunPopupProof|MINTBUTTONPROOFONLY|MintProgressProofInclude/.test(iss));
});
check('Directory and readiness guards reject portable/unmanaged destinations without changing their files', () => {
  assert(iss.includes("FileExists(Folder + 'portable.marker')"));
  assert(iss.includes("FileExists(Folder + 'HumbleLibrary.exe') and not FileExists(Folder + 'installed.marker')"));
  assert(iss.includes('function PrepareToInstall')); assert(iss.includes('HumbleTargetAvailable'));
  assert(iss.includes('HumbleOpenExistingFile(FileName, $40000000, 7, 0, 3, 0, 0)'));
  assert(!/CreateFileW[\s\S]*CREATE_ALWAYS/.test(iss));
});
check('QA uses a separate application registration, shortcuts, bootstrap lookup and bounded target', () => {
  const productionId = 'F016A35B-FA4D-4E51-B2D6-6F8E59E6E804', qaId = '143F965D-8D2E-46BA-A48B-A9150F63C7AC';
  assert.notEqual(productionId, qaId); for (const id of [productionId, qaId]) { assert(iss.includes(id)); assert(bootstrap.includes(id)); }
  assert(iss.includes('#ifdef QaFixture')); assert(iss.includes('Humble Library Installer QA'));
  assert(bootstrap.includes('#ifdef HL_SETUP_QA')); assert(bootstrap.includes('HumbleLibrary.Setup.QA.Language'));
  const build = text('build-installer.ps1'); assert(build.includes('verification/current')); assert(build.includes('QA installation target must be inside'));
  assert(build.includes("if ($QaFixture) { '-QA' }")); assert(build.includes('installExecuted=$false'));
});
check('Build derives the version from package metadata and binds frozen files, compilers and all sources', () => {
  const build = text('build-installer.ps1');
  assert(build.includes('source/package.json')); assert(build.includes('.ProductVersion -cne $version')); assert(build.includes('Input contains unknown files'));
  assert(build.includes('Assert-NoLinks')); assert(build.includes('Output already exists')); assert(build.includes('Installer inputs changed during compilation'));
  assert(build.includes('$payloadBefore')); assert(build.includes('$sourcesBefore')); assert(build.includes('compilerSha256='));
  assert(build.includes('source/resources') === false); assert(text('build-bootstrap.ps1').includes('../source/src-tauri/icons/icon.ico'));
  assert(text('build-bootstrap.ps1').includes('/MT')); assert(text('bootstrap.manifest').includes('level="asInvoker"'));
});
check('PowerShell builders parse without executing Setup, application, registration or uninstaller', () => {
  const paths = ['build-installer.ps1', 'build-bootstrap.ps1'].map(name => path.join(installer, name)).concat(path.join(__dirname, 'test-installer-lifecycle.ps1'));
  const encodedPaths = Buffer.from(JSON.stringify(paths)).toString('base64');
  const script = `$ErrorActionPreference='Stop';$paths=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPaths}'))|ConvertFrom-Json;foreach($file in $paths){$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){throw (($errors|ForEach-Object{$_.Message})-join '; ')}};'PASS PowerShell AST'`;
  const result = cp.execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', stdio: 'pipe' });
  assert(result.includes('PASS PowerShell AST'));
});

if (process.argv[2]) {
  check('Optional actual build receipt binds installer bytes and the five owned payload files', () => {
    const receiptPath = path.resolve(process.argv[2]), receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8').replace(/^\ufeff/, ''));
    const bytes = fs.readFileSync(receipt.installer);
    assert.equal(bytes.length, receipt.installerBytes); assert.equal(sha(bytes), receipt.installerSha256); assert.equal(receipt.inputStable, true);
    assert.deepEqual(receipt.languages, codes); assert.deepEqual(receipt.payload.map(value => value.name), files);
    assert.equal(receipt.installExecuted, false); assert.equal(receipt.startsApplication, false); assert.equal(receipt.userDataIncluded, false);
    assert.equal(receipt.bootstrap.outerSha256.toLowerCase(), receipt.installerSha256); assert.equal(receipt.bootstrap.qaFixture, receipt.qaFixture);
    assert(path.basename(receipt.installer).includes(receipt.qaFixture ? '-Setup-QA-Windows-x64.exe' : '-Setup-Windows-x64.exe'));
    for (const entry of receipt.sources) assert.equal(sha(fs.readFileSync(path.join(installer, entry.name))), entry.sha256);
  });
}
console.log(`PASS ${checks} installer source${process.argv[2] ? '/artifact' : ''} checks; no Setup or client execution.`);
