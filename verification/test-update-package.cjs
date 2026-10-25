/* Independent, read-only verification of PREPARE-UPDATE.ps1 outputs.
 * node verification/test-update-package.cjs --directory <signed-output>
 *   --portable <final-portable-directory> --repository owner/repo --version 0.1.1
 *   [--public-key source/src-tauri/update-public-key.json]
 *   [--report verification/current/<unique-folder>/update-package.json]
 * Reads only public signing material and the four application files. Never
 * executes the candidate, signs anything, or reads a Data/account directory.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const FILES = ['HumbleLibrary.exe', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
const MAX_PAYLOAD = 96 * 1024 * 1024;
const MAX_UNPACKED = 160 * 1024 * 1024;
const checks = [];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (name, action) => { action(); checks.push(name); };
const keysExactly = (value, names, message) => assert.deepEqual(Object.keys(value).sort(), [...names].sort(), message);

function noLinks(target) {
  let part = path.resolve(target);
  while (true) {
    if (fs.existsSync(part)) assert(!fs.lstatSync(part).isSymbolicLink(), 'Artifact/report paths cannot traverse links');
    const parent = path.dirname(part);
    if (parent === part) break;
    part = parent;
  }
}
function readFile(target, limit) {
  noLinks(target);
  const stat = fs.lstatSync(target);
  assert(stat.isFile() && stat.size > 0 && stat.size <= limit, `Invalid bounded artifact file: ${path.basename(target)}`);
  const bytes = fs.readFileSync(target);
  assert.equal(bytes.length, stat.size, 'Artifact changed while being read');
  return bytes;
}
function parseJson(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text);
}
function publicKey(bytes) {
  const value = parseJson(bytes);
  keysExactly(value, ['algorithm', 'key'], 'Unexpected public key fields');
  assert.equal(value.algorithm, 'ecdsa-p256-sha256-p1363');
  const blob = Buffer.from(value.key, 'base64');
  assert.equal(blob.length, 72, 'Expected a Windows P-256 public blob');
  assert.equal(blob.readUInt32LE(0), 0x31534345, 'Wrong CNG key algorithm');
  assert.equal(blob.readUInt32LE(4), 32, 'Wrong CNG coordinate length');
  return crypto.createPublicKey({ format: 'jwk', key: {
    kty: 'EC', crv: 'P-256', x: blob.subarray(8, 40).toString('base64url'), y: blob.subarray(40, 72).toString('base64url'),
  } });
}
function signatureBytes(bytes) {
  const text = bytes.toString('ascii').trim();
  assert(/^[A-Za-z0-9+/]{86}==$/.test(text), 'Expected canonical base64 P1363 signature');
  const signature = Buffer.from(text, 'base64');
  assert.equal(signature.length, 64, 'Expected 64-byte P1363 signature');
  assert.equal(signature.toString('base64'), text, 'Noncanonical signature encoding');
  return signature;
}
function verifySignature(manifestBytes, signature, key) {
  return crypto.verify('sha256', manifestBytes, { key, dsaEncoding: 'ieee-p1363' }, signature);
}
function validateManifest(manifest, repository, version) {
  keysExactly(manifest, ['schema', 'application', 'repository', 'version', 'channel', 'target', 'appSha256', 'portable']);
  keysExactly(manifest.portable, ['name', 'url', 'size', 'sha256']);
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.application, 'HumbleLibrary');
  assert.equal(manifest.repository, repository);
  assert.equal(manifest.version, version);
  assert.equal(manifest.channel, 'stable');
  assert.equal(manifest.target, 'windows-x64');
  assert(/^[a-f0-9]{64}$/.test(manifest.appSha256));
  const expected = `HumbleLibrary-${version}-Windows-x64.hlupdate`;
  assert.equal(manifest.portable.name, expected);
  assert.equal(manifest.portable.url, `https://github.com/${repository}/releases/download/v${version}/${expected}`);
  assert(Number.isSafeInteger(manifest.portable.size) && manifest.portable.size > 0 && manifest.portable.size <= MAX_PAYLOAD);
  assert(/^[a-f0-9]{64}$/.test(manifest.portable.sha256));
}
function decodeBundle(bundle, version) {
  keysExactly(bundle, ['schema', 'version', 'files']);
  assert.equal(bundle.schema, 1);
  assert.equal(bundle.version, version);
  assert(Array.isArray(bundle.files));
  assert.equal(bundle.files.length, FILES.length, 'Payload must contain exactly four fixed app files');
  const decoded = new Map();
  let total = 0;
  for (const entry of bundle.files) {
    keysExactly(entry, ['name', 'data']);
    assert(FILES.includes(entry.name) && !decoded.has(entry.name), 'Unknown or repeated payload path');
    assert(typeof entry.data === 'string' && entry.data.length <= Math.ceil(MAX_PAYLOAD / 3) * 4, 'Payload entry is too large');
    const bytes = Buffer.from(entry.data, 'base64');
    assert.equal(bytes.toString('base64'), entry.data, 'Noncanonical payload base64');
    assert(bytes.length > 0 && bytes.length <= MAX_PAYLOAD, 'Empty or oversized payload file');
    total += bytes.length;
    assert(total <= MAX_UNPACKED, 'Decoded payload is too large');
    decoded.set(entry.name, bytes);
  }
  assert(FILES.every(name => decoded.has(name)));
  return decoded;
}
function peVersions(bytes) {
  assert.equal(bytes.subarray(0, 2).toString('ascii'), 'MZ', 'Application is not a PE file');
  const pe = bytes.readUInt32LE(0x3c);
  assert(pe >= 64 && pe + 26 < bytes.length, 'Invalid PE header location');
  assert.equal(bytes.readUInt32LE(pe), 0x00004550, 'Missing PE signature');
  assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, 'Expected x64 application');
  assert.equal(bytes.readUInt16LE(pe + 24), 0x020b, 'Expected PE32+ application');
  const label = Buffer.from('VS_VERSION_INFO\0', 'utf16le');
  const versions = [];
  for (let offset = 0; offset < bytes.length;) {
    const key = bytes.indexOf(label, offset);
    if (key < 0) break;
    offset = key + label.length;
    if (key < 6) continue;
    const value = (key + label.length + 3) & ~3;
    if (value + 52 > bytes.length || bytes.readUInt16LE(key - 4) !== 52 || bytes.readUInt32LE(value) !== 0xfeef04bd) continue;
    const format = (ms, ls) => `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
    versions.push({ file: format(bytes.readUInt32LE(value + 8), bytes.readUInt32LE(value + 12)), product: format(bytes.readUInt32LE(value + 16), bytes.readUInt32LE(value + 20)) });
  }
  assert(versions.length > 0, 'Application has no valid fixed file-version resource');
  return versions;
}
function main() {
  const args = process.argv.slice(2), values = {};
  for (let index = 0; index < args.length; index += 2) {
    assert(args[index].startsWith('--') && args[index + 1] && !args[index + 1].startsWith('--'), 'Arguments must be --name value');
    assert(['--directory', '--portable', '--repository', '--version', '--public-key', '--report'].includes(args[index]), 'Unknown verifier argument');
    assert(!(args[index] in values), 'Repeated verifier argument');
    values[args[index]] = args[index + 1];
  }
  for (const flag of ['--directory', '--portable', '--repository', '--version']) assert(values[flag], `Required argument: ${flag}`);
  const repository = values['--repository'], version = values['--version'];
  assert(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version), 'Only canonical stable versions are accepted');
  assert(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(repository) && !repository.endsWith('.git') && !['.', '..'].includes(repository.split('/')[1]), 'Invalid repository');
  const directory = path.resolve(values['--directory']), portable = path.resolve(values['--portable']);
  const publicPath = path.resolve(values['--public-key'] || path.join(__dirname, '../source/src-tauri/update-public-key.json'));
  const manifestBytes = readFile(path.join(directory, 'update-manifest.json'), 65536);
  const signatureFile = readFile(path.join(directory, 'update-manifest.sig'), 256);
  const publicBytes = readFile(publicPath, 4096);
  const key = publicKey(publicBytes), signature = signatureBytes(signatureFile), manifest = parseJson(manifestBytes);
  check('Manifest signature validates against the pinned public key using independent Node/OpenSSL P1363 verification', () => assert(verifySignature(manifestBytes, signature, key)));
  check('Application, repository, stable version, target and exact GitHub payload URL are bound', () => validateManifest(manifest, repository, version));
  check('Manifest tampering invalidates the signature', () => { const changed = Buffer.from(manifestBytes); changed[Math.floor(changed.length / 2)] ^= 1; assert(!verifySignature(changed, signature, key)); });
  check('Signature tampering is rejected', () => { const changed = Buffer.from(signature); changed[9] ^= 1; assert(!verifySignature(manifestBytes, changed, key)); });
  const payload = readFile(path.join(directory, manifest.portable.name), MAX_PAYLOAD);
  check('Compressed payload size and SHA-256 exactly match the signed manifest', () => { assert.equal(payload.length, manifest.portable.size); assert.equal(sha(payload), manifest.portable.sha256); });
  check('Payload tampering changes its signed digest', () => { const changed = Buffer.from(payload); changed[0] ^= 1; assert.notEqual(sha(changed), manifest.portable.sha256); });
  const bundle = parseJson(zlib.gunzipSync(payload, { maxOutputLength: MAX_UNPACKED }));
  const files = decodeBundle(bundle, version);
  check('Payload contains only four fixed app files; no Data, profile, marker, helper, traversal or unknown path', () => assert.deepEqual([...files.keys()].sort(), [...FILES].sort()));
  const fileEvidence = [];
  for (const name of FILES) {
    const original = readFile(path.join(portable, name), MAX_PAYLOAD), decoded = files.get(name);
    check(`Payload ${name} matches final portable bytes`, () => assert(original.equals(decoded), `Payload differs from final portable: ${name}`));
    fileEvidence.push({ name, size: decoded.length, sha256: sha(decoded) });
  }
  check('Signed application hash matches the final executable', () => assert.equal(sha(files.get('HumbleLibrary.exe')), manifest.appSha256));
  const versions = peVersions(files.get('HumbleLibrary.exe'));
  check('Embedded PE file/product versions equal the signed update version', () => { for (const found of versions) { assert.equal(found.file, `${version}.0`); assert.equal(found.product, `${version}.0`); } });
  const receipt = parseJson(readFile(path.join(directory, 'update-receipt.json'), 65536));
  check('Signer receipt matches repository/version and exact three public output hashes', () => {
    keysExactly(receipt, ['version', 'repository', 'files']); assert.equal(receipt.version, version); assert.equal(receipt.repository, repository);
    assert(Array.isArray(receipt.files) && receipt.files.length === 3);
    const expected = new Map([[manifest.portable.name, payload], ['update-manifest.json', manifestBytes], ['update-manifest.sig', signatureFile]]);
    for (const item of receipt.files) { keysExactly(item, ['name', 'size', 'sha256']); assert(expected.has(item.name)); const bytes = expected.get(item.name); assert.equal(item.size, bytes.length); assert.equal(item.sha256, sha(bytes)); expected.delete(item.name); }
    assert.equal(expected.size, 0);
  });
  for (const forbidden of ['../HumbleLibrary.exe', 'Data/library.dpapi', 'Account/profile', 'portable.marker', 'helper.ps1', 'humblelibrary.exe']) {
    check(`Independent decoder rejects forbidden entry ${forbidden}`, () => assert.throws(() => decodeBundle({ schema: 1, version, files: FILES.map((name, index) => ({ name: index === 0 ? forbidden : name, data: 'Zml4dHVyZQ==' })) }, version)));
  }
  const report = { schema: 1, result: 'passed', scope: 'Independent signed package verification only; no native update transition or live account operation', at: new Date().toISOString(), version, repository, checkCount: checks.length, checks,
    manifestSha256: sha(manifestBytes), signatureSha256: sha(signatureFile), pinnedPublicKeyFileSha256: sha(publicBytes), payload: { name: manifest.portable.name, size: payload.length, sha256: sha(payload) }, files: fileEvidence, embeddedVersions: versions };
  if (values['--report']) {
    const reportPath = path.resolve(values['--report']), evidenceRoot = path.resolve(__dirname, 'current'), relative = path.relative(evidenceRoot, reportPath);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Reports must stay in verification/current');
    noLinks(reportPath); fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(`FAIL update package: ${error.message}`); process.exitCode = 1; }
}
module.exports = { decodeBundle, peVersions, validateManifest, publicKey, verifySignature };
