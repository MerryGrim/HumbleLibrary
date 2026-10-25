import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Check, CheckCircle2, Copy, Info, TriangleAlert, X } from 'lucide-react';
import { api } from './api';
import { tr } from './i18n';
import './Notification.css';

export type NotificationProps = {
  message: string;
  onClose: () => void;
  kind?: 'error' | 'warning' | 'info' | 'success';
  duration?: number;
  children?: ReactNode;
  toast?: boolean;
};

type CopyState = 'idle' | 'copying' | 'copied' | 'failed';

/** All notification timing belongs to this mounted message, including paused time. */
export function Notification({ message, onClose, kind = 'info', duration = 8000, children, toast = false }: NotificationProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const timer = useRef<number | null>(null);
  const remaining = useRef(duration);
  const started = useRef(0);
  const hovered = useRef(false);
  const focused = useRef(false);
  const mounted = useRef(false);
  const dismissed = useRef(false);
  const copySequence = useRef(0);
  const copying = useRef(false);
  const closeCallback = useRef(onClose);
  const visibleMessage = useRef(message);
  closeCallback.current = onClose;
  visibleMessage.current = message;

  const clearTimer = useCallback(() => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const dismiss = useCallback(() => {
    if (!mounted.current || dismissed.current) return;
    dismissed.current = true;
    clearTimer();
    closeCallback.current();
  }, [clearTimer]);

  const resume = useCallback(() => {
    if (!mounted.current || dismissed.current || hovered.current || focused.current || timer.current !== null) return;
    started.current = performance.now();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      remaining.current = 0;
      if (!hovered.current && !focused.current) dismiss();
    }, remaining.current);
  }, [dismiss]);

  const pause = useCallback(() => {
    if (timer.current === null) return;
    remaining.current = Math.max(0, remaining.current - (performance.now() - started.current));
    clearTimer();
  }, [clearTimer]);

  useEffect(() => {
    mounted.current = true;
    dismissed.current = false;
    clearTimer();
    remaining.current = Number.isFinite(duration) ? Math.max(0, duration) : 8000;
    copySequence.current += 1;
    copying.current = false;
    setCopyState('idle');
    resume();
    return () => {
      mounted.current = false;
      copySequence.current += 1;
      clearTimer();
    };
  }, [message, duration, clearTimer, resume]);

  const copyMessage = async () => {
    if (copying.current || dismissed.current) return;
    copying.current = true;
    const sequence = ++copySequence.current;
    const text = message;
    setCopyState('copying');
    try {
      await api.copy(text);
      if (mounted.current && sequence === copySequence.current && visibleMessage.current === text) setCopyState('copied');
    } catch {
      if (mounted.current && sequence === copySequence.current && visibleMessage.current === text) setCopyState('failed');
    } finally {
      if (sequence === copySequence.current) copying.current = false;
    }
  };

  const Icon = kind === 'error' ? AlertCircle : kind === 'warning' ? TriangleAlert : kind === 'success' ? CheckCircle2 : Info;
  const copyLabel = copyState === 'copied' ? tr('Текст скопирован') : tr('Скопировать текст');

  return <section
    className={`notification notification--${kind}${toast ? ' notification--toast' : ''}`}
    role={kind === 'error' || kind === 'warning' ? 'alert' : 'status'}
    onPointerEnter={() => { hovered.current = true; pause(); }}
    onPointerLeave={() => { hovered.current = false; resume(); }}
    onFocus={() => { focused.current = true; pause(); }}
    onBlur={event => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      focused.current = false;
      resume();
    }}
  >
    <Icon className="notification__icon" size={18} aria-hidden="true" />
    <div className="notification__body">
      <span className="notification__message">{message}</span>
      {children && <div className="notification__children">{children}</div>}
      {copyState === 'failed' && <small className="notification__copy-result" aria-live="polite">{tr('Не удалось скопировать текст.')}</small>}
    </div>
    <button type="button" className={`notification__copy${copyState === 'copied' ? ' notification__copy--done' : ''}`} onClick={() => { void copyMessage(); }} aria-label={copyLabel} aria-busy={copyState === 'copying'} disabled={copyState === 'copying'}>
      {copyState === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span>{copyLabel}</span>
    </button>
    <button type="button" className="notification__close" onClick={dismiss} aria-label={tr('Закрыть уведомление')} title={tr('Закрыть уведомление')}><X size={16} aria-hidden="true" /></button>
  </section>;
}

export default Notification;
