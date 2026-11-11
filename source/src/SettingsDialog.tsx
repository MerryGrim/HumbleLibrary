import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, Eraser, ExternalLink, LoaderCircle, LogOut, RefreshCw, Settings, X } from 'lucide-react';
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
  onClearCache: () => Promise<void>;
  onResetLogin: () => Promise<void>;
}

export default function SettingsDialog({ update, appBusy, onClose, onAutoCheck, onRepositorySave, onCheck, onInstall, onOpenRelease, onDismissMessage, onClearCache, onResetLogin }: Props) {
  const { language, setLanguage } = useLanguage();
  const dialog = useRef<HTMLDivElement>(null);
  const [repository, setRepository] = useState(update.source);
  const [saving, setSaving] = useState(false);
  const [repositoryError, setRepositoryError] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [maintenance, setMaintenance] = useState<'cache' | 'login' | null>(null);
  const [maintenanceMessage, setMaintenanceMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const maintenanceLock = useRef(false);
  const resetButton = useRef<HTMLButtonElement>(null);
  const resetCancel = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const working = ['checking', 'downloading', 'installing'].includes(update.phase);
  const dataBlocked = appBusy || working || saving || maintenance !== null;
  const close = () => {
    if (maintenanceLock.current) return;
    if (confirmReset) setConfirmReset(false); else onClose();
  };
  const maintain = async (kind: 'cache' | 'login') => {
    if (maintenanceLock.current || dataBlocked) return;
    maintenanceLock.current = true; setMaintenance(kind); setMaintenanceMessage(null);
    try {
      await (kind === 'cache' ? onClearCache() : onResetLogin());
      setMaintenanceMessage({ text: kind === 'cache' ? 'Кэш сайта очищен.' : 'Вход Humble сброшен. Войдите заново.', kind: 'success' });
      if (kind === 'login') setConfirmReset(false);
    } catch (caught) {
      setMaintenanceMessage({ text: typeof caught === 'string' ? caught : caught instanceof Error ? caught.message : kind === 'cache' ? 'Не удалось очистить кэш сайта.' : 'Не удалось сбросить вход Humble.', kind: 'error' });
    } finally { maintenanceLock.current = false; setMaintenance(null); }
  };
  useEffect(() => {
    if (confirmReset) resetCancel.current?.focus();
    else if (wasConfirming.current) resetButton.current?.focus();
    wasConfirming.current = confirmReset;
  }, [confirmReset]);
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

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href]') ?? []);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
  }}><div className="dialog settings-dialog" role={confirmReset ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="settings-title" aria-describedby={confirmReset ? 'reset-login-description' : undefined} ref={dialog}>
    <div className="dialog-head"><h2 id="settings-title">{confirmReset ? <LogOut size={20} /> : <Settings size={20} />}{tr(confirmReset ? 'Сбросить вход Humble?' : 'Настройки')}</h2><button className="icon" aria-label={tr(confirmReset ? 'Отмена' : 'Закрыть настройки')} disabled={maintenance !== null} onClick={close}><X size={18} /></button></div>
    {maintenanceMessage && <div className="settings-notification"><Notification message={trError(maintenanceMessage.text)} kind={maintenanceMessage.kind} onClose={() => setMaintenanceMessage(null)} /></div>}
    {confirmReset ? <div className="settings-reset-confirmation">
      <p id="reset-login-description">{tr('Потребуется войти в Humble заново. Бандлы, ключи и настройки приложения сохранятся.')}</p>
      <div className="dialog-actions"><button ref={resetCancel} disabled={maintenance !== null} onClick={() => setConfirmReset(false)}>{tr('Отмена')}</button><button className="primary" disabled={dataBlocked} onClick={() => void maintain('login')}>{maintenance === 'login' ? <LoaderCircle size={16} className="spin" /> : <LogOut size={16} />}{tr(maintenance === 'login' ? 'Сбрасываем вход…' : 'Сбросить вход Humble')}</button></div>
    </div> : <>
    <section className="settings-section"><h3>{tr('Интерфейс')}</h3><div className="settings-row"><div><label htmlFor="interface-language">{tr('Язык')}</label><p>{tr('Язык интерфейса приложения')}</p></div><select id="interface-language" value={language} onChange={event => setLanguage(event.target.value as typeof language)}>{languages.map(item => <option key={item.value} value={item.value}>{item.value === 'system' ? tr('Как в системе') : item.label}</option>)}</select></div></section>
    <section className="settings-section settings-data"><h3>{tr('Данные Humble')}</h3>
      <div className="settings-data-row"><div><h4>{tr('Очистить кэш сайта')}</h4><p>{tr('Удалит временные файлы сайта. Вход, библиотека и ключи сохранятся.')}</p></div><button disabled={dataBlocked} onClick={() => void maintain('cache')}>{maintenance === 'cache' ? <LoaderCircle size={16} className="spin" /> : <Eraser size={16} />}{tr(maintenance === 'cache' ? 'Очищаем кэш…' : 'Очистить кэш сайта')}</button></div>
      <div className="settings-data-row"><div><h4>{tr('Сбросить вход Humble')}</h4><p>{tr('Удалит данные входа на сайте. Библиотека и сохранённые ключи останутся в приложении.')}</p></div><button ref={resetButton} disabled={dataBlocked} onClick={() => { setMaintenanceMessage(null); setConfirmReset(true); }}><LogOut size={16} />{tr('Сбросить вход Humble')}</button></div>
      {appBusy && <p className="update-message">{tr('Завершите текущую операцию или закройте окно входа.')}</p>}
    </section>
    <section className="settings-section"><div className="settings-section-title"><h3>{tr('Обновления')}</h3><span>{tr('Версия {version}', { version: update.currentVersion })}</span></div>
      <label className="auto-update-setting"><input type="checkbox" checked={update.autoCheck} disabled={working || saving || maintenance !== null} onChange={event => onAutoCheck(event.target.checked)} /><span>{tr('Проверять обновления автоматически')}</span></label>
      <label className="field-label" htmlFor="update-repository">{tr('Репозиторий обновлений')}</label><div className="repository-setting"><input id="update-repository" spellCheck={false} placeholder="owner/repository" value={repository} disabled={working || saving || maintenance !== null} onChange={event => { setRepository(event.target.value); setRepositoryError(false); }} /><button disabled={working || saving || maintenance !== null || repository.trim() === update.source} onClick={() => void saveRepository()}>{saving ? tr('Сохраняем…') : tr('Сохранить')}</button></div><p className="repository-hint">{tr('Укажите репозиторий GitHub в формате владелец/репозиторий.')}</p>
      {repositoryError && <div className="settings-notification"><Notification message={tr('Некорректный репозиторий. Используйте формат владелец/репозиторий.')} kind="error" onClose={() => setRepositoryError(false)} /></div>}
      {!update.configured && <p className="update-message">{tr('Репозиторий обновлений пока не задан.')}</p>}
      <div className={`update-status ${update.phase}`} role="status">{working ? <LoaderCircle size={17} className="spin" /> : update.phase === 'current' ? <CheckCircle2 size={17} /> : <RefreshCw size={17} />}<span>{stateText}</span></div>
      {update.message && <div className="settings-notification"><Notification message={trError(update.message)} kind={update.phase === 'error' ? 'error' : update.message === 'Настройки обновлений сохранены.' ? 'success' : 'info'} onClose={onDismissMessage} /></div>}
      {typeof update.progress === 'number' && update.phase === 'downloading' && <progress value={update.progress} max={100} aria-label={tr('Скачивание обновления')} />}
      {update.release?.notes && <details className="release-notes"><summary>{tr('Что нового')}</summary><p>{update.release.notes}</p></details>}
      <div className="settings-update-actions"><button disabled={working || maintenance !== null} onClick={onCheck}><RefreshCw size={16} className={update.phase === 'checking' ? 'spin' : ''} />{tr('Проверить обновления')}</button>{update.release && ['available', 'ready'].includes(update.phase) && <button className="primary" disabled={appBusy || working || maintenance !== null || update.supported === false} onClick={onInstall}><Download size={16} />{update.phase === 'ready' ? tr('Установить') : tr('Скачать и установить')}</button>}{update.release?.url && <button className="icon" title={tr('Открыть страницу выпуска')} aria-label={tr('Открыть страницу выпуска')} onClick={onOpenRelease}><ExternalLink size={16} /></button>}</div>
      {update.supported === false && <p className="update-message">{tr('Установка обновлений доступна в установленной или portable-версии.')}</p>}
      {appBusy && update.release && <p className="update-message">{tr('Установку можно начать после завершения текущей операции.')}</p>}
      <div className="update-source"><span>{tr('Источник обновлений')}</span><span>{update.source || tr('Источник пока не настроен')}</span></div>
    </section>
    </>}
  </div></div>;
}
