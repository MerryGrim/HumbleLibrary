/* Explicit, read-only smoke test of the public GitHub update channel.
 * node verification/test-live-update.cjs --version 0.2.1 \
 *   --repository MerryGrim/HumbleLibrary --assets Releases/0.2.1
 *   [--report verification/current/live-update-0.2.1.json] [--timeout 90000]
 * Makes anonymous public GET requests only. Never opens the application,
 * accesses accounts/profiles, installs an update, or writes downloaded files.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { validateManifest, publicKey, verifySignature, decodeBundle, peVersions } = require('./test-update-package.cjs');

const root = path.resolve(__dirname, '..');
const MAX_PAYLOAD = 96 * 1024 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function inside(directory, target) {
  const relative = path.relative(directory, target);
  return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function noLinks(target) {
  let current = path.resolve(target);
  while (true) {
    if (fs.existsSync(current)) assert(!fs.lstatSync(current).isSymbolicLink(), 'Verification paths must not traverse links');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function readPublic(target, limit) {
  noLinks(target);
  const stat = fs.lstatSync(target);
  assert(stat.isFile() && stat.size > 0 && stat.size <= limit, 'Invalid bounded local public artifact');
  const bytes = fs.readFileSync(target);
  assert.equal(bytes.length, stat.size, 'Local artifact changed during verification');
  return bytes;
}
function options(args) {
  const supplied = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    assert(['--version', '--repository', '--assets', '--report', '--timeout'].includes(flag), 'Unknown verifier argument');
    assert(value && !value.startsWith('--') && !(flag in supplied), 'Use each --name value argument once');
    supplied[flag] = value;
  }
  const version = supplied['--version'] || JSON.parse(readPublic(path.join(root, 'source/package.json'), 65536)).version;
  const repository = supplied['--repository'] || 'MerryGrim/HumbleLibrary';
  assert(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version), 'Expected a canonical stable version');
  assert(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(repository)
    && !repository.endsWith('.git') && !['.', '..'].includes(repository.split('/')[1]), 'Expected owner/repository');
  const assets = path.resolve(root, supplied['--assets'] || `Releases/${version}`);
  assert(inside(path.join(root, 'Releases'), assets), 'Local comparison files must be in a project release directory');
  const report = path.resolve(root, supplied['--report'] || `verification/current/live-update-${version}-${Date.now()}.json`);
  assert(inside(path.join(root, 'verification/current'), report) && path.extname(report) === '.json', 'Report must be a JSON file in verification/current');
  noLinks(report);
  assert(!fs.existsSync(report), 'Report already exists; choose a fresh path');
  const timeout = Number(supplied['--timeout'] || 90000);
  assert(Number.isInteger(timeout) && timeout >= 10000 && timeout <= 120000, 'Timeout must be 10000 to 120000 milliseconds');
  return { version, repository, assets, report, timeout };
}
async function download(url, limit, signal, redirects = false) {
  let current = url;
  for (let count = 0; count <= 5; count++) {
    const parsed = new URL(current);
    const allowed = redirects ? ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'] : ['api.github.com'];
    assert(parsed.protocol === 'https:' && !parsed.username && !parsed.password && (!parsed.port || parsed.port === '443')
      && allowed.includes(parsed.hostname), 'Unexpected public download origin');
    const response = await fetch(current, {
      method: 'GET', redirect: 'manual', signal, credentials: 'omit',
      headers: { 'User-Agent': 'HumbleLibrary-PublicUpdateVerification', Accept: redirects ? 'application/octet-stream' : 'application/vnd.github+json',
        ...(!redirects ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}) },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      assert(redirects && count < 5, 'Unexpected or excessive public download redirects');
      const location = response.headers.get('location');
      assert(location, 'Public download redirect has no target');
      current = new URL(location, current).href;
      continue;
    }
    assert.equal(response.status, 200, 'Public GitHub request did not return HTTP 200');
    const declared = response.headers.get('content-length');
    assert(declared === null || (/^\d+$/.test(declared) && Number(declared) <= limit), 'Public response exceeds its size bound');
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limit) { await response.body.cancel().catch(() => {}); throw new Error('Public response exceeds its size bound'); }
      chunks.push(chunk);
    }
    assert(length > 0, 'Public response is empty');
    return Buffer.concat(chunks, length);
  }
  throw new Error('Public download redirect limit exceeded');
}
async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Manual anonymous check: node verification/test-live-update.cjs [--version 0.2.1] [--repository MerryGrim/HumbleLibrary] [--assets Releases/0.2.1] [--report verification/current/unique.json] [--timeout 90000]');
    return;
  }
  const config = options(args);
  const report = { schema: 1, at: new Date().toISOString(), result: 'failed', version: config.version, repository: config.repository,
    anonymousPublicRequestsOnly: true, accountDataRead: false, applicationStarted: false, updateInstalled: false,
    limits: 'Public feed, delivery, signature and payload verification only; does not exercise a native update transition.', checks: [], downloads: [] };
  const check = (name, action) => { action(); report.checks.push(name); };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout);
  try {
    const payloadName = `HumbleLibrary-${config.version}-Windows-x64.hlupdate`;
    const names = ['update-manifest.json', 'update-manifest.sig', payloadName];
    const limits = [65536, 256, MAX_PAYLOAD];
    // Read only the selected public release files before making a request.
    const local = names.map((name, index) => readPublic(path.join(config.assets, name), limits[index]));
    const key = publicKey(readPublic(path.join(root, 'source/src-tauri/update-public-key.json'), 4096));
    const api = `https://api.github.com/repos/${config.repository}/releases?per_page=100`;
    const releases = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await download(api, 2 * 1024 * 1024, controller.signal)));
    check('Anonymous GitHub release feed is available', () => assert(Array.isArray(releases), 'Expected a public release list'));
    const matching = releases.filter(release => release.tag_name === `v${config.version}`);
    check('Requested release is unique, published and stable', () => {
      assert.equal(matching.length, 1, 'Requested release is missing or duplicated in public feed');
      assert.equal(matching[0].draft, false, 'Requested release is a draft');
      assert.equal(matching[0].prerelease, false, 'Requested release is a prerelease');
      assert.equal(matching[0].html_url, `https://github.com/${config.repository}/releases/tag/v${config.version}`, 'Unexpected release URL');
      assert(Array.isArray(matching[0].assets), 'Release asset list is missing');
    });
    const release = matching[0];
    const downloaded = [];
    for (let index = 0; index < names.length; index++) {
      const name = names[index], url = `https://github.com/${config.repository}/releases/download/v${config.version}/${name}`;
      const assets = release.assets.filter(asset => asset.name === name);
      check(`Public ${name} metadata matches the local release`, () => {
        assert.equal(assets.length, 1, 'Required release asset is missing or duplicated');
        assert.equal(assets[0].state, 'uploaded', 'Required release asset is not uploaded');
        assert.equal(assets[0].browser_download_url, url, 'Unexpected release asset URL');
        assert.equal(assets[0].size, local[index].length, 'Release asset size differs from local artifact');
      });
      const bytes = await download(url, limits[index], controller.signal, true);
      check(`Public ${name} bytes match the local release`, () => assert(bytes.equals(local[index]), 'Downloaded artifact differs from the frozen local release'));
      downloaded.push(bytes);
      report.downloads.push({ name, url, size: bytes.length, sha256: sha256(bytes) });
    }
    const [manifestBytes, signatureBytes, payload] = downloaded;
    const signatureText = signatureBytes.toString('ascii').trim();
    const signature = Buffer.from(signatureText, 'base64');
    check('Published manifest verifies with the pinned public key', () => {
      assert(/^[A-Za-z0-9+/]{86}==$/.test(signatureText) && signature.length === 64, 'Invalid public signature encoding');
      assert(verifySignature(manifestBytes, signature, key), 'Published manifest signature is invalid');
    });
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
    check('Published manifest binds the intended repository, stable version and payload', () => validateManifest(manifest, config.repository, config.version));
    check('Published payload matches its signed size and SHA-256', () => {
      assert.equal(payload.length, manifest.portable.size, 'Published payload size differs from signed size');
      assert.equal(sha256(payload), manifest.portable.sha256, 'Published payload digest differs from signed digest');
    });
    const files = decodeBundle(JSON.parse(zlib.gunzipSync(payload, { maxOutputLength: 160 * 1024 * 1024 })), config.version);
    check('Published payload contains exactly the approved four application files', () => assert.equal(files.size, 4));
    check('Published application matches the signed executable digest and version', () => {
      const executable = files.get('HumbleLibrary.exe');
      assert.equal(sha256(executable), manifest.appSha256, 'Application digest differs from signed digest');
      for (const version of peVersions(executable)) {
        assert.equal(version.file, `${config.version}.0`, 'Application file version differs from release');
        assert.equal(version.product, `${config.version}.0`, 'Application product version differs from release');
      }
    });
    report.result = 'passed';
  } catch (error) {
    report.error = controller.signal.aborted ? 'Public channel verification timed out' : String(error.message || error).slice(0, 500);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    noLinks(config.report);
    fs.mkdirSync(path.dirname(config.report), { recursive: true });
    fs.writeFileSync(config.report, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ result: report.result, checks: report.checks.length, downloads: report.downloads.length,
      version: config.version, report: path.relative(root, config.report), ...(report.error ? { error: report.error } : {}) }));
  }
}
if (require.main === module) main().catch(error => { console.error(`FAIL public update verification: ${String(error.message || error).slice(0, 500)}`); process.exitCode = 1; });
module.exports = { options, download };
