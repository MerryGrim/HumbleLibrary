'use strict';
const translations = {
  en: {
    skip: 'Skip to content', navHow: 'Features', eyebrow: 'YOUR COLLECTION. YOUR COMPUTER.',
    headline: 'Every bundle.<br>Every key.<br><span>All in reach.</span>',
    intro: 'A comfortable home for your Humble Bundle library. Find your purchases, reveal your keys and keep them handy — without juggling tabs.',
    compatibility: 'Updated for Humble Bundle’s redesigned sign-in and library.',
    download: 'Download for Windows', allVersions: 'All downloads <span aria-hidden="true">↗</span>', requirements: 'Free · Windows 10/11 x64 · v0.3.4',
    metaSource: 'Open source', metaLocal: 'Stored locally', library: 'Library', demoCount: '4 bundles · 70 items', connected: 'Connected', search: 'Search bundles', newFirst: 'Newest first ↓',
    keys18: '18 items', keys24: '24 items', keys12: '12 items', keys16: '16 items', back: 'All bundles', exampleItems: 'An example key list',
    item1: 'Typography collection', software: 'Software', item2: '3D asset collection', item3: 'Sound library', audio: 'Audio',
    demoExplanation: 'In the app, you can reveal keys here, copy them individually or export the list.',
    localLibrary: 'Your library, on your computer', demoCaption: 'Click a bundle · illustrative demo data', noteTitle: 'More than games', noteText: 'Software, assets, audio and other keys',
    platformLabel: 'ONE LIBRARY FOR', softwareShort: 'Software', andMore: 'And more',
    workflowEyebrow: 'LESS BUSYWORK', workflowTitle: 'From your purchase to your key.<br>Just a few simple steps.',
    step1Title: 'Sign in the familiar way', step1Text: 'The official Humble website opens in a separate window. Two-factor authentication and CAPTCHA stay right where they belong.',
    step2Title: 'Find your bundle', step2Text: 'Browse your bundles, search your collection and sort by date or name. Keep your newest bundles at the top.',
    step3Title: 'Get the keys you need', step3Text: 'Reveal and copy one at a time, or export a bundle to TXT and CSV. Keys are revealed only when you ask.',
    privacyEyebrow: 'KEEPING PERSONAL THINGS PERSONAL', privacyTitle: 'Your library lives with you.', privacyText: 'Your session and data stay on your computer. The library cache is protected with Windows DPAPI. Exports are saved to a file you choose.', privacyLink: 'More about data storage',
    languagesTitle: 'In your language', languagesText: 'Русский, English, Deutsch, Italiano, Español, Français, 中文, 日本語, 한국어. In both the app and installer.',
    updatesTitle: 'Updates without a reinstall', updatesText: 'Check for new versions through GitHub. Download and install when you choose, with package signature verification.',
    readyEyebrow: 'MAKE ROOM FOR YOUR COLLECTION', readyTitle: 'Your library is waiting.', readyText: 'Choose the MiraUI installer or a portable version. Make yourself at home.',
    portable: 'Portable version <span aria-hidden="true">↗</span>', runtime: 'Microsoft Edge WebView2 Runtime required', feedback: 'Feedback',
    disclaimer: 'An independent, unofficial project. Not affiliated with or endorsed by Humble Bundle. Platform names belong to their respective owners. The app does not activate keys in third-party stores.'
  }
};
const russian = Object.fromEntries([...document.querySelectorAll('[data-i18n]')].map(element => [element.dataset.i18n, element.innerHTML]));
let activeLanguage = 'ru';
function setLanguage(language) {
  activeLanguage = language === 'en' ? 'en' : 'ru';
  const dictionary = activeLanguage === 'en' ? translations.en : russian;
  document.documentElement.lang = activeLanguage;
  document.title = activeLanguage === 'en' ? 'Humble Library — every bundle, every key' : 'Humble Library — бандлы и ключи под рукой';
  for (const element of document.querySelectorAll('[data-i18n]')) {
    const translation = dictionary[element.dataset.i18n];
    if (translation !== undefined) element.innerHTML = translation;
  }
  const button = document.getElementById('language');
  button.textContent = activeLanguage === 'en' ? 'RU' : 'EN';
  button.setAttribute('aria-label', activeLanguage === 'en' ? 'Переключить на русский' : 'Switch to English');
  document.querySelector('nav').setAttribute('aria-label', activeLanguage === 'en' ? 'Main navigation' : 'Основная навигация');
  document.querySelector('.app-window').setAttribute('aria-label', activeLanguage === 'en' ? 'Interactive illustration of Humble Library' : 'Интерактивная иллюстрация Humble Library');
  try { localStorage.setItem('humble-library-site-language', activeLanguage); } catch { /* The page works without storage. */ }
}
document.getElementById('language').addEventListener('click', () => setLanguage(activeLanguage === 'en' ? 'ru' : 'en'));
try {
  const saved = localStorage.getItem('humble-library-site-language');
  setLanguage(saved === 'ru' || saved === 'en' ? saved : navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en');
} catch { setLanguage('ru'); }

const bundleTitles = {creative: 'Creative Toolkit', worlds: 'World Builder', indie: 'Indie Essentials', audio: 'Sound Lab'};
let lastBundleButton;
for (const button of document.querySelectorAll('[data-bundle]')) {
  button.addEventListener('click', () => {
    lastBundleButton = button;
    document.getElementById('demo-bundle-title').textContent = bundleTitles[button.dataset.bundle];
    document.getElementById('demo-library').hidden = true;
    document.getElementById('demo-keys').hidden = false;
    document.getElementById('demo-back').focus({preventScroll: true});
  });
}
function closeBundle() {
  document.getElementById('demo-library').hidden = false;
  document.getElementById('demo-keys').hidden = true;
  lastBundleButton?.focus({preventScroll: true});
}
document.getElementById('demo-back').addEventListener('click', closeBundle);
document.querySelector('.app-window').addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.getElementById('demo-keys').hidden) closeBundle();
});
