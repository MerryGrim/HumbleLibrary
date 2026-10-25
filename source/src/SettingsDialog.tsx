import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, ExternalLink, LoaderCircle, RefreshCw, Settings, X } from 'lucide-react';
import { languages, tr, trError, useLanguage } from './i18n';
import Notification from './Notification';

export interface UpdateView {
  currentVersion: string;
  autoCheck: boolean;
  source: string;
  configured: boolean;
  supported?: boolean;
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  message?: string;
  progress?: number;
  release?: { version: string; notes?: string; url?: string; staged?: boolean; size?: number };
}

interface Props {
  update: UpdateView;
  appBusy: boolean;
  onClose: () => void;
  onAutoCheck: (enabled: boolean) => void;
  onRepositorySave: (repository: string) => Promise<void>;
  onCheck: () => void;
  onInstall: () => void;
  onOpenRelease: () => void;
  onDismissMessage: () => void;
}

export default function SettingsDialog({ update, appBusy, onClose, onAutoCheck, onRepositorySave, onCheck, onInstall, onOpenRelease, onDismissMessage }: Props) {
  const { language, setLanguage } = useLanguage();
  const dialog = useRef<HTMLDivElement>(null);
  const [repository, setRepository] = useState(update.source);
  const [saving, setSaving] = useState(false);
  const [repositoryError, setRepositoryError] = useState(false);
  const working = ['checking', 'downloading', 'installing'].includes(update.phase);
  useEffect(() => setRepository(update.source), [update.source]);
  const saveRepository = async () => {
    const value = repository.trim();
    if (value && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/.test(value)) { setRepositoryError(true); return; }
    setRepositoryError(false); setSaving(true);
    try { await onRepositorySave(value); } finally { setSaving(false); }
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => previous?.focus();
  }, []);
  const stateText = update.phase === 'checking' ? tr('Проверяем обновления…')
    : update.phase === 'current' ? tr('Установлена актуальная версия')
    : update.phase === 'available' ? tr('Доступна версия {version}', { version: update.release?.version ?? '' })
    : update.phase === 'downloading' ? tr('Скачиваем обновление…')
    : update.phase === 'ready' ? tr('Обновление готово к установке')
    : update.phase === 'installing' ? tr('Устанавливаем обновление…')
    : update.phase === 'error' ? tr('Не удалось проверить обновления')
    : tr('Проверка ещё не выполнялась');

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === 'Tab') {
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href]') ?? []);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
  }}><div className="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={dialog}>
    <div className="dialog-head"><h2 id="settings-title"><Settings size={20} />{tr('Настройки')}</h2><button className="icon" aria-label={tr('Закрыть настройки')} onClick={onClose}><X size={18} /></button></div>
    <section className="settings-section"><h3>{tr('Интерфейс')}</h3><div className="settings-row"><div><label htmlFor="interface-language">{tr('Язык')}</label><p>{tr('Язык интерфейса приложения')}</p></div><select id="interface-language" value={language} onChange={event => setLanguage(event.target.value as typeof language)}>{languages.map(item => <option key={item.value} value={item.value}>{item.value === 'system' ? tr('Как в системе') : item.label}</option>)}</select></div></section>
    <section className="settings-section"><div className="settings-section-title"><h3>{tr('Обновления')}</h3><span>{tr('Версия {version}', { version: update.currentVersion })}</span></div>
      <label className="auto-update-setting"><input type="checkbox" checked={update.autoCheck} disabled={working || saving} onChange={event => onAutoCheck(event.target.checked)} /><span>{tr('Проверять обновления автоматически')}</span></label>
      <label className="field-label" htmlFor="update-repository">{tr('Репозиторий обновлений')}</label><div className="repository-setting"><input id="update-repository" spellCheck={false} placeholder="owner/repository" value={repository} disabled={working || saving} onChange={event => { setRepository(event.target.value); setRepositoryError(false); }} /><button disabled={working || saving || repository.trim() === update.source} onClick={() => void saveRepository()}>{saving ? tr('Сохраняем…') : tr('Сохранить')}</button></div><p className="repository-hint">{tr('Укажите репозиторий GitHub в формате владелец/репозиторий.')}</p>
      {repositoryError && <div className="settings-notification"><Notification message={tr('Некорректный репозиторий. Используйте формат владелец/репозиторий.')} kind="error" onClose={() => setRepositoryError(false)} /></div>}
      {!update.configured && <p className="update-message">{tr('Репозиторий обновлений пока не задан.')}</p>}
      <div className={`update-status ${update.phase}`} role="status">{working ? <LoaderCircle size={17} className="spin" /> : update.phase === 'current' ? <CheckCircle2 size={17} /> : <RefreshCw size={17} />}<span>{stateText}</span></div>
      {update.message && <div className="settings-notification"><Notification message={trError(update.message)} kind={update.phase === 'error' ? 'error' : update.message === 'Настройки обновлений сохранены.' ? 'success' : 'info'} onClose={onDismissMessage} /></div>}
      {typeof update.progress === 'number' && update.phase === 'downloading' && <progress value={update.progress} max={100} aria-label={tr('Скачивание обновления')} />}
      {update.release?.notes && <details className="release-notes"><summary>{tr('Что нового')}</summary><p>{update.release.notes}</p></details>}
      <div className="settings-update-actions"><button disabled={working} onClick={onCheck}><RefreshCw size={16} className={update.phase === 'checking' ? 'spin' : ''} />{tr('Проверить обновления')}</button>{update.release && ['available', 'ready'].includes(update.phase) && <button className="primary" disabled={appBusy || working || update.supported === false} onClick={onInstall}><Download size={16} />{update.phase === 'ready' ? tr('Установить') : tr('Скачать и установить')}</button>}{update.release?.url && <button className="icon" title={tr('Открыть страницу выпуска')} aria-label={tr('Открыть страницу выпуска')} onClick={onOpenRelease}><ExternalLink size={16} /></button>}</div>
      {update.supported === false && <p className="update-message">{tr('Установка обновлений доступна в установленной или portable-версии.')}</p>}
      {appBusy && update.release && <p className="update-message">{tr('Установку можно начать после завершения текущей операции.')}</p>}
      <div className="update-source"><span>{tr('Источник обновлений')}</span><span>{update.source || tr('Источник пока не настроен')}</span></div>
    </section>
  </div></div>;
}
