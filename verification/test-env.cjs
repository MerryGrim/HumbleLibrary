const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'source');
const outputRoot = path.resolve(process.env.HL_VERIFICATION_OUTPUT || path.join(__dirname, 'current'));

function loadTypescript(relativePath, mocks = {}) {
  const ts = require(require.resolve('typescript', { paths: [sourceRoot] }));
  const cache = new Map();
  const preferences = new Map();
  const globals = { TextEncoder, TextDecoder, URL, Blob, console, navigator: { language: 'ru-RU' }, localStorage: { getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) } };
  function load(filePath) {
  if (cache.has(filePath)) return cache.get(filePath).exports;
  const contents = fs.readFileSync(filePath, 'utf8');
  const result = ts.transpileModule(contents, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filePath,
    reportDiagnostics: true,
  });
  const errors = result.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) || [];
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => sourceRoot,
    getCanonicalFileName: name => name,
    getNewLine: () => '\n',
  }));
  const module = { exports: {} };
  cache.set(filePath, module);
  const fileRequire = createRequire(filePath);
  const requireModule = name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith('.')) {
      const absolute = path.resolve(path.dirname(filePath), name);
      const localTypescript = [absolute, `${absolute}.ts`, `${absolute}.tsx`].find(candidate => /\.tsx?$/.test(candidate) && fs.existsSync(candidate));
      if (localTypescript) return load(localTypescript);
    }
    return fileRequire(name);
  };
  vm.runInNewContext(result.outputText, { module, exports: module.exports, require: requireModule, ...globals }, { filename: filePath });
  return module.exports;
  }
  return load(path.resolve(sourceRoot, relativePath));
}

function loadPlaywright() {
  const configured = process.env.HL_PLAYWRIGHT_MODULE;
  if (configured) return require(path.resolve(configured));
  try { return require(require.resolve('playwright', { paths: [sourceRoot, __dirname] })); }
  catch {
    const bundled = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), '..', '..', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright');
    return require(path.normalize(bundled));
  }
}

module.exports = {
  projectRoot, sourceRoot, outputRoot, loadTypescript, loadPlaywright,
  browserLaunchOptions: { headless: true, channel: 'msedge', args: ['--disable-gpu', '--disable-gpu-compositing'] },
};
