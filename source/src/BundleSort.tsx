import { tr } from './i18n';
import type { BundleSortPreference } from './bundleSorting';
import './BundleSort.css';

export default function BundleSort({ value, onChange }: { value: BundleSortPreference; onChange: (value: BundleSortPreference) => void }) {
  return <label className="bundle-sort"><span>{tr('Сортировка')}</span><select aria-label={tr('Сортировка')} value={value} onChange={event => onChange(event.target.value as BundleSortPreference)}>
    <option value="dateDesc">{tr('Дата покупки: сначала новые')}</option>
    <option value="dateAsc">{tr('Дата покупки: сначала старые')}</option>
    <option value="titleAsc">{tr('Название: А–Я')}</option>
    <option value="titleDesc">{tr('Название: Я–А')}</option>
  </select></label>;
}
