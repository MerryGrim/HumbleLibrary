import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, Copy, Download, ExternalLink, Eye, KeyRound, Library, LoaderCircle, LogIn, LogOut, Maximize2, Minus, Moon, Package, RefreshCw, Search, Settings, Square, Sun, UserRound, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api, type UpdateCheck, type LoginAttempt, type AuthState, type SessionStatus, type LibraryProgress, type SyncActivity } from './api';
import type { Bundle, KeyItem, KeyStatus } from './types';
import { exportableItems, exportItemsCsv, exportKeysTxt, suggestExportName } from './keyExport';
import SettingsDialog, { type UpdateView } from './SettingsDialog';
import Notification from './Notification';
import { getLocale, tr, trError, useLanguage } from './i18n';
import metadata from '../package.json';
import BundleSort from './BundleSort';
import { sortBundles, loadBundleSortPreference, saveBundleSortPreference, type BundleSortPreference } from './bundleSorting';
import './styles.css';

const statusLabel: Record<KeyStatus, string> = { hidden: 'Не раскрыт', revealed: 'Раскрыт', unavailable: 'Недоступен', external: 'На сайте издателя' };
const preview = api.preview;
// Banner loading is paused while the Humble integration is being updated.
const BUNDLE_BANNERS_ENABLED = false;
const partialLibraryWarning = 'Не все бандлы удалось обновить. Ранее сохранённые ключи оставлены в библиотеке.';
const incompleteLibraryWarning = 'Список покупок загружен не полностью. Доступные бандлы сохранены; обновите библиотеку, чтобы продолжить.';
const syncActivityPhases = new Set(['libraryPage', 'librarySchema', 'actionDiscovery', 'purchasedPage', 'purchasedWire', 'purchasedSchema', 'purchasedIdentity', 'purchasedComplete', 'detailPage', 'detailSchema', 'keySchema']);
const platformLabel = (value: string) => !value || value === 'Другая площадка' ? tr('Другая площадка') : value;
type Queue = { done: number; total: number; title: string };
type ExportFormat = 'txt' | 'csv';

function dateLabel(value?: string | null, time = false) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString(getLocale(), time ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

function Cover({ bundle, small = false }: { bundle: Bundle; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [bundle.imageUrl]);
  return <span className={`bundle-cover${small ? ' small' : ''}`}>
    {BUNDLE_BANNERS_ENABLED && bundle.imageUrl && !failed ? <img src={bundle.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <span className="cover-fallback"><Package size={small ? 26 : 42} strokeWidth={1.3} /><span>HUMBLE BUNDLE</span></span>}
  </span>;
}

function BundleRecovery({ bundle, busy, empty = false, onRefresh, onOpen }: { bundle: Bundle; busy: boolean; empty?: boolean; onRefresh: () => void; onOpen: (url: string) => void }) {
  return <div className={empty ? 'no-results' : 'bundle-summary'} role="status"><div>
    <strong>{tr('Ключи не обновлены')}</strong>
    <p>{tr('Ключи этого бандла пока не загружены полностью.')}</p>
    <div className="page-actions"><button disabled={busy} onClick={onRefresh}><RefreshCw size={15} />{tr('Обновить библиотеку')}</button><button disabled={busy} onClick={() => onOpen(bundle.sourceUrl || 'https://www.humblebundle.com/home/library')}><ExternalLink size={14} />{tr('На Humble')}</button></div>
  </div></div>;
}

function Dialog({ title, children, onClose, busy }: { title: string; children: ReactNode; onClose: () => void; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button,select,input')?.focus();
    return () => previous?.focus();
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }} onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); }
    if (event.key === 'Tab') {
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? []);
      if (!nodes.length) { event.preventDefault(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
  }}><div ref={ref} role="dialog" aria-modal="true" aria-labelledby="dialog-title" className="dialog">
    <div className="dialog-head"><h2 id="dialog-title">{title}</h2><button className="icon" aria-label={tr("Закрыть")} disabled={busy} onClick={onClose}><X size={18} /></button></div>
    {children}
  </div></div>;
}

export default function App() {
  const { locale } = useLanguage();
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [authState, setAuthState] = useState<AuthState>('unknown');
  const connected = authState === 'authenticated';
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loginHint, setLoginHint] = useState(false);
  const [bundleSort, setBundleSort] = useState<BundleSortPreference>(loadBundleSortPreference);
  const [authRefreshPulse, setAuthRefreshPulse] = useState(0);
  const [coverRefreshPulse, setCoverRefreshPulse] = useState(0);
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState('');
  const [keyFilter, setKeyFilter] = useState('');
  const [queue, setQueue] = useState<Queue | null>(null);
  const [syncProgress, setSyncProgress] = useState<LibraryProgress | null>(null);
  const [syncActivity, setSyncActivity] = useState<SyncActivity | null>(null);
  const [enumerationComplete, setEnumerationComplete] = useState(true);
  const [syncStopping, setSyncStopping] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('txt');
  const [accountOpen, setAccountOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keyMenu, setKeyMenu] = useState<{ x: number; y: number; item: KeyItem } | null>(null);
  const [update, setUpdate] = useState<UpdateView>({ currentVersion: metadata.version, autoCheck: true, source: '', configured: false, phase: 'idle' });
  const [updateSettingsLoaded, setUpdateSettingsLoaded] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('humble-library-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } });
  const lock = useRef(false), cancelled = useRef(false), accountRef = useRef<HTMLDivElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const bundleBackButton = useRef<HTMLButtonElement>(null);
  const lastBundle = useRef<string | null>(null);
  const bundleButtons = useRef(new Map<string, HTMLButtonElement>());
  const keyMenuRef = useRef<HTMLDivElement>(null), keyMenuOrigin = useRef<HTMLElement | null>(null);
  const updateLock = useRef(false), startupUpdateChecked = useRef(false), updateRef = useRef(update), appBusyRef = useRef(busy);
  const loginInFlight = useRef(false), activeLogin = useRef<string | null>(null), pendingAuthRefresh = useRef<string | null>(null);
  const bufferedLoginEvents = useRef(new Map<string, 'completed' | 'cancelled'>());
  const finishedLogins = useRef(new Set<string>());
  const loginEventHandler = useRef<(kind: 'completed' | 'cancelled', attempt: LoginAttempt) => void>(() => {});
  const pendingCoverRefresh = useRef(false), coverRefreshSuppressed = useRef(false);
  const sessionRevision = useRef(0), sessionListenerReady = useRef<Promise<void>>(Promise.resolve());
  const libraryRevision = useRef(0);
  const syncActive = useRef(false), syncActivityListenerReady = useRef<Promise<void>>(Promise.resolve());
  const acceptAuthState = (value: AuthState) => { sessionRevision.current += 1; setAuthState(value); };
  const acceptSessionStatus = (value: SessionStatus) => {
    if (!value || !['unknown', 'authenticated', 'unauthenticated'].includes(value.authState) || value.connected !== (value.authState === 'authenticated')) return;
    acceptAuthState(value.authState);
  };
  updateRef.current = update; appBusyRef.current = busy;
  const selected = bundles.find(bundle => bundle.id === selectedId) ?? null;
  const revealed = selected ? exportableItems(selected.items) : [];
  const revealedCount = selected?.items.filter(item => !!item.key).length ?? 0;
  const hidden = selected?.items.filter(item => item.status === 'hidden') ?? [];
  const keyCount = bundles.reduce((sum, bundle) => sum + bundle.items.length, 0);
  const visibleBundles = useMemo(() => sortBundles(bundles.filter(bundle => bundle.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), bundleSort, locale), [bundles, query, bundleSort, locale]);
  const platforms = useMemo(() => [...new Set(selected?.items.map(item => item.platform || 'Другая площадка') ?? [])].sort((a, b) => a.localeCompare(b)), [selected]);
  const visibleItems = selected?.items.filter(item => (!platform || (item.platform || 'Другая площадка') === platform) && (!keyFilter || item.status === keyFilter) && item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('humble-library-theme', theme); } catch { /* A theme is optional. */ }
  }, [theme]);
  useEffect(() => { void api.setNativeLanguage(locale.split('-')[0]).catch(() => {}); }, [locale]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { void api.updateReady().catch(() => {}); });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    let mounted = true;
    void api.updateStatus().then(value => { if (mounted) setUpdate(current => ({ ...current, currentVersion: value.currentVersion, autoCheck: value.enabled, source: value.repository, configured: value.configured, supported: value.supported, message: value.lastApplyError || undefined })); }).catch(() => { if (mounted) setUpdate(current => ({ ...current, phase: 'error', message: 'Не удалось прочитать настройки обновлений.' })); }).finally(() => { if (mounted) setUpdateSettingsLoaded(true); });
    let unlisten: (() => void) | undefined;
    void api.onUpdateProgress(value => {
      if (mounted) setUpdate(current => ({ ...current, phase: value.phase === 'installing' ? 'installing' : 'downloading', progress: Math.max(0, Math.min(100, value.percent)) }));
    }).then(dispose => { if (mounted) unlisten = dispose; else dispose(); }).catch(() => {});
    return () => { mounted = false; unlisten?.(); };
  }, []);
  useEffect(() => {
    let mounted = true;
    const revision = sessionRevision.current;
    const dataRevision = libraryRevision.current;
    api.status().then(value => { if (mounted && libraryRevision.current === dataRevision) { setBundles(value.bundles); setEnumerationComplete(value.enumerationComplete !== false); if (sessionRevision.current === revision) acceptSessionStatus({ connected: value.connected, authState: value.authState ?? (value.connected ? 'authenticated' : 'unknown') }); setLastSync(value.lastSync ?? null); if ('warning' in value && typeof value.warning === 'string' && value.warning && value.warning !== incompleteLibraryWarning && value.warning !== tr(incompleteLibraryWarning)) setError(value.warning); else if (value.enumerationComplete !== false && value.bundles.some(bundle => bundle.detailsFailed)) setError(partialLibraryWarning); if (BUNDLE_BANNERS_ENABLED && !coverRefreshSuppressed.current && value.bundles.some(bundle => !bundle.imageUrl?.trim())) { pendingCoverRefresh.current = true; setCoverRefreshPulse(pulse => pulse + 1); } } }).catch(() => { if (mounted && libraryRevision.current === dataRevision) setError('Не удалось прочитать локальную библиотеку. Попробуйте обновить её.'); }).finally(() => { if (mounted && libraryRevision.current === dataRevision) setLoading(false); });
    return () => { mounted = false; cancelled.current = true; };
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);
  useEffect(() => {
    let mounted = true;
    const disposers: Array<() => void> = [];
    const retain = (dispose: () => void) => { if (mounted) disposers.push(dispose); else dispose(); };
    sessionListenerReady.current = api.onSessionStatus(value => { if (mounted) acceptSessionStatus(value); }).then(retain).catch(() => { /* The checking state remains honest if session events are unavailable. */ });
    void api.onProgress(value => {
      if (mounted && syncActive.current && Number.isFinite(value.completed) && Number.isFinite(value.total) && value.total > 0 && value.completed >= 0 && value.completed <= value.total && (value.stage === undefined || value.stage === 'purchases' || value.stage === 'keys')) { setSyncProgress(value); setSyncActivity(null); }
    }).then(retain).catch(() => { /* The operation still works without progress events. */ });
    syncActivityListenerReady.current = api.onSyncActivity(value => {
      if (!mounted || !syncActive.current || !value || !syncActivityPhases.has(value.phase) || !['reading', 'waiting'].includes(value.state) || !Number.isSafeInteger(value.attempt) || value.attempt < 1 || value.attempt > 4 || !Number.isSafeInteger(value.delayMs) || value.delayMs < 0 || value.delayMs > 60000 || value.reason !== undefined && (value.state !== 'waiting' || !['network', 'rateLimited', 'service'].includes(value.reason))) return;
      setSyncActivity(value.state === 'waiting' ? value : null);
    }).then(retain).catch(() => { /* Activity labels are optional; the read still returns its result. */ });
    void api.onWarning(message => { if (mounted && message) { if (message === incompleteLibraryWarning || message === tr(incompleteLibraryWarning)) { setEnumerationComplete(false); setNotice(''); } else setError(message); } }).then(retain).catch(() => { /* Native actions also return their errors. */ });
    return () => { mounted = false; disposers.forEach(dispose => dispose()); };
  }, []);
  useEffect(() => {
    if (!accountOpen) return;
    const dismiss = (event: PointerEvent) => { if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setAccountOpen(false); accountButton.current?.focus(); } };
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape);
    accountRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [accountOpen]);
  const closeKeyMenu = () => {
    setKeyMenu(null);
    if (keyMenuOrigin.current?.isConnected) keyMenuOrigin.current.focus({ preventScroll: true });
  };
  const openKeyMenu = (item: KeyItem, x: number, y: number, origin: HTMLElement) => {
    if (!item.key) return;
    keyMenuOrigin.current = origin;
    origin.focus({ preventScroll: true });
    setAccountOpen(false);
    setKeyMenu({ item, x: Math.max(8, Math.min(x, window.innerWidth - 258)), y: Math.max(8, Math.min(y, window.innerHeight - 64)) });
  };
  useLayoutEffect(() => {
    if (!keyMenu) return;
    keyMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!keyMenuRef.current?.contains(event.target as Node)) closeKeyMenu(); };
    const dismiss = () => closeKeyMenu();
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('blur', dismiss);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true); window.removeEventListener('blur', dismiss); };
  }, [keyMenu]);
  useEffect(() => { setKeyMenu(null); }, [selectedId, settingsOpen, exportOpen]);

  const run = async (name: string, action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; cancelled.current = false; setBusy(name); setError('');
    try { await action(); } catch (caught) {
      if (name === 'sync' && cancelled.current) setNotice('Обновление остановлено. Последняя загруженная библиотека остаётся доступна.');
      else setError(typeof caught === 'string' ? caught : caught instanceof Error ? caught.message : 'Не удалось выполнить действие. Попробуйте ещё раз.');
    }
    finally { lock.current = false; setBusy(''); setQueue(null); if (name === 'sync') { syncActive.current = false; setSyncActivity(null); setSyncProgress(null); setSyncStopping(false); } }
  };
  const updateItem = (bundleId: string, item: KeyItem) => setBundles(current => current.map(bundle => bundle.id === bundleId ? { ...bundle, items: bundle.items.map(previous => previous.id === item.id ? item : previous) } : bundle));
  const openBundle = (id: string | null) => { setKeyMenu(null); setSelectedId(id); setQuery(''); setPlatform(''); setKeyFilter(''); setError(''); };
  useEffect(() => {
    if (selectedId) {
      lastBundle.current = selectedId;
      bundleBackButton.current?.focus();
    } else if (lastBundle.current) bundleButtons.current.get(lastBundle.current)?.focus();
  }, [selectedId]);
  useEffect(() => {
    const navigateBack = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.key !== 'ArrowLeft' || !selectedId || exportOpen || accountOpen || settingsOpen || keyMenu) return;
      event.preventDefault();
      openBundle(null);
    };
    window.addEventListener('keydown', navigateBack);
    return () => window.removeEventListener('keydown', navigateBack);
  }, [selectedId, exportOpen, accountOpen, settingsOpen, keyMenu]);
  loginEventHandler.current = (kind, attempt) => {
    if (!attempt?.attemptId || attempt.attemptId.length > 100 || finishedLogins.current.has(attempt.attemptId)) return;
    if (loginInFlight.current) { bufferedLoginEvents.current.set(attempt.attemptId, kind); return; }
    if (attempt.attemptId !== activeLogin.current) return;
    activeLogin.current = null;
    finishedLogins.current.add(attempt.attemptId);
    if (finishedLogins.current.size > 32) finishedLogins.current.delete(finishedLogins.current.values().next().value!);
    setLoginHint(false);
    if (kind === 'completed') { acceptAuthState('authenticated'); pendingAuthRefresh.current = attempt.attemptId; setAuthRefreshPulse(value => value + 1); }
    else pendingAuthRefresh.current = null;
  };
  const login = () => {
    // An explicit sign-in owns the next refresh, even if cached metadata arrives later.
    coverRefreshSuppressed.current = true; pendingCoverRefresh.current = false;
    return run('login', async () => {
    setAccountOpen(false);
    loginInFlight.current = true; activeLogin.current = null; pendingAuthRefresh.current = null; bufferedLoginEvents.current.clear();
    try {
      const attempt = await api.login();
      activeLogin.current = attempt.attemptId;
      setLoginHint(true);
      const event = bufferedLoginEvents.current.get(attempt.attemptId);
      bufferedLoginEvents.current.clear(); loginInFlight.current = false;
      if (event) loginEventHandler.current(event, attempt);
    } finally { loginInFlight.current = false; }
    });
  };
  const sync = () => {
    // Any refresh satisfies the one startup migration; failures retry only next launch.
    coverRefreshSuppressed.current = true; pendingCoverRefresh.current = false;
    return run('sync', async () => {
    setSyncProgress(null); setSyncActivity(null); setSyncStopping(false);
    await Promise.all([sessionListenerReady.current, syncActivityListenerReady.current]);
    const revision = libraryRevision.current;
    syncActive.current = true;
    const result = await api.sync();
    if (libraryRevision.current !== revision) return;
    // A newer sync owns the library, even if the initial cache read is still pending.
    libraryRevision.current += 1; setLoading(false);
    setBundles(result.bundles); acceptSessionStatus(result); setLastSync(result.lastSync ?? null); setLoginHint(false); setEnumerationComplete(result.enumerationComplete !== false);
    if (result.enumerationComplete === false) { setNotice(''); setError(''); }
    else if (result.bundles.some(bundle => bundle.detailsFailed)) { setNotice(''); setError(partialLibraryWarning); }
    else setNotice(tr('Библиотека обновлена · {count} бандлов', { count: result.bundles.length }));
    });
  };
  const cancelSync = async () => {
    if (syncStopping) return;
    cancelled.current = true; setSyncStopping(true);
    try { await api.cancel(); }
    catch { setError('Не удалось остановить обновление. Дождитесь завершения текущего запроса.'); setSyncStopping(false); }
  };
  const syncRef = useRef(sync);
  syncRef.current = sync;
  useEffect(() => {
    let mounted = true;
    const disposers: Array<() => void> = [];
    const retain = (dispose: () => void) => { if (mounted) disposers.push(dispose); else dispose(); };
    void api.onLoginCompleted(attempt => { if (mounted) loginEventHandler.current('completed', attempt); }).then(retain).catch(() => {});
    void api.onLoginCancelled(attempt => { if (mounted) loginEventHandler.current('cancelled', attempt); }).then(retain).catch(() => {});
    return () => { mounted = false; disposers.forEach(dispose => dispose()); };
  }, []);
  useEffect(() => {
    if (busy || lock.current || !pendingAuthRefresh.current) return;
    pendingAuthRefresh.current = null;
    void syncRef.current();
  }, [busy, authRefreshPulse]);
  useEffect(() => {
    if (loading || busy || lock.current || coverRefreshSuppressed.current || !pendingCoverRefresh.current) return;
    pendingCoverRefresh.current = false;
    void syncRef.current();
  }, [loading, busy, coverRefreshPulse]);
  const revealOne = (bundle: Bundle, item: KeyItem) => { if (!bundle.detailsFailed) return run(item.id, async () => { const result = await api.reveal(bundle.id, item.id); updateItem(bundle.id, result); }); };
  const copy = async (item: KeyItem) => {
    if (!item.key) return;
    try { await api.copy(item.key); setCopied(item.id); } catch { setError('Не удалось скопировать ключ в буфер обмена.'); }
  };
  const revealMany = async (bundle: Bundle) => {
    if (bundle.detailsFailed) return [...bundle.items];
    const pending = bundle.items.filter(item => item.status === 'hidden');
    const result = [...bundle.items];
    let done = 0;
    for (const item of pending) {
      if (cancelled.current) break;
      setQueue({ done, total: pending.length, title: item.title });
      const updated = await api.reveal(bundle.id, item.id);
      result[result.findIndex(previous => previous.id === item.id)] = updated;
      updateItem(bundle.id, updated); done += 1;
      setQueue({ done, total: pending.length, title: item.title });
    }
    return result;
  };
  const revealAll = () => { if (selected && !selected.detailsFailed) void run('reveal', async () => { await revealMany(selected); setNotice(cancelled.current ? 'Очередь остановлена. Полученные ключи остаются в списке.' : 'Раскрытие ключей завершено.'); }); };
  const saveExport = (revealFirst: boolean) => {
    if (!selected || revealFirst && selected.detailsFailed) return;
    const bundle = selected;
    void run('export', async () => {
      const items = revealFirst ? await revealMany(bundle) : bundle.items;
      if (cancelled.current) { setNotice('Очередь остановлена. Полученные ключи остаются в списке.'); return; }
      const contents = format === 'csv' ? exportItemsCsv(items) : exportKeysTxt(items);
      if (!contents) { setError('Нет раскрытых ключей для экспорта.'); return; }
      const path = await api.exportKeys(contents, suggestExportName(bundle.title, format));
      if (path) { setExportOpen(false); setNotice(tr('Экспорт сохранён: {path}', { path })); }
    });
  };
  const openExternal = async (url: string) => { try { await api.openExternal(url); } catch { setError('Не удалось открыть страницу.'); } };
  const windowAction = async (action: 'minimize' | 'maximize' | 'close') => { try { const current = getCurrentWindow(); if (action === 'maximize') await current.toggleMaximize(); else await current[action](); } catch { /* Browser previews have no native window. */ } };
  const updateError = (caught: unknown, fallback: string) => typeof caught === 'string' ? caught : caught instanceof Error ? caught.message : fallback;
  const acceptUpdateResult = (result: UpdateCheck) => {
    const release = result.release ?? undefined;
    setUpdate(current => ({ ...current, release, progress: undefined,
      phase: result.status === 'available' ? release?.staged ? 'ready' : 'available' : result.status === 'current' ? 'current' : 'idle',
      message: result.status === 'notConfigured' ? 'Репозиторий обновлений пока не задан.' : result.status === 'disabled' ? 'Обновления отключены в настройках.' : undefined }));
  };
  const checkUpdates = async (manual = true) => {
    if (updateLock.current) return;
    updateLock.current = true; setUpdate(current => ({ ...current, phase: 'checking', message: undefined }));
    try { acceptUpdateResult(await api.checkUpdates(manual)); }
    catch (caught) { setUpdate(current => ({ ...current, phase: 'error', message: updateError(caught, 'Не удалось проверить обновления.') })); }
    finally { updateLock.current = false; }
  };
  useEffect(() => {
    if (!updateSettingsLoaded || busy || !update.autoCheck || !update.configured || startupUpdateChecked.current || updateLock.current) return;
    startupUpdateChecked.current = true;
    void checkUpdates(false);
  }, [updateSettingsLoaded, busy, update.autoCheck, update.configured]);
  const saveUpdateSettings = async (enabled: boolean, repository: string) => {
    if (updateLock.current) return;
    updateLock.current = true;
    try {
      const value = await api.saveUpdateSettings(enabled, repository);
      const changedRepository = value.repository !== updateRef.current.source;
      setUpdate(current => ({ ...current, currentVersion: value.currentVersion, autoCheck: value.enabled, source: value.repository, configured: value.configured,
        ...(changedRepository ? { release: undefined, phase: 'idle' as const } : {}), message: 'Настройки обновлений сохранены.' }));
      if (changedRepository) startupUpdateChecked.current = false;
    } catch (caught) { setUpdate(current => ({ ...current, phase: 'error', message: updateError(caught, 'Не удалось сохранить настройки обновлений.') })); }
    finally { updateLock.current = false; }
  };
  const installUpdate = async () => {
    if (updateLock.current || appBusyRef.current || !updateRef.current.release) return;
    updateLock.current = true;
    let release = updateRef.current.release;
    try {
      if (!release.staged) {
        setUpdate(current => ({ ...current, phase: 'downloading', progress: 0, message: undefined }));
        const result = await api.downloadUpdate(release.version);
        if (!result.release?.staged) throw new Error(tr("Не удалось скачать обновление."));
        release = result.release;
        acceptUpdateResult(result);
      }
      if (appBusyRef.current) { setUpdate(current => ({ ...current, phase: 'ready', message: 'Установку можно начать после завершения текущей операции.' })); return; }
      setUpdate(current => ({ ...current, phase: 'installing', message: undefined }));
      await api.applyUpdate(release.version);
    } catch (caught) { setUpdate(current => ({ ...current, phase: 'error', message: updateError(caught, 'Не удалось установить обновление.') })); }
    finally { updateLock.current = false; }
  };
  const maintainBrowserData = async (action: 'cache' | 'login' | 'all') => {
    if (loading && action !== 'all' || lock.current || updateLock.current || loginInFlight.current || activeLogin.current) throw new Error(tr('Завершите текущую операцию или закройте окно входа.'));
    lock.current = true; setBusy('maintenance'); setError('');
    try {
      if (action === 'cache') await api.clearCache();
      else if (action === 'login') {
        await api.resetLogin();
        coverRefreshSuppressed.current = true; pendingCoverRefresh.current = false;
        pendingAuthRefresh.current = null; bufferedLoginEvents.current.clear(); activeLogin.current = null;
        setLoginHint(false); setAccountOpen(false); acceptAuthState('unauthenticated');
      } else {
        await api.resetAll();
        // The completed deletion is authoritative. A later refresh must never
        // resurrect the old cache or reopen a previous sign-in attempt.
        libraryRevision.current += 1;
        setError('');
        coverRefreshSuppressed.current = true; pendingCoverRefresh.current = false;
        pendingAuthRefresh.current = null; bufferedLoginEvents.current.clear(); finishedLogins.current.clear();
        activeLogin.current = null; loginInFlight.current = false; cancelled.current = true;
        lastBundle.current = null; keyMenuOrigin.current = null; bundleButtons.current.clear();
        setBundles([]); setSelectedId(null); setLastSync(null); setLoading(false); acceptAuthState('unauthenticated');
        setEnumerationComplete(true); syncActive.current = false; setSyncActivity(null);
        setLoginHint(false); setAccountOpen(false); setExportOpen(false); setKeyMenu(null); setCopied(null);
        setSyncProgress(null); setSyncStopping(false); setQueue(null); setQuery(''); setPlatform(''); setKeyFilter(''); setNotice('');
      }
    } finally { lock.current = false; setBusy(''); }
  };

  return <div className="app-shell" onContextMenu={event => event.preventDefault()}>
    <header className="workspace-topbar" data-tauri-drag-region>
      <button className="workspace-brand" onClick={() => openBundle(null)} aria-label={tr("Humble Library — библиотека")}><span className="workspace-mark"><Package size={23} strokeWidth={1.7} /></span><span>Humble Library<small>{tr("Ваши бандлы и ключи")}</small></span></button>
      <div className="topbar-actions">
        <button className="icon settings-button" aria-label={tr("Настройки")} title={tr("Настройки")} onClick={() => { setAccountOpen(false); setSettingsOpen(true); }}><Settings size={18} /></button>
        <button className="icon theme-button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? tr("Включить светлую тему") : tr("Включить тёмную тему")} title={theme === 'dark' ? tr("Светлая тема") : tr("Тёмная тема")}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
        <div className="account-menu" ref={accountRef}><button ref={accountButton} className="account-trigger" aria-haspopup="menu" aria-expanded={accountOpen} onClick={() => setAccountOpen(value => !value)}><span className={`avatar${connected ? ' connected' : ''}`}><UserRound size={17} /></span><span className="account-summary">Humble Bundle<small>{connected ? tr("Аккаунт подключён") : authState === 'unauthenticated' ? tr("Вход не выполнен") : busy === 'sync' || busy === 'login' || loginHint ? tr("Проверяем сессию…") : tr("Сессия не проверена")}</small></span><ChevronDown size={14} /></button>
          {accountOpen && <div className="account-popover" role="menu" aria-label={tr("Аккаунт Humble")}><button role="menuitem" disabled={!!busy} onClick={() => void login()}><LogIn size={16} />{connected ? tr("Открыть аккаунт Humble") : tr("Войти в Humble")}</button>{connected && <button role="menuitem" disabled={!!busy} onClick={() => void run('logout', async () => { await api.logout(); acceptAuthState('unauthenticated'); setBundles([]); setLastSync(null); setSelectedId(null); setEnumerationComplete(true); setSyncActivity(null); syncActive.current = false; setAccountOpen(false); setNotice('Вы вышли из аккаунта Humble.'); })}><LogOut size={16} />{tr("Выйти из аккаунта")}</button>}</div>}
        </div>
      </div>
      <div className="window-controls"><button aria-label={tr("Свернуть окно")} onClick={() => void windowAction('minimize')}><Minus size={15} /></button><button aria-label={tr("Развернуть окно")} onClick={() => void windowAction('maximize')}><Maximize2 size={13} /></button><button className="window-close" aria-label={tr("Закрыть окно")} onClick={() => void windowAction('close')}><X size={17} /></button></div>
    </header>

    <main className="workspace-main">
      <header className="workspace-heading"><div className="heading-title">{selected && <button ref={bundleBackButton} className="back-button" onClick={() => openBundle(null)} aria-label={tr("Назад к бандлам")} aria-keyshortcuts="Alt+ArrowLeft" title={tr("Назад к бандлам (Alt + ←)")}><ArrowLeft size={17} /><span>{tr("К бандлам")}</span></button>}<div><h1>{selected ? selected.title : tr("Библиотека")}</h1><p>{selected ? selected.detailsFailed ? tr('Ключи не обновлены') : tr('{items} позиций · раскрыто {revealed}', { items: selected.items.length, revealed: revealedCount }) : tr('{bundles} бандлов · {items} позиций', { bundles: bundles.length, items: keyCount })}</p></div></div>
        <div className="page-actions">{selected ? <><button disabled={!!busy || selected.detailsFailed || !hidden.length} onClick={revealAll}><Eye size={17} />{tr("Раскрыть все")}</button><button className="primary" disabled={!!busy || !selected.items.length} onClick={() => setExportOpen(true)}><Download size={17} />{tr("Экспортировать")}</button></> : <button disabled={!!busy || loading} onClick={() => void sync()}><RefreshCw size={17} className={busy === 'sync' ? 'spin' : ''} />{busy === 'sync' ? tr("Обновляем…") : tr("Обновить")}</button>}</div>
      </header>

      {preview && <div className="preview-note"><Package size={15} />{tr("Демонстрационные данные · настоящие ключи не используются")}</div>}
      {loginHint && <div className="workspace-notification"><Notification message={tr("Завершите вход в отдельном окне. Библиотека обновится автоматически.")} kind="info" onClose={() => setLoginHint(false)}><button disabled={!!busy} onClick={() => void sync()}><RefreshCw size={15} />{tr("Обновить библиотеку")}</button></Notification></div>}
      {error && !exportOpen && <div className={settingsOpen ? undefined : "workspace-notification"}><Notification message={trError(error)} kind={error === partialLibraryWarning ? "warning" : "error"} toast={settingsOpen} onClose={() => setError('')} /></div>}
      {!enumerationComplete && <div className="workspace-notification"><div className="bundle-summary library-incomplete" role="status"><div><p>{tr(incompleteLibraryWarning)}</p><button disabled={!!busy || loading} onClick={() => void sync()}><RefreshCw size={15} />{tr('Обновить библиотеку')}</button></div></div></div>}
      {busy === 'sync' && <div className="queue-progress sync-progress" role="status"><div className="queue-top"><span><LoaderCircle size={17} className="spin" />{tr(syncProgress?.stage === "purchases" ? "Загружаем список покупок" : syncProgress?.stage === "keys" ? "Загружаем ключи" : "Обновляем библиотеку")} <b>{syncProgress ? `${syncProgress.completed} / ${syncProgress.total}` : tr("Подготовка")}</b></span><button disabled={syncStopping} onClick={() => void cancelSync()}><Square size={12} />{syncStopping ? tr("Останавливаем…") : tr("Остановить")}</button></div><progress max={syncProgress?.total || 1} value={syncProgress?.completed} aria-label={syncProgress?.stage === "keys" ? tr("Загружаем ключи") : tr("Загрузка покупок Humble Bundle")} /><small>{syncStopping ? tr("Ждём остановки запроса. Последняя библиотека останется доступна.") : syncActivity ? tr('Загрузка продолжится через {seconds} сек. · попытка {attempt}', { seconds: Math.ceil(syncActivity.delayMs / 1000), attempt: syncActivity.attempt }) : syncProgress ? tr(syncProgress.stage === 'keys' ? 'Бандлы: {completed} из {total}' : 'Загружено покупок: {completed} из {total}', { completed: syncProgress.completed, total: syncProgress.total }) : tr("Подключаемся к Humble Bundle и получаем список покупок.")}</small></div>}
      {queue && <div className="queue-progress" role="status"><div className="queue-top"><span><LoaderCircle size={17} className="spin" />{tr("Раскрываем ключи")} <b>{queue.done} / {queue.total}</b></span><button onClick={() => { cancelled.current = true; }} disabled={cancelled.current}><Square size={12} />{tr("Остановить")}</button></div><progress max={queue.total} value={queue.done} aria-label={tr("Раскрытие ключей")} /><small>{queue.title}</small></div>}

      <div className="workspace-content">
        {loading ? <div className="loading-state"><LoaderCircle className="spin" size={25} /><span>{tr("Загружаем библиотеку…")}</span></div> : !bundles.length ? <div className="empty-state"><span className="empty-icon"><Library size={34} strokeWidth={1.4} /></span><h2>{connected && enumerationComplete ? tr("Библиотека пока пуста") : tr("Ваши бандлы — в одном месте")}</h2><p>{connected ? tr("Обновите библиотеку, чтобы загрузить покупки из Humble Bundle.") : tr("Войдите в Humble Bundle, чтобы увидеть покупки, раскрывать ключи и сохранять их одним файлом.")}</p><button className="primary" disabled={!!busy} onClick={() => void (connected ? sync() : login())}>{connected ? <RefreshCw size={17} /> : <LogIn size={17} />}{connected ? tr("Обновить библиотеку") : tr("Войти в Humble")}</button>{!connected && <small><ExternalLink size={13} />{tr("Вход откроется в отдельном окне Humble Bundle")}</small>}</div> : <>
          {selected && <div className="bundle-summary"><Cover bundle={selected} small /><div><span className="eyebrow">HUMBLE BUNDLE</span><p>{dateLabel(selected.purchasedAt) ? tr('Куплено {date}', { date: dateLabel(selected.purchasedAt) }) : tr("Ключи из вашей покупки")}</p><div className="bundle-summary-badges">{platforms.map(value => <span key={value}>{platformLabel(value)}</span>)}</div></div></div>}
          {selected?.detailsFailed && selected.items.length > 0 && <BundleRecovery bundle={selected} busy={!!busy} onRefresh={() => void sync()} onOpen={url => void openExternal(url)} />}
          {(!selected || !selected.detailsFailed || selected.items.length > 0) && <div className="library-toolbar"><label className="search"><Search size={17} /><input aria-label={selected ? tr("Поиск по названию товара") : tr("Поиск бандлов")} placeholder={selected ? tr("Поиск по названию товара") : tr("Поиск бандлов")} value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="search-clear" onClick={() => setQuery('')} aria-label={tr("Очистить поиск")}><X size={14} /></button>}</label>{selected ? <div className="filter-actions"><select aria-label={tr("Площадка")} value={platform} onChange={event => setPlatform(event.target.value)}><option value="">{tr("Все площадки")}</option>{platforms.map(value => <option key={value} value={value}>{platformLabel(value)}</option>)}</select><select aria-label={tr("Состояние ключей")} value={keyFilter} onChange={event => setKeyFilter(event.target.value)}><option value="">{tr("Все состояния")}</option>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{tr(label)}</option>)}</select></div> : <BundleSort value={bundleSort} onChange={value => { setBundleSort(value); saveBundleSortPreference(value); }} />}</div>}
          {!selected ? visibleBundles.length ? <div className="bundle-grid">{visibleBundles.map(bundle => { const count = bundle.items.filter(item => !!item.key).length; return <button className="bundle-tile" ref={node => { if (node) bundleButtons.current.set(bundle.id, node); else bundleButtons.current.delete(bundle.id); }} key={bundle.id} title={dateLabel(bundle.purchasedAt) ? tr('Куплено {date}', { date: dateLabel(bundle.purchasedAt) }) : undefined} onClick={() => openBundle(bundle.id)} aria-label={tr('Открыть бандл {title}', { title: bundle.title })}><Cover bundle={bundle} /><span className="bundle-tile-body"><strong>{bundle.title}</strong><span className="tile-meta"><span><KeyRound size={13} />{bundle.detailsFailed ? tr('Ключи не обновлены') : tr('{count} позиций', { count: bundle.items.length })}</span>{bundle.detailsFailed ? null : <span>{count > 0 ? tr('{count} раскрыто', { count }) : tr("Не раскрыт")}</span>}</span></span></button>; })}</div> : <div className="no-results"><Search size={23} /><h3>{tr("Бандлы не найдены")}</h3><p>{tr("Попробуйте изменить поисковый запрос.")}</p></div> : selected.detailsFailed && !selected.items.length ? <BundleRecovery bundle={selected} busy={!!busy} empty onRefresh={() => void sync()} onOpen={url => void openExternal(url)} /> : visibleItems.length ? <div className="key-table-wrap"><table className="key-table"><thead><tr><th>{tr("Название")}</th><th>{tr("Площадка")}</th><th>{tr("Ключ")}</th><th><span className="sr-only">{tr("Действия")}</span></th></tr></thead><tbody>{visibleItems.map(item => <tr key={item.id}><td><strong>{item.title}</strong>{item.instructions && <details className="key-instructions"><summary>{tr("Инструкция активации")}</summary><p>{item.instructions}</p>{item.redeemUrl && <button onClick={() => void openExternal(item.redeemUrl!)}><ArrowUpRight size={14} />{tr("Открыть страницу")}</button>}</details>}</td><td><span className="platform-badge">{platformLabel(item.platform)}</span></td><td onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (item.key) { const origin = event.currentTarget.querySelector<HTMLElement>('code'); if (origin) openKeyMenu(item, event.clientX, event.clientY, origin); } }}>{item.key ? <code className="key-value" tabIndex={0} aria-haspopup="menu" aria-label={`${tr('Ключ')}: ${item.title}`} onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); openKeyMenu(item, rect.left + 8, rect.bottom + 4, event.currentTarget); } }}>{item.key}</code> : <span className={`key-state ${item.status}`}>{item.status === 'hidden' && <Eye size={14} />}{tr(statusLabel[item.status])}</span>}</td><td><div className="key-actions">{item.key ? <button className={`icon${copied === item.id ? ' copied' : ''}`} title={copied === item.id ? tr("Скопировано") : tr("Скопировать ключ")} aria-label={`${copied === item.id ? tr("Скопировано") : tr("Скопировать ключ")}: ${item.title}`} onClick={() => void copy(item)}>{copied === item.id ? <Check size={17} /> : <Copy size={16} />}</button> : item.status === 'hidden' ? <button disabled={!!busy || selected.detailsFailed} onClick={() => void revealOne(selected, item)}>{busy === item.id ? <LoaderCircle size={15} className="spin" /> : <Eye size={15} />}{tr("Раскрыть")}</button> : item.redeemUrl ? <button disabled={!!busy} onClick={() => void openExternal(item.redeemUrl!)}><ExternalLink size={14} />{tr("Открыть")}</button> : item.status === 'external' || item.status === 'unavailable' ? <button disabled={!!busy} onClick={() => void openExternal('https://www.humblebundle.com/home/purchases')}><ExternalLink size={14} />{tr("На Humble")}</button> : <span className="muted">—</span>}</div></td></tr>)}</tbody></table></div> : <div className="no-results"><Search size={23} /><h3>{tr("Ничего не найдено")}</h3><p>{tr("Измените запрос или выбранные фильтры.")}</p><button onClick={() => { setQuery(''); setPlatform(''); setKeyFilter(''); }}>{tr("Сбросить фильтры")}</button></div>}
        </>}
      </div>
    </main>

    <footer className="workspace-footer"><span>{busy ? <><LoaderCircle size={13} className="spin" />{queue ? tr("Получаем ключи из Humble") : busy === 'sync' ? tr("Обновляем библиотеку") : tr("Выполняем действие…")}</> : connected || bundles.length ? <><span className={`status-dot${connected ? ' connected' : ''}`} />{connected ? tr("Humble подключён") : tr("Локальная библиотека")}</> : null}</span><span className="last-sync">{lastSync ? tr('Обновлено {date}', { date: dateLabel(lastSync, true) }) : ''}</span></footer>
    {notice && !error && <Notification message={tr(notice)} kind="success" toast onClose={() => setNotice('')} />}
    {keyMenu && <div ref={keyMenuRef} className="key-context-menu" role="menu" aria-label={tr('Скопировать ключ')} style={{ left: keyMenu.x, top: keyMenu.y }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeKeyMenu(); } else if (event.key === 'Tab') { event.preventDefault(); closeKeyMenu(); } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); keyMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); } }}><button role="menuitem" onClick={() => { const item = keyMenu.item; closeKeyMenu(); void copy(item); }}><Copy size={16} />{tr('Скопировать ключ')}</button></div>}
    {settingsOpen && <SettingsDialog update={update} appBusy={!!busy || loading || loginInFlight.current || activeLogin.current !== null} fullResetBlocked={!!busy || loginInFlight.current || activeLogin.current !== null} onClose={() => setSettingsOpen(false)} onAutoCheck={enabled => void saveUpdateSettings(enabled, updateRef.current.source)} onRepositorySave={repository => saveUpdateSettings(updateRef.current.autoCheck, repository)} onDismissMessage={() => setUpdate(current => ({ ...current, message: undefined }))} onCheck={() => void checkUpdates(true)} onInstall={() => void installUpdate()} onOpenRelease={() => { if (update.release?.url) void openExternal(update.release.url); }} onClearCache={() => maintainBrowserData('cache')} onResetLogin={() => maintainBrowserData('login')} onResetAll={() => maintainBrowserData('all')} />}

    {exportOpen && selected && <Dialog title={tr("Экспорт ключей")} busy={!!busy} onClose={() => setExportOpen(false)}><p className="dialog-subtitle">{selected.title}</p><label className="field-label" htmlFor="export-format">{tr("Формат файла")}</label><select id="export-format" value={format} disabled={!!busy} onChange={event => setFormat(event.target.value as ExportFormat)}><option value="txt">{tr("TXT — только ключи, по одному на строку")}</option><option value="csv">{tr("CSV — названия, площадки и ключи")}</option></select><p className="export-description">{selected.detailsFailed ? tr("Ключи этого бандла пока не загружены полностью.") : format === 'txt' ? tr("Все площадки вместе. В файле будут только раскрытые ключи, без названий и повторов.") : tr("Таблица со всеми позициями бандла, включая скрытые и недоступные ключи. Подходит для Excel.")}</p><div className="export-summary"><span>{tr("Раскрытых ключей")} <strong>{revealed.length}</strong></span><span>{tr("Ещё не раскрыто")} <strong>{hidden.length}</strong></span><span>{tr("Всего позиций")} <strong>{selected.items.length}</strong></span></div>{hidden.length > 0 && !selected.detailsFailed && <p className="export-hint">{tr("Можно сначала раскрыть оставшиеся ключи и сразу сохранить файл. Если ключ недоступен, он останется без значения.")}</p>}{format === 'txt' && platforms.length > 1 && <p className="export-hint">{tr("Для импорта в программу конкретной площадки используйте только её ключи. Этот TXT содержит ключи всех площадок бандла.")}</p>}{error && <div className="export-notification"><Notification message={trError(error)} kind={error === partialLibraryWarning ? "warning" : "error"} onClose={() => setError('')} /></div>}<div className="dialog-actions"><button disabled={!!busy} onClick={() => setExportOpen(false)}>{tr("Отмена")}</button><button disabled={!!busy || (format === 'txt' && !revealed.length)} onClick={() => saveExport(false)}><Download size={16} />{tr('Сохранить {format}', { format: format.toUpperCase() })}</button>{hidden.length > 0 && <button className="primary" disabled={!!busy || selected.detailsFailed} onClick={() => saveExport(true)}>{busy === 'export' ? <LoaderCircle size={16} className="spin" /> : <Eye size={16} />}{tr("Раскрыть и экспортировать")}</button>}</div>{queue && <div className="export-queue" role="status"><progress max={queue.total} value={queue.done} aria-label={tr("Раскрытие ключей перед экспортом")} /><span>{queue.done} / {queue.total} · {queue.title}</span><button onClick={() => { cancelled.current = true; }}>{tr("Остановить")}</button></div>}</Dialog>}
  </div>;
}
