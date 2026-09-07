import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Gauge, MessageSquareText } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import '../app/globals.css';

type Thread = {
  id: string;
  title: string;
  updatedAt: number;
  totalTokens: number;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  contextPercent: number | null;
  weeklyUsagePercent: number | null;
};

type Overview = {
  generatedAt: number;
  rateLimit: { usedPercent: number; resetsAt: number | null } | null;
  threads: Thread[];
};

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const port = new URLSearchParams(window.location.search).get('port') ?? '64111';
const API = `http://127.0.0.1:${port}`;

function compact(value: number): string {
  if (value >= 1_000_000) return `${number.format(value / 1_000_000)}M`;
  if (value >= 1_000) return `${number.format(value / 1_000)}K`;
  return number.format(value);
}

function relativeTime(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return 'Сейчас';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  return `${Math.floor(hours / 24)} дн`;
}

function weeklyContribution(value: number | null): string {
  if (value == null) return 'неделя —';
  if (value < 1) return 'неделя <1%';
  return `неделя ≈${number.format(value)}%`;
}

function contextTone(value: number | null): string {
  if ((value ?? 0) >= 60) return 'bg-rose-400';
  if ((value ?? 0) >= 35) return 'bg-amber-400';
  return 'bg-emerald-400';
}

function statusTone(status: Thread['status']): string {
  if (status === 'running') return 'live-dot bg-emerald-400';
  if (status === 'failed') return 'bg-rose-400';
  if (status === 'interrupted') return 'bg-amber-400';
  return 'bg-slate-600';
}

function resetLabel(timestamp: number | null): string {
  if (!timestamp) return 'Сброс неизвестен';
  return `Сброс ${new Date(timestamp).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function TrayPopover() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API}/api/overview`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setOverview((await response.json()) as Overview);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(load, 5000);
    const refreshWhenShown = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', refreshWhenShown);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenShown);
    };
  }, [load]);

  const chats = useMemo(
    () =>
      [...(overview?.threads ?? [])]
        .sort(
          (left, right) =>
            Number(right.status === 'running') -
              Number(left.status === 'running') ||
            right.updatedAt - left.updatedAt,
        )
        .slice(0, 3),
    [overview],
  );
  const running =
    overview?.threads.filter((thread) => thread.status === 'running').length ??
    0;
  const used = overview?.rateLimit?.usedPercent ?? null;
  const remaining = used == null ? null : Math.max(0, 100 - used);

  return (
    <main className="relative h-screen p-2 pt-3 text-slate-100">
      <div className="tray-notch absolute top-1" />
      <section className="tray-surface grid h-full grid-rows-[54px_108px_minmax(0,1fr)_48px] overflow-hidden rounded-[24px] border border-white/[.09] bg-[#111318]/98 shadow-[0_18px_55px_rgba(0,0,0,.58)] backdrop-blur-2xl">
        <header className="flex items-center gap-3 px-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-violet-400/14 text-violet-300">
            <Gauge aria-hidden="true" className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold tracking-[-.01em] text-slate-100">
              Использование Codex
            </h1>
            <p className="mt-0.5 text-xs text-slate-500">
              {error
                ? 'Нет связи с локальной службой'
                : overview
                  ? 'Данные обновлены'
                  : 'Загружаю данные…'}
            </p>
          </div>
          <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-emerald-400/10 px-2.5 text-xs font-medium text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {running}
          </span>
        </header>

        <section
          className="mx-3 rounded-[18px] bg-[#1b1b23] px-3.5 py-3"
          aria-label="Недельный лимит"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-baseline gap-2">
              <strong className="font-mono text-[28px] font-semibold leading-none tracking-[-.04em] text-white">
                {used == null ? '—' : `${number.format(used)}%`}
              </strong>
              <span className="text-xs text-slate-400">за неделю</span>
            </div>
            <span className="text-xs font-medium text-violet-300">
              {remaining == null
                ? 'Остаток —'
                : `${number.format(remaining)}% осталось`}
            </span>
          </div>
          <progress
            className="tray-week-progress mt-3 block h-2 w-full"
            aria-label="Использовано недельного лимита"
            max={100}
            value={used ?? 0}
          />
          <p className="mt-2 text-xs text-slate-500">
            {resetLabel(overview?.rateLimit?.resetsAt ?? null)}
          </p>
        </section>

        <section
          className="tray-chat-list min-h-0 overflow-y-auto px-4 pt-2"
          aria-labelledby="recent-chats"
        >
          <div className="flex h-8 items-center gap-2 text-slate-400">
            <MessageSquareText aria-hidden="true" className="h-4 w-4" />
            <h2
              id="recent-chats"
              className="text-xs font-semibold uppercase tracking-[.08em]"
            >
              Последние чаты
            </h2>
          </div>
          <div className="divide-y divide-white/[.07]">
            {chats.map((thread) => {
              const context = Math.min(
                100,
                Math.max(0, thread.contextPercent ?? 0),
              );
              return (
                <article key={thread.id} className="py-2 first:pt-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${statusTone(thread.status)}`}
                    />
                    <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-slate-200">
                      {thread.title}
                    </p>
                    <time className="shrink-0 text-xs text-slate-600">
                      {relativeTime(
                        thread.updatedAt,
                        overview?.generatedAt ?? thread.updatedAt,
                      )}
                    </time>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 pl-4 font-mono text-[11px] text-slate-500">
                    <span>{compact(thread.totalTokens)} ток.</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {thread.contextPercent == null
                        ? 'контекст —'
                        : `контекст ${Math.round(context)}%`}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="text-violet-300">
                      {weeklyContribution(thread.weeklyUsagePercent)}
                    </span>
                  </div>
                  <div className="ml-4 mt-1.5 h-0.5 overflow-hidden rounded-full bg-white/[.07]">
                    <div
                      className={`h-full rounded-full transition-[width] duration-300 ${contextTone(thread.contextPercent)}`}
                      style={{ width: `${context}%` }}
                    />
                  </div>
                </article>
              );
            })}
            {!chats.length && (
              <div className="grid h-28 place-items-center text-xs text-slate-500">
                Чаты пока не найдены
              </div>
            )}
          </div>
        </section>

        <footer className="px-3 pb-2 pt-1">
          <a
            href="codex-usage://dashboard"
            className="flex h-9 items-center justify-center gap-2 rounded-full bg-violet-300/[.14] text-[13px] font-semibold text-violet-200 transition-colors hover:bg-violet-300/[.22] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
          >
            Открыть dashboard
            <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
          </a>
        </footer>
      </section>
      {error && (
        <span className="sr-only" role="alert">
          Не удалось обновить данные
        </span>
      )}
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Tray root element not found');
createRoot(root).render(
  <React.StrictMode>
    <TrayPopover />
  </React.StrictMode>,
);
