import { useSyncExternalStore } from 'react';
import en from './locales/en.json';
import de from './locales/de.json';
import it from './locales/it.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import zh from './locales/zh.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';

export type Language = 'ru' | 'en' | 'de' | 'it' | 'es' | 'fr' | 'zh' | 'ja' | 'ko';
export type LanguagePreference = 'system' | Language;
export const languages: ReadonlyArray<{ value: LanguagePreference; label: string }> = [
  { value: 'system', label: 'Как в системе' },
  { value: 'ru', label: 'Русский' },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
  { value: 'it', label: 'Italiano' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'zh', label: '简体中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
];
const preferenceKey = 'humble-library-language';
const supported = new Set(languages.map(item => item.value));
const catalogs: Record<Exclude<Language, 'ru'>, Record<string, string>> = { en, de, it, es, fr, zh, ja, ko };
const localeNames: Record<Language, string> = { ru: 'ru-RU', en: 'en-US', de: 'de-DE', it: 'it-IT', es: 'es-ES', fr: 'fr-FR', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR' };
const systemLanguage = () => typeof navigator === 'undefined' ? 'en' : navigator.language;

export function resolveLanguage(value: string, system: string): Language {
  const candidate = (value === 'system' ? system : value).toLowerCase().split(/[-_]/)[0];
  return candidate !== 'system' && supported.has(candidate as LanguagePreference) ? candidate as Language : 'en';
}

let preference: LanguagePreference = 'system';
try {
  const saved = localStorage.getItem(preferenceKey);
  if (saved && supported.has(saved as LanguagePreference)) preference = saved as LanguagePreference;
} catch { /* Optional preferences must not block startup. */ }
let language = resolveLanguage(preference, systemLanguage());
const listeners = new Set<() => void>();
const snapshot = () => `${preference}:${language}`;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function notify() {
  language = resolveLanguage(preference, systemLanguage());
  if (typeof document !== 'undefined') document.documentElement.lang = localeNames[language];
  listeners.forEach(listener => listener());
}

/** Only application-authored messages are translated; interpolation values stay exact. */
export function tr(source: string, values?: Record<string, string | number>): string {
  const translated = language === 'ru' ? source : catalogs[language][source] ?? source;
  return values ? translated.replace(/\{([^{}]+)\}/g, (original, name: string) => Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : original) : translated;
}

/** Native diagnostic prefix only; preserve every character of the underlying error. */
export function trError(value: string): string {
  const prefix = 'Обновление: ';
  return value.startsWith(prefix) ? tr('Обновление: {error}', { error: value.slice(prefix.length) }) : tr(value);
}

export function getLocale(): string { return localeNames[language]; }
export function getLanguagePreference(): LanguagePreference { return preference; }
export function setLanguagePreference(value: LanguagePreference): void {
  if (!supported.has(value)) return;
  preference = value;
  try { localStorage.setItem(preferenceKey, value); } catch { /* Keep the current session usable. */ }
  notify();
}
export function useLanguage(): { language: LanguagePreference; locale: string; setLanguage: typeof setLanguagePreference } {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return { language: preference, locale: getLocale(), setLanguage: setLanguagePreference };
}

if (typeof document !== 'undefined') document.documentElement.lang = getLocale();
if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => { if (preference === 'system') notify(); });
  window.addEventListener('storage', event => {
    if (event.key !== preferenceKey) return;
    const value = event.newValue ?? 'system';
    if (supported.has(value as LanguagePreference)) { preference = value as LanguagePreference; notify(); }
  });
}
