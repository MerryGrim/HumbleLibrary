import type { KeyItem } from './types';
import { tr } from './i18n';

/** Keep the original case and punctuation: different stores use different key formats. */
export function exportableItems(items: KeyItem[]): KeyItem[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const value = item.key?.trim();
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export function exportKeysTxt(items: KeyItem[]): string {
  const keys = exportableItems(items).map(item => item.key!.trim());
  return keys.length ? keys.join('\r\n') + '\r\n' : '';
}

const labels = { hidden: 'Не раскрыт', revealed: 'Раскрыт', unavailable: 'Недоступен', external: 'На сайте издателя' };
function csvCell(value: string): string {
  // Excel must treat supplier names and key values as text, never as formulas.
  const text = /^[\s]*[=+@\-]/.test(value) ? "'" + value : value;
  return '"' + text.replace(/"/g, '""') + '"';
}

/** CSV includes every product, so unavailable keys remain visible in the inventory. */
export function exportItemsCsv(items: KeyItem[]): string {
  const rows = [[tr('Название'), tr('Площадка'), tr('Ключ'), tr('Состояние'), tr('Инструкция'), tr('Страница активации')],
    ...items.map(item => [item.title, item.platform, item.key ?? '', tr(labels[item.status]), item.instructions ?? '', item.redeemUrl ?? ''])];
  return '\ufeff' + rows.map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

export function suggestExportName(title: string, extension: 'txt' | 'csv'): string {
  let name = title.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 120);
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = 'Humble-bundle';
  return `${name}.${extension}`;
}
