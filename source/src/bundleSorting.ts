import type { Bundle } from './types';

export type BundleSortPreference = 'dateDesc' | 'dateAsc' | 'titleAsc' | 'titleDesc';
export const bundleSortStorageKey = 'humble-library-bundle-sort';
const preferences: readonly BundleSortPreference[] = ['dateDesc', 'dateAsc', 'titleAsc', 'titleDesc'];
const validPreference = (value: unknown): value is BundleSortPreference => typeof value === 'string' && preferences.includes(value as BundleSortPreference);

function purchaseTimestamp(value: string | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const clean = value.trim();
  // Date.parse normalizes impossible ISO days (for example February 30).
  // Reject those instead of presenting them as a different purchase date.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[Tt\s])/.exec(clean);
  if (iso) {
    const year = Number(iso[1]), month = Number(iso[2]), day = Number(iso[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
  }
  const timestamp = Date.parse(clean);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Sort a new array, preserving source objects, exact titles/keys and input order on ties. */
export function sortBundles(bundles: readonly Bundle[], preference: BundleSortPreference, locale: string): Bundle[] {
  const chosen = validPreference(preference) ? preference : 'dateDesc';
  let collator: Intl.Collator;
  try { collator = new Intl.Collator(locale || undefined, { numeric: true, sensitivity: 'base' }); }
  catch { collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }); }
  const entries = bundles.map((bundle, index) => ({ bundle, index, date: purchaseTimestamp(bundle.purchasedAt) }));
  entries.sort((left, right) => {
    if (chosen === 'dateDesc' || chosen === 'dateAsc') {
      if (left.date === null && right.date !== null) return 1;
      if (left.date !== null && right.date === null) return -1;
      if (left.date !== null && right.date !== null && left.date !== right.date) return chosen === 'dateDesc' ? right.date - left.date : left.date - right.date;
    } else {
      const result = collator.compare(left.bundle.title, right.bundle.title);
      if (result) return chosen === 'titleAsc' ? result : -result;
    }
    return left.index - right.index;
  });
  return entries.map(entry => entry.bundle);
}

function defaultStorage(): Storage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; }
  catch { return undefined; }
}
export function loadBundleSortPreference(storage: Pick<Storage, 'getItem'> | undefined = defaultStorage()): BundleSortPreference {
  try { const value = storage?.getItem(bundleSortStorageKey); return validPreference(value) ? value : 'dateDesc'; }
  catch { return 'dateDesc'; }
}
export function saveBundleSortPreference(preference: BundleSortPreference, storage: Pick<Storage, 'setItem'> | undefined = defaultStorage()): void {
  if (!validPreference(preference)) return;
  try { storage?.setItem(bundleSortStorageKey, preference); } catch { /* Sorting remains usable if optional preferences cannot be saved. */ }
}
