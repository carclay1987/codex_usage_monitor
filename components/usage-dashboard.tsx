'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Clock3,
  Database,
  FolderKanban,
  Info,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Terminal,
  Wrench,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

const API = 'http://127.0.0.1:64111';

type TokenBreakdown = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

type Thread = {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  totalTokens: number;
  model: string | null;
  reasoningEffort: string | null;
  cwd: string;
  projectId: string | null;
  projectName: string | null;
  projectPosition: number | null;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  last: TokenBreakdown | null;
  contextWindow: number | null;
  contextPercent: number | null;
  weeklyUsagePercent: number | null;
  compactions: number;
};

type Subagent = {
  id: string;
  parentId: string;
  depth: number;
  nickname: string | null;
  taskPath: string | null;
  model: string | null;
  reasoningEffort: string | null;
  cwd: string;
  status: Thread['status'];
  total: TokenBreakdown | null;
  totalTokens: number;
};

type Overview = {
  generatedAt: number;
  source: string;
  rateLimit: { usedPercent: number; resetsAt: number | null } | null;
  threads: Thread[];
};

type DetailPoint = TokenBreakdown & {
  timestamp: number;
  contextPercent: number | null;
};

type Detail = {
  id: string;
  points: DetailPoint[];
  turns: number;
  compactions: number;
  compactionTimestamps: number[];
  subagents: Subagent[];
  analysis: TokenAnalysisData;
};

type UsageMetric = {
  name: string;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type TokenAnalysisData = {
  totals: {
    modelRequests: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    peakInputTokens: number;
    compactionSavings: number;
    firstRequestInputTokens: number;
  };
  startup: Array<{ name: string; chars: number; estimatedTokens: number }>;
  startupChars: number;
  categories: UsageMetric[];
  tools: Array<{
    name: string;
    category: string;
    calls: number;
    outputChars: number;
  }>;
  requests: Array<{
    timestamp: number;
    category: string;
    label: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    inputDelta: number;
    newContentChars: number;
  }>;
};

type SortKey = 'recent' | 'tokens' | 'context';

type MonitorSettings = {
  dataDir: string;
  refreshIntervalMs: number;
  recentThreadsLimit: number;
  overviewTailMb: number;
  detailPointLimit: number;
  analyzeToolOutputs: boolean;
  settingsPath: string;
  telemetrySource: string;
  databaseSource: string;
};

type GlobalAudit = {
  generatedAt: number;
  scope: { threads: number; detailedThreads: number; modelRequests: number };
  metrics: {
    compactions: number;
    restartCandidates: number;
    averageStartupTokens: number;
    cachePercent: number | null;
    totalToolOutputChars: number;
  };
  recommendations: Array<{
    severity: 'low' | 'medium' | 'high';
    title: string;
    evidence: string;
    action: string;
  }>;
};

type CodexAuditState = {
  status: 'idle' | 'preparing' | 'running' | 'completed' | 'failed';
  startedAt: number | null;
  completedAt: number | null;
  result: string | null;
  report: GlobalAudit | null;
  error: string | null;
};

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

function compact(value: number): string {
  if (value >= 1_000_000_000) return `${number.format(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${number.format(value / 1_000_000)}M`;
  if (value >= 1_000) return `${number.format(value / 1_000)}K`;
  return number.format(value);
}

function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return 'только что';
  if (seconds < 60) return `${seconds} сек назад`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} дн назад`;
}

function statusLabel(status: Thread['status']): string {
  return {
    running: 'Работает',
    completed: 'Завершён',
    failed: 'Ошибка',
    interrupted: 'Прерван',
  }[status];
}

function projectName(path: string): string {
  const normalized = path.replace(/\/$/, '');
  return normalized.split('/').pop() || 'Без проекта';
}

function HelpLabel({ children, help }: { children: string; help: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {children}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`Что означает «${children}»`}
              className="rounded-full text-slate-400 transition-colors hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            />
          }
        >
          <Info className="h-3.5 w-3.5" />
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="end"
          sideOffset={8}
          className="max-w-[min(18rem,calc(100vw-2rem))] items-start rounded-xl bg-slate-100 px-3 py-2 text-left text-sm font-normal leading-relaxed text-slate-900 shadow-xl"
        >
          {help}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

function weeklyContribution(value: number | null): string {
  if (value == null) return '—';
  if (value < 1) return '<1%';
  return `≈${number.format(value)}%`;
}

function Meter({
  value,
  tone = 'emerald',
}: {
  value: number;
  tone?: 'emerald' | 'violet' | 'amber' | 'rose';
}) {
  const percent = Math.min(100, Math.max(0, value));
  const toneClass = {
    emerald: 'bg-emerald-400',
    violet: 'bg-violet-400',
    amber: 'bg-amber-400',
    rose: 'bg-rose-400',
  }[tone];
  return (
    <div className="relative h-2.5 overflow-hidden rounded-full bg-white/10">
      <progress className="sr-only" value={percent} max={100}>
        {Math.round(percent)}%
      </progress>
      <div
        aria-hidden="true"
        className={`h-full rounded-full transition-[width] duration-300 ${toneClass}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function contextMeterTone(value: number | null): 'emerald' | 'amber' | 'rose' {
  if ((value ?? 0) >= 60) return 'rose';
  if ((value ?? 0) >= 35) return 'amber';
  return 'emerald';
}

export function UsageDashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('recent');
  const [openProjects, setOpenProjects] = useState<Set<string> | null>(null);
  const [query, setQuery] = useState('');
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<MonitorSettings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<MonitorSettings | null>(
    null,
  );
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [globalAudit, setGlobalAudit] = useState<GlobalAudit | null>(null);
  const [codexAudit, setCodexAudit] = useState<CodexAuditState | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API}/api/overview`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = (await response.json()) as Overview;
      const latest = [...next.threads].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      )[0];
      setOverview(next);
      setSelectedId((current) => current ?? latest?.id ?? null);
      setError(null);
    } catch {
      setError('Служба данных не отвечает');
    }
  }, []);

  const loadSettings = useCallback(async () => {
    const response = await fetch(`${API}/api/settings`, { cache: 'no-store' });
    if (!response.ok) return;
    const value = (await response.json()) as MonitorSettings;
    setSettings(value);
    setSettingsDraft((current) => current ?? value);
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(load, settings?.refreshIntervalMs ?? 2500);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load, settings?.refreshIntervalMs]);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadSettings(), 0);
    return () => window.clearTimeout(initial);
  }, [loadSettings]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    const loadDetail = async () => {
      try {
        const response = await fetch(`${API}/api/threads/${selectedId}`, {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (active) setDetail((await response.json()) as Detail);
      } catch {
        if (active) setDetail(null);
      } finally {
        if (active) setDetailLoading(false);
      }
    };
    void loadDetail();
    const timer = window.setInterval(
      loadDetail,
      Math.max(5000, (settings?.refreshIntervalMs ?? 2500) * 2),
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [selectedId, settings?.refreshIntervalMs]);

  useEffect(() => {
    if (!auditOpen) return;
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch(`${API}/api/codex-audit`, {
          cache: 'no-store',
        });
        if (response.ok && active) {
          const value = (await response.json()) as CodexAuditState;
          setCodexAudit(value);
          if (value.report) setGlobalAudit(value.report);
        }
      } catch {
        // Основной индикатор подключения уже показан в заголовке.
      }
    };
    void poll();
    const timer = window.setInterval(poll, 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [auditOpen]);

  const saveSettings = async () => {
    if (!settingsDraft) return;
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const response = await fetch(`${API}/api/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settingsDraft),
      });
      const body = (await response.json()) as MonitorSettings & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(body.error || `HTTP ${response.status}`);
      setSettings(body);
      setSettingsDraft(body);
      setSettingsOpen(false);
      setSelectedId(null);
      setDetail(null);
      await load();
    } catch (saveError) {
      setSettingsError(
        saveError instanceof Error
          ? saveError.message
          : 'Не удалось сохранить настройки',
      );
    } finally {
      setSettingsSaving(false);
    }
  };

  const openAudit = async () => {
    setAuditOpen(true);
    try {
      const response = await fetch(`${API}/api/codex-audit`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = (await response.json()) as CodexAuditState;
      setCodexAudit(value);
      setGlobalAudit(value.report);
    } catch {
      setCodexAudit({
        status: 'failed',
        startedAt: null,
        completedAt: Date.now(),
        result: null,
        report: null,
        error: 'Служба данных не отвечает',
      });
    }
  };

  const startAudit = async () => {
    setCodexAudit({
      ...codexAudit,
      status: 'preparing',
      startedAt: Date.now(),
      completedAt: null,
      result: codexAudit?.result ?? null,
      report: globalAudit,
      error: null,
    });
    try {
      const response = await fetch(`${API}/api/codex-audit`, {
        method: 'POST',
      });
      const value = (await response.json()) as CodexAuditState;
      setCodexAudit(value);
      if (value.report) setGlobalAudit(value.report);
    } catch {
      setCodexAudit({
        ...codexAudit,
        status: 'failed',
        startedAt: Date.now(),
        completedAt: Date.now(),
        result: codexAudit?.result ?? null,
        report: globalAudit,
        error: 'Служба данных не отвечает',
      });
    }
  };

  const threads = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ru');
    const filtered = (overview?.threads ?? []).filter((thread) => {
      const matchesQuery =
        !normalized ||
        thread.title.toLocaleLowerCase('ru').includes(normalized) ||
        thread.cwd.toLocaleLowerCase('ru').includes(normalized);
      return matchesQuery;
    });
    return [...filtered].sort((a, b) => {
      if (sort === 'tokens') return b.totalTokens - a.totalTokens;
      if (sort === 'context')
        return (b.contextPercent ?? -1) - (a.contextPercent ?? -1);
      return b.updatedAt - a.updatedAt;
    });
  }, [overview, query, sort]);

  const recentThreads = threads.filter((thread) => !thread.projectId);
  const projectGroups = useMemo(() => {
    const groups = new Map<
      string,
      { id: string; name: string; position: number; threads: Thread[] }
    >();
    for (const thread of threads) {
      if (!thread.projectId) continue;
      const group = groups.get(thread.projectId) ?? {
        id: thread.projectId,
        name: thread.projectName ?? projectName(thread.cwd),
        position: thread.projectPosition ?? Number.MAX_SAFE_INTEGER,
        threads: [],
      };
      group.threads.push(thread);
      groups.set(thread.projectId, group);
    }
    return [...groups.values()].sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name, 'ru'),
    );
  }, [threads]);

  const selected =
    overview?.threads.find((thread) => thread.id === selectedId) ?? null;
  const running =
    overview?.threads.filter((thread) => thread.status === 'running').length ??
    0;
  const recentTokens =
    overview?.threads
      .filter(
        (thread) =>
          overview.generatedAt - thread.updatedAt < 24 * 60 * 60 * 1000,
      )
      .reduce((sum, thread) => sum + thread.totalTokens, 0) ?? 0;
  const hot =
    overview?.threads.filter((thread) => (thread.contextPercent ?? 0) >= 50)
      .length ?? 0;

  const visibleRecent =
    query || showAllRecent ? recentThreads : recentThreads.slice(0, 7);
  const selectThread = (thread: Thread) => {
    if (thread.id === selectedId) return;
    setSelectedId(thread.id);
    setDetail(null);
    setDetailLoading(true);
  };

  return (
    <main className="mx-auto min-h-screen max-w-[1720px] px-5 py-7 sm:px-7 lg:px-10">
      <header className="mb-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-emerald-300">
            <span
              className={`h-2 w-2 rounded-full ${error ? 'bg-rose-400' : 'live-dot bg-emerald-400'}`}
            />
            {error ??
              `Локальные данные · обновление каждые ${number.format(
                (settings?.refreshIntervalMs ?? 2500) / 1000,
              )} сек`}
          </div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Расход ресурсов Codex
          </h1>
          <p className="mt-2 max-w-2xl text-base text-slate-400">
            Все активные чаты, нагрузка контекста и лимиты подписки в одном
            окне.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 self-start sm:self-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void openAudit()}
            className="gap-2 border-violet-400/25 text-violet-200 hover:bg-violet-400/10"
            title="Открыть сохранённый аудит расхода"
          >
            <Sparkles className="h-4 w-4" />
            AI-аудит расхода
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Настройки монитора"
            title="Настройки"
            onClick={() => {
              setSettingsDraft(settings);
              setSettingsError(null);
              setSettingsOpen(true);
            }}
          >
            <Settings className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Обновить данные"
            title="Обновить"
            onClick={() => void load()}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <section className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={Activity}
          label="Сейчас работают"
          value={String(running)}
          tone="green"
          detail="параллельных чатов"
        />
        <MetricCard
          icon={Database}
          label="Расход недавних"
          value={compact(recentTokens)}
          tone="blue"
          detail="активных за 24 часа*"
        />
        <MetricCard
          icon={AlertTriangle}
          label="Тяжёлый контекст"
          value={String(hot)}
          tone="amber"
          detail="чатов выше 50%"
        />
        <Card className="border-white/10 bg-card/95 shadow-xl shadow-black/10">
          <CardContent className="p-4">
            <div className="mb-3 flex items-center justify-between text-sm text-slate-300">
              <span className="flex items-center gap-2 font-medium">
                <Zap className="h-4 w-4 text-violet-300" />
                <HelpLabel help="Общий семидневный лимит Codex. Отдельные лимиты моделей, например GPT‑5.3‑Codex‑Spark, здесь не подменяют основной счётчик.">
                  Недельный лимит
                </HelpLabel>
              </span>
              <span className="font-mono text-zinc-200">
                {overview?.rateLimit
                  ? `${overview.rateLimit.usedPercent}%`
                  : '—'}
              </span>
            </div>
            <Meter
              value={overview?.rateLimit?.usedPercent ?? 0}
              tone="violet"
            />
            <p className="mt-3 text-sm text-slate-400">
              {overview?.rateLimit?.resetsAt
                ? `Сброс ${new Date(overview.rateLimit.resetsAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                : 'Нет данных об общем недельном лимите'}
            </p>
          </CardContent>
        </Card>
      </section>

      <section className="grid min-h-[720px] items-start gap-4 md:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)]">
        <Card className="overflow-hidden border-white/10 bg-card/95 shadow-2xl shadow-black/15 md:sticky md:top-4">
          <div className="space-y-3 border-b border-white/10 p-4">
            <div>
              <h2 className="text-lg font-semibold">Чаты</h2>
              <p className="mt-1 text-sm text-slate-400">
                Недавние задачи и проекты Codex
              </p>
            </div>
            <div className="relative min-w-0">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Найти чат или проект"
                className="pl-9"
              />
            </div>
            <Select
              value={sort}
              onValueChange={(value) => setSort(value as SortKey)}
            >
              <SelectTrigger className="w-full" aria-label="Сортировка">
                <span>
                  {sort === 'recent'
                    ? 'По активности'
                    : sort === 'tokens'
                      ? 'По расходу'
                      : 'По контексту'}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">По активности</SelectItem>
                <SelectItem value="tokens">По расходу</SelectItem>
                <SelectItem value="context">По контексту</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <nav
            className="max-h-[calc(100vh-7rem)] overflow-y-auto p-2"
            aria-label="Чаты Codex"
          >
            {!overview && <Skeleton className="h-96 w-full bg-white/5" />}
            {recentThreads.length > 0 && (
              <div className="mb-4">
                <p className="px-3 pb-1.5 pt-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Недавние
                </p>
                {visibleRecent.map((thread) => (
                  <ThreadNavItem
                    key={thread.id}
                    thread={thread}
                    selected={thread.id === selectedId}
                    now={overview?.generatedAt ?? thread.updatedAt}
                    onSelect={() => selectThread(thread)}
                  />
                ))}
                {!query && recentThreads.length > 7 && (
                  <button
                    type="button"
                    onClick={() => setShowAllRecent((current) => !current)}
                    className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-400 hover:bg-white/5 hover:text-slate-200"
                  >
                    {showAllRecent
                      ? 'Показать меньше'
                      : `Показать ещё ${recentThreads.length - 7}`}
                  </button>
                )}
              </div>
            )}

            {projectGroups.length > 0 && (
              <p className="px-3 pb-1.5 pt-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Проекты
              </p>
            )}
            {projectGroups.map((group) => {
              const open = openProjects === null || openProjects.has(group.id);
              return (
                <div key={group.id} className="mb-1">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() =>
                      setOpenProjects((current) => {
                        const next = new Set(
                          current ?? projectGroups.map((item) => item.id),
                        );
                        if (next.has(group.id)) next.delete(group.id);
                        else next.add(group.id);
                        return next;
                      })
                    }
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-200 hover:bg-white/5"
                  >
                    {open ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                    <FolderKanban className="h-4 w-4 text-emerald-300" />
                    <span className="min-w-0 flex-1 truncate">
                      {group.name}
                    </span>
                    <span className="font-mono text-xs text-slate-500">
                      {group.threads.length}
                    </span>
                  </button>
                  {open && (
                    <div className="ml-3 border-l border-white/8 pl-1">
                      {group.threads.map((thread) => (
                        <ThreadNavItem
                          key={thread.id}
                          thread={thread}
                          selected={thread.id === selectedId}
                          now={overview?.generatedAt ?? thread.updatedAt}
                          onSelect={() => selectThread(thread)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
        </Card>

        <div className="min-w-0">
          <ThreadDetail
            thread={selected}
            detail={detail}
            loading={detailLoading}
            now={overview?.generatedAt ?? selected?.updatedAt ?? 0}
          />
        </div>
      </section>

      <p className="mt-4 px-1 text-sm text-slate-500">
        * Сумма по чатам, активным за последние 24 часа; длинные чаты включают
        накопительный расход. Вклад чата в неделю — оценка по росту общего
        счётчика; из-за округления и параллельных задач она не является точным
        биллингом.
      </p>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        value={settingsDraft}
        onChange={setSettingsDraft}
        onSave={() => void saveSettings()}
        saving={settingsSaving}
        error={settingsError}
      />
      <AuditDialog
        open={auditOpen}
        onOpenChange={setAuditOpen}
        local={globalAudit}
        codex={codexAudit}
        onStart={() => void startAudit()}
      />
    </main>
  );
}

function SettingsDialog({
  open,
  onOpenChange,
  value,
  onChange,
  onSave,
  saving,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: MonitorSettings | null;
  onChange: React.Dispatch<React.SetStateAction<MonitorSettings | null>>;
  onSave: () => void;
  saving: boolean;
  error: string | null;
}) {
  const update = <Key extends keyof MonitorSettings>(
    key: Key,
    next: MonitorSettings[Key],
  ) => onChange((current) => (current ? { ...current, [key]: next } : current));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-white/10 bg-slate-950 p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-white/8 px-6 py-5">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Settings className="h-5 w-5 text-emerald-300" />
            Настройки монитора
          </DialogTitle>
          <DialogDescription>
            Источники и глубина локального анализа. Изменения применяются без
            перезапуска.
          </DialogDescription>
        </DialogHeader>
        {value ? (
          <div className="space-y-5 px-6 py-2">
            <div className="space-y-2">
              <Label htmlFor="data-directory">Каталог данных Codex</Label>
              <Input
                id="data-directory"
                className="font-mono text-xs"
                value={value.dataDir}
                onChange={(event) => update('dataDir', event.target.value)}
              />
              <p className="text-xs leading-relaxed text-slate-500">
                Здесь должны находиться базы состояния и пути к rollout-файлам.
                Можно использовать <code>~/.codex</code>.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <SettingSelect
                label="Обновление интерфейса"
                value={value.refreshIntervalMs}
                options={[
                  [1000, '1 секунда'],
                  [2500, '2,5 секунды'],
                  [5000, '5 секунд'],
                  [10000, '10 секунд'],
                ]}
                onChange={(next) => update('refreshIntervalMs', next)}
              />
              <SettingSelect
                label="Задач в списке"
                value={value.recentThreadsLimit}
                options={[
                  [40, '40 задач'],
                  [80, '80 задач'],
                  [160, '160 задач'],
                  [300, '300 задач'],
                ]}
                onChange={(next) => update('recentThreadsLimit', next)}
              />
              <SettingSelect
                label="Хвост журнала на задачу"
                value={value.overviewTailMb}
                options={[
                  [1, '1 МБ · быстрее'],
                  [4, '4 МБ'],
                  [16, '16 МБ · точнее'],
                  [32, '32 МБ'],
                ]}
                onChange={(next) => update('overviewTailMb', next)}
              />
              <SettingSelect
                label="Точек на графике"
                value={value.detailPointLimit}
                options={[
                  [160, '160'],
                  [320, '320'],
                  [640, '640'],
                  [1200, '1 200'],
                ]}
                onChange={(next) => update('detailPointLimit', next)}
              />
            </div>

            <div className="flex items-start justify-between gap-5 rounded-xl border border-white/8 bg-white/[.025] p-4">
              <div>
                <Label htmlFor="tool-output-analysis">
                  Анализировать объём ответов инструментов
                </Label>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                  Считается только число символов. Содержимое не сохраняется и
                  не отправляется наружу.
                </p>
              </div>
              <Switch
                id="tool-output-analysis"
                checked={value.analyzeToolOutputs}
                onCheckedChange={(checked) =>
                  update('analyzeToolOutputs', checked)
                }
              />
            </div>

            <div className="rounded-xl border border-emerald-400/10 bg-emerald-400/[.035] p-4 text-xs leading-relaxed text-slate-400">
              <p>
                <span className="text-slate-200">Базы:</span>{' '}
                {value.databaseSource}
              </p>
              <p className="mt-1">
                <span className="text-slate-200">Телеметрия:</span>{' '}
                {value.telemetrySource}
              </p>
              <p className="mt-1 truncate" title={value.settingsPath}>
                <span className="text-slate-200">Файл настроек:</span>{' '}
                {value.settingsPath}
              </p>
            </div>
            {error && (
              <p className="rounded-lg bg-rose-400/10 px-3 py-2 text-sm text-rose-300">
                {error}
              </p>
            )}
          </div>
        ) : (
          <div className="px-6 py-10">
            <Skeleton className="h-56 w-full bg-white/5" />
          </div>
        )}
        <DialogFooter className="m-0 border-white/8 bg-white/[.02] px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button disabled={!value || saving} onClick={onSave}>
            {saving ? 'Проверяю…' : 'Сохранить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettingSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: Array<[number, string]>;
  onChange: (value: number) => void;
}) {
  return (
    <label className="space-y-2 text-sm font-medium text-slate-200">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-9 w-full rounded-lg border border-white/10 bg-slate-900 px-3 text-sm text-slate-200 outline-none focus:border-emerald-400/50"
      >
        {options.map(([optionValue, title]) => (
          <option key={optionValue} value={optionValue}>
            {title}
          </option>
        ))}
      </select>
    </label>
  );
}

function AuditDialog({
  open,
  onOpenChange,
  local,
  codex,
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  local: GlobalAudit | null;
  codex: CodexAuditState | null;
  onStart: () => void;
}) {
  const active = codex?.status === 'preparing' || codex?.status === 'running';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-white/10 bg-slate-950 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-white/8 px-6 py-5">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="h-5 w-5 text-violet-300" />
            Аудит расхода Codex
          </DialogTitle>
          <DialogDescription>
            Здесь хранится последний результат. Открытие окна не расходует
            лимит. Новый анализ запускается отдельной кнопкой и обращается к
            Codex в режиме только чтения.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5 px-6 py-1">
          {local ? (
            <>
              <div className="grid gap-3 sm:grid-cols-4">
                <AuditMetric
                  label="Задач"
                  value={String(local.scope.threads)}
                />
                <AuditMetric
                  label="Сжатий"
                  value={String(local.metrics.compactions)}
                />
                <AuditMetric
                  label="Старт в среднем"
                  value={compact(local.metrics.averageStartupTokens)}
                />
                <AuditMetric
                  label="Кэш входа"
                  value={
                    local.metrics.cachePercent == null
                      ? '—'
                      : `${local.metrics.cachePercent}%`
                  }
                />
              </div>
              <div className="space-y-2">
                {local.recommendations.map((item) => (
                  <div
                    key={item.title}
                    className="rounded-xl border border-white/8 bg-white/[.025] p-4"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          item.severity === 'high'
                            ? 'bg-rose-400'
                            : item.severity === 'medium'
                              ? 'bg-amber-400'
                              : 'bg-emerald-400'
                        }`}
                      />
                      <h3 className="font-medium text-slate-100">
                        {item.title}
                      </h3>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-slate-400">
                      {item.evidence}
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-slate-200">
                      {item.action}
                    </p>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-400">
              Аудит ещё не запускался. Нажмите кнопку ниже, чтобы собрать
              показатели и получить рекомендации.
            </div>
          )}

          <div className="rounded-xl border border-violet-400/15 bg-violet-400/[.035] p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-violet-200">
              <span
                className={`h-2 w-2 rounded-full ${active ? 'live-dot bg-violet-400' : codex?.status === 'failed' ? 'bg-rose-400' : 'bg-emerald-400'}`}
              />
              {active
                ? codex?.status === 'preparing'
                  ? 'Готовлю компактный отчёт…'
                  : 'Codex анализирует расход…'
                : codex?.status === 'failed'
                  ? 'Аудит завершился с ошибкой'
                  : codex?.status === 'completed'
                    ? 'Рекомендации Codex'
                    : 'Ожидание запуска'}
              {!active && codex?.completedAt && (
                <span className="ml-auto text-xs font-normal text-slate-500">
                  {new Date(codex.completedAt).toLocaleString('ru-RU')}
                </span>
              )}
            </div>
            {codex?.result && (
              <div className="max-h-80 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
                {codex.result}
              </div>
            )}
            {codex?.error && (
              <p className="whitespace-pre-wrap text-sm text-rose-300">
                {codex.error}
              </p>
            )}
          </div>
        </div>
        <DialogFooter className="m-0 gap-2 border-white/8 bg-white/[.02] px-6 py-4 sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {active ? 'Скрыть' : 'Закрыть'}
          </Button>
          <Button
            onClick={onStart}
            disabled={active}
            className="gap-2 bg-violet-500 text-white hover:bg-violet-400"
            title="Запускает новую задачу Codex и расходует лимит подписки"
          >
            <Sparkles className="h-4 w-4" />
            {active ? 'Аудит выполняется…' : 'Запустить новый аудит'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AuditMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[.025] p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 font-mono text-lg text-slate-100">{value}</p>
    </div>
  );
}

function ThreadNavItem({
  thread,
  selected,
  now,
  onSelect,
}: {
  thread: Thread;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const context = Math.min(100, Math.max(0, thread.contextPercent ?? 0));
  const contextTone =
    context >= 60
      ? 'bg-rose-400'
      : context >= 35
        ? 'bg-amber-400'
        : 'bg-emerald-400';
  const shouldRestart = thread.compactions >= 2;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Открыть задачу: ${thread.title}`}
      aria-current={selected ? 'page' : undefined}
      className={`mb-1 w-full rounded-xl px-3 py-2.5 text-left transition-colors ${
        selected
          ? 'bg-emerald-400/10 ring-1 ring-inset ring-emerald-400/20'
          : 'hover:bg-white/[.045]'
      }`}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          title={statusLabel(thread.status)}
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
            thread.status === 'running'
              ? 'live-dot bg-emerald-400'
              : thread.status === 'failed'
                ? 'bg-rose-400'
                : thread.status === 'interrupted'
                  ? 'bg-amber-400'
                  : 'bg-slate-600'
          }`}
        />
        <div className="min-w-0 flex-1">
          <p
            className={`truncate text-sm leading-snug ${selected ? 'font-medium text-slate-50' : 'text-slate-300'}`}
          >
            {thread.title}
          </p>
          {shouldRestart && (
            <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
              <AlertTriangle className="h-3 w-3" />
              Пора в новую задачу
            </span>
          )}
          <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-slate-500">
            <span>{compact(thread.totalTokens)}</span>
            <span>·</span>
            <span>
              {thread.contextPercent == null ? '—' : `${Math.round(context)}%`}
            </span>
            {thread.weeklyUsagePercent != null && (
              <>
                <span>·</span>
                <span
                  className="text-violet-300"
                  title="Оценка вклада этого чата в текущий недельный лимит"
                >
                  {weeklyContribution(thread.weeklyUsagePercent)} нед.
                </span>
              </>
            )}
            <span className="ml-auto font-sans">
              {relativeTime(thread.updatedAt, now)}
            </span>
          </div>
          <div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-white/7">
            <div
              className={`h-full rounded-full ${contextTone}`}
              style={{ width: `${context}%` }}
            />
          </div>
        </div>
      </div>
    </button>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  detail: string;
  tone: 'green' | 'blue' | 'amber';
}) {
  const tones = {
    green: 'text-emerald-300 bg-emerald-400/8 border-emerald-400/15',
    blue: 'text-sky-300 bg-sky-400/8 border-sky-400/15',
    amber: 'text-amber-300 bg-amber-400/8 border-amber-400/15',
  };
  return (
    <Card className="border-white/10 bg-card/95 shadow-xl shadow-black/10">
      <CardContent className="flex items-center gap-4 p-5">
        <div
          className={`grid h-10 w-10 place-items-center rounded-lg border ${tones[tone]}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm font-medium text-slate-300">{label}</p>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold text-slate-50">
              {value}
            </span>
            <span className="text-sm text-slate-400">{detail}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ThreadDetail({
  thread,
  detail,
  loading,
  now,
}: {
  thread: Thread | null;
  detail: Detail | null;
  loading: boolean;
  now: number;
}) {
  if (!thread) {
    return (
      <Card className="grid place-items-center border-white/8 bg-card/88 p-8 text-sm text-zinc-500">
        Выберите чат
      </Card>
    );
  }
  const cachedShare = thread.last?.inputTokens
    ? Math.round(
        (thread.last.cachedInputTokens / thread.last.inputTokens) * 100,
      )
    : null;
  const lastRequest = detail?.analysis.requests.at(-1);
  const startupBase =
    detail?.analysis.startup
      .filter((item) => item.name !== 'Первый запрос пользователя')
      .reduce((sum, item) => sum + item.estimatedTokens, 0) ?? 0;
  const estimatedNewSessionInput = startupBase + 3_000;
  const estimatedRestartSavings = Math.max(
    0,
    (lastRequest?.inputTokens ?? 0) - estimatedNewSessionInput,
  );
  const shouldRestart =
    (detail?.compactions ?? 0) >= 2 &&
    ((thread.contextPercent ?? 0) >= 50 || estimatedRestartSavings >= 10_000);
  return (
    <Card className="w-full min-w-0 max-w-full overflow-hidden border-emerald-400/15 bg-slate-950/35 shadow-inner shadow-black/20">
      <div className="border-b border-white/8 p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="line-clamp-3 font-semibold leading-snug">
            {thread.title}
          </h2>
          {thread.status === 'running' && (
            <Badge className="shrink-0 bg-emerald-400/12 text-emerald-300">
              LIVE
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-zinc-500">
          <span className="rounded-md bg-white/5 px-2 py-1 font-mono">
            {thread.model ?? 'unknown'}
          </span>
          {thread.reasoningEffort && (
            <span className="rounded-md bg-white/5 px-2 py-1 font-mono">
              reasoning: {thread.reasoningEffort}
            </span>
          )}
        </div>
        <p className="mt-3 truncate text-sm text-slate-400" title={thread.cwd}>
          {thread.cwd}
        </p>
      </div>

      <CardContent className="min-w-0 space-y-5 whitespace-normal p-5">
        <div>
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-zinc-400">Заполнение контекста</span>
            <span className="font-mono text-zinc-200">
              {thread.contextPercent == null
                ? '—'
                : `${Math.round(thread.contextPercent)}%`}
            </span>
          </div>
          <Meter
            value={thread.contextPercent ?? 0}
            tone={contextMeterTone(thread.contextPercent)}
          />
          <div className="mt-2 flex justify-between font-mono text-[11px] text-zinc-600">
            <span>
              {thread.last ? compact(thread.last.inputTokens) : '—'} сейчас
            </span>
            <span>
              {thread.contextWindow ? compact(thread.contextWindow) : '—'}{' '}
              максимум
            </span>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">
            Расчёт: входные токены последнего хода ÷ окно модели. Кэшированные
            входные токены входят в это число, потому что они тоже занимают
            окно.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <SmallStat label="Всего в чате" value={compact(thread.totalTokens)} />
          <SmallStat
            label="Последний запрос"
            value={thread.last ? compact(thread.last.totalTokens) : '—'}
          />
          <SmallStat
            label="Из кэша"
            value={cachedShare == null ? '—' : `${cachedShare}%`}
          />
          <SmallStat
            label="Ходов / сжатий"
            value={detail ? `${detail.turns} / ${detail.compactions}` : '—'}
          />
          <SmallStat
            label="Вклад в неделю*"
            value={weeklyContribution(thread.weeklyUsagePercent)}
          />
        </div>

        {detail?.subagents?.length ? (
          <SubagentBreakdown subagents={detail.subagents} />
        ) : null}

        {shouldRestart && (
          <div className="rounded-xl border border-amber-300/25 bg-amber-300/[.075] p-4 text-amber-100">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
              <div>
                <p className="font-semibold">Пора начать новую задачу</p>
                <p className="mt-1 text-sm leading-relaxed text-amber-100/75">
                  Сжатий: {detail?.compactions}. При передаче состояния объёмом
                  около 3K токенов следующий вход оценивается в{' '}
                  {compact(estimatedNewSessionInput)} вместо{' '}
                  {compact(lastRequest?.inputTokens ?? 0)}: экономия около{' '}
                  {compact(estimatedRestartSavings)} на каждом следующем
                  обращении. Это оценка по стартовому пакету этого чата.
                </p>
              </div>
            </div>
          </div>
        )}

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-medium text-slate-200">
              <HelpLabel help="История размера входного контекста. Жёлтая пунктирная линия — подтверждённое сжатие из журнала. Падение без такой линии может быть сбросом или сменой окна.">
                Рост контекста
              </HelpLabel>
            </h3>
            <span className="text-[11px] text-zinc-600">
              период и масштаб ниже
            </span>
          </div>
          <div className="h-64 min-w-0 rounded-xl border border-white/8 bg-black/10 p-2">
            {loading ? (
              <Skeleton className="h-full w-full bg-white/5" />
            ) : detail?.points.length ? (
              <ContextChart
                key={detail.id}
                points={detail.points}
                compactionTimestamps={detail.compactionTimestamps}
              />
            ) : (
              <div className="grid h-full place-items-center text-xs text-zinc-600">
                История ещё не собрана
              </div>
            )}
          </div>
        </div>

        <TokenAnalysis
          analysis={detail?.analysis ?? null}
          contextWindow={thread.contextWindow}
          compactions={detail?.compactions ?? 0}
          loading={loading}
        />

        {thread.contextPercent != null && thread.contextPercent >= 50 && (
          <div className="rounded-lg border border-amber-400/20 bg-amber-400/7 p-3 text-xs leading-relaxed text-amber-200/80">
            <AlertTriangle className="mr-2 inline h-4 w-4" />
            Контекст стал тяжёлым. Каждый следующий шаг будет повторно
            обрабатывать около{' '}
            {thread.last ? compact(thread.last.inputTokens) : 'много'} входных
            токенов.
          </div>
        )}

        <div className="space-y-2 border-t border-white/8 pt-4 text-xs text-zinc-500">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <Clock3 className="h-3.5 w-3.5" />
              Последняя активность
            </span>
            <span>{relativeTime(thread.updatedAt, now)}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <BrainCircuit className="h-3.5 w-3.5" />
              Reasoning-токены
            </span>
            <span className="font-mono">
              {thread.last ? compact(thread.last.reasoningOutputTokens) : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <ArrowDown className="h-3.5 w-3.5" />
              Вход / кэш
            </span>
            <span className="font-mono">
              {thread.last
                ? `${compact(thread.last.inputTokens)} / ${compact(thread.last.cachedInputTokens)}`
                : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <ArrowUp className="h-3.5 w-3.5" />
              Выход
            </span>
            <span className="font-mono">
              {thread.last ? compact(thread.last.outputTokens) : '—'}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SubagentBreakdown({ subagents }: { subagents: Subagent[] }) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-slate-200">Сабагенты</h3>
        <span className="text-xs text-slate-500">
          {subagents.length} в дереве задачи
        </span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-white/8">
        <table className="w-full min-w-[800px] text-left text-xs">
          <thead className="bg-white/[.035] text-slate-400">
            <tr>
              <th className="p-3 font-medium">Агент и задача</th>
              <th className="p-3 font-medium">Модель</th>
              <th className="p-3 text-right font-medium">Вход / кэш</th>
              <th className="p-3 text-right font-medium">Выход / reasoning</th>
              <th className="p-3 text-right font-medium">Всего</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/6">
            {subagents.map((agent) => (
              <tr key={agent.id} className="hover:bg-white/[.025]">
                <td className="max-w-80 p-3">
                  <div
                    className="flex items-center gap-2"
                    style={{ paddingLeft: `${(agent.depth - 1) * 12}px` }}
                  >
                    <span
                      title={statusLabel(agent.status)}
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        agent.status === 'running'
                          ? 'live-dot bg-emerald-400'
                          : agent.status === 'failed'
                            ? 'bg-rose-400'
                            : agent.status === 'interrupted'
                              ? 'bg-amber-400'
                              : 'bg-slate-600'
                      }`}
                    />
                    <span className="truncate font-medium text-slate-200">
                      {agent.nickname ?? 'Сабагент'}
                    </span>
                  </div>
                  <p
                    className="mt-1 truncate font-mono text-[11px] text-slate-500"
                    title={`${agent.taskPath ?? 'без пути'} · ${agent.cwd}`}
                    style={{ paddingLeft: `${(agent.depth - 1) * 12 + 16}px` }}
                  >
                    {agent.taskPath ?? 'без пути'} · {projectName(agent.cwd)}
                  </p>
                </td>
                <td className="p-3">
                  <p className="font-mono text-slate-300">
                    {agent.model ?? 'unknown'}
                  </p>
                  <p className="mt-1 text-slate-500">
                    reasoning: {agent.reasoningEffort ?? '—'}
                  </p>
                </td>
                <td className="p-3 text-right font-mono text-slate-300">
                  {agent.total
                    ? `${compact(agent.total.inputTokens)} / ${compact(agent.total.cachedInputTokens)}`
                    : '—'}
                </td>
                <td className="p-3 text-right font-mono text-slate-300">
                  {agent.total
                    ? `${compact(agent.total.outputTokens)} / ${compact(agent.total.reasoningOutputTokens)}`
                    : '—'}
                </td>
                <td className="p-3 text-right font-mono text-slate-100">
                  {compact(agent.totalTokens)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TokenAnalysis({
  analysis,
  contextWindow,
  compactions,
  loading,
}: {
  analysis: TokenAnalysisData | null;
  contextWindow: number | null;
  compactions: number;
  loading: boolean;
}) {
  if (loading && !analysis) {
    return <Skeleton className="h-72 w-full rounded-xl bg-white/5" />;
  }
  if (!analysis) return null;

  const { totals } = analysis;
  const cacheShare = totals.inputTokens
    ? Math.round((totals.cachedInputTokens / totals.inputTokens) * 100)
    : 0;
  const peakContext = contextWindow
    ? Math.round((totals.peakInputTokens / contextWindow) * 100)
    : null;
  const topCategory = analysis.categories[0];
  const topTool = analysis.tools[0];
  const lastRequest = analysis.requests.at(-1);
  const startupBase = analysis.startup
    .filter((item) => item.name !== 'Первый запрос пользователя')
    .reduce((sum, item) => sum + item.estimatedTokens, 0);
  const assumedHandoff = 3_000;
  const estimatedFreshInput = startupBase + assumedHandoff;
  const estimatedSavings = Math.max(
    0,
    (lastRequest?.inputTokens ?? 0) - estimatedFreshInput,
  );
  const recommendations = [
    totals.firstRequestInputTokens >= 20_000
      ? `Стартовый пакет уже занимает ${compact(totals.firstRequestInputTokens)} токенов. Сокращение AGENTS.md, каталога навыков и постоянно подключённых инструментов уменьшит каждый первый запрос.`
      : null,
    topCategory
      ? `Больше всего повторной обработки связано с категорией «${topCategory.name}»: ${compact(topCategory.inputTokens)} входных токенов за ${topCategory.requests} запросов к модели.`
      : null,
    peakContext != null && peakContext >= 60
      ? `Пик контекста достиг ${peakContext}%. После этой точки каждый вызов инструмента повторно передаёт большой объём истории.`
      : null,
    cacheShare < 70
      ? `Из кэша пришло ${cacheShare}% входа. Частые изменения начала запроса или системных инструкций могут снижать повторное использование кэша.`
      : `Кэш покрывает ${cacheShare}% входных токенов и заметно снижает стоимость повторной обработки.`,
    topTool && topTool.outputChars > 100_000
      ? `Самый объёмный источник данных — ${topTool.name}: ${compact(topTool.outputChars)} символов ответов. Полезно сужать выборки и лимиты вывода.`
      : null,
    compactions >= 2 && estimatedSavings > 10_000
      ? `В чате уже ${compactions} сжатия. Новая задача с передачей состояния на 3K токенов сократила бы следующий вход примерно на ${compact(estimatedSavings)}.`
      : null,
  ].filter((item): item is string => Boolean(item));
  const maxCategory = Math.max(
    ...analysis.categories.map((item) => item.inputTokens),
    1,
  );
  const maxStartup = Math.max(
    ...analysis.startup.map((item) => item.estimatedTokens),
    1,
  );

  return (
    <section className="space-y-4 border-t border-white/8 pt-5">
      <div>
        <h3 className="text-lg font-semibold text-slate-100">
          Детальный анализ расхода
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-slate-400">
          Точные значения берутся из каждого `token_usage_record`. Разбивка
          первого запроса по блокам оценочная: точный вход распределён
          пропорционально объёму сохранённого текста.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <SmallStat
          label="Запросов к модели"
          value={compact(totals.modelRequests)}
        />
        <SmallStat label="Вход суммарно" value={compact(totals.inputTokens)} />
        <SmallStat label="Из кэша" value={`${cacheShare}%`} />
        <SmallStat label="Выход" value={compact(totals.outputTokens)} />
        <SmallStat
          label="Reasoning"
          value={compact(totals.reasoningOutputTokens)}
        />
        <SmallStat
          label="Пик окна"
          value={
            peakContext == null
              ? compact(totals.peakInputTokens)
              : `${peakContext}%`
          }
        />
      </div>

      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <AnalysisPanel title="Где проседает" icon={AlertTriangle} open>
          <div className="space-y-2">
            {recommendations.map((text) => (
              <div
                key={text}
                className="min-w-0 break-words rounded-xl border border-amber-300/10 bg-amber-300/[.045] p-3 text-sm leading-relaxed text-slate-300"
              >
                {text}
              </div>
            ))}
          </div>
        </AnalysisPanel>

        <AnalysisPanel title="Повторная обработка входа" icon={Activity} open>
          <p className="mb-3 text-xs leading-relaxed text-slate-500">
            Точная сумма входных токенов запросов, сгруппированных по тому,
            какое действие модель решила выполнить.
          </p>
          <div className="space-y-3">
            {analysis.categories.map((item) => (
              <MetricBar
                key={item.name}
                label={item.name}
                value={item.inputTokens}
                maximum={maxCategory}
                suffix={`${item.requests} запросов`}
              />
            ))}
          </div>
        </AnalysisPanel>

        <AnalysisPanel title="Стартовый пакет" icon={Database}>
          <div className="mb-3 rounded-xl border border-sky-300/10 bg-sky-300/[.045] p-3 text-sm text-slate-300">
            Первый запрос:{' '}
            <strong>{compact(totals.firstRequestInputTokens)}</strong> токенов.
            Ниже — оценка вклада каждого блока.
          </div>
          <div className="space-y-3">
            {analysis.startup.map((item) => (
              <MetricBar
                key={item.name}
                label={item.name}
                value={item.estimatedTokens}
                maximum={maxStartup}
                suffix={`${compact(item.chars)} символов`}
                estimated
              />
            ))}
          </div>
        </AnalysisPanel>

        <AnalysisPanel title="Инструменты и объём ответов" icon={Wrench}>
          <p className="mb-3 text-xs leading-relaxed text-slate-500">
            Большой ответ инструмента попадает в историю и увеличивает вход
            следующего запроса. Размер показан в символах до токенизации.
          </p>
          <div className="divide-y divide-white/6">
            {analysis.tools.slice(0, 12).map((tool) => (
              <div
                key={tool.name}
                className="flex items-center justify-between gap-4 py-2.5 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-slate-200">
                    {tool.name}
                  </p>
                  <p className="text-xs text-slate-500">{tool.category}</p>
                </div>
                <div className="shrink-0 text-right font-mono text-slate-300">
                  <p>{tool.calls} выз.</p>
                  <p className="text-xs text-slate-500">
                    {compact(tool.outputChars)} симв.
                  </p>
                </div>
              </div>
            ))}
          </div>
        </AnalysisPanel>
      </div>

      <AnalysisPanel title="Запросы к модели по времени" icon={Terminal}>
        <div className="max-h-96 overflow-auto rounded-xl border border-white/8">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="sticky top-0 bg-slate-950 text-slate-400">
              <tr>
                <th className="p-2.5 font-medium">Время и действие</th>
                <th className="p-2.5 text-right font-medium">Вход</th>
                <th className="p-2.5 text-right font-medium">Δ входа</th>
                <th className="p-2.5 text-right font-medium">Кэш</th>
                <th className="p-2.5 text-right font-medium">Выход</th>
                <th className="p-2.5 text-right font-medium">Новый текст</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/6">
              {[...analysis.requests].reverse().map((request, index) => (
                <tr
                  key={`${request.timestamp}-${index}`}
                  className="hover:bg-white/[.025]"
                >
                  <td className="max-w-80 p-2.5">
                    <p className="truncate text-slate-200">{request.label}</p>
                    <p className="mt-0.5 text-slate-500">
                      {new Date(request.timestamp).toLocaleTimeString('ru-RU')}{' '}
                      · {request.category}
                    </p>
                  </td>
                  <td className="p-2.5 text-right font-mono text-slate-200">
                    {compact(request.inputTokens)}
                  </td>
                  <td
                    className={`p-2.5 text-right font-mono ${request.inputDelta < 0 ? 'text-emerald-300' : 'text-amber-200'}`}
                  >
                    {request.inputDelta > 0 ? '+' : ''}
                    {compact(request.inputDelta)}
                  </td>
                  <td className="p-2.5 text-right font-mono text-slate-400">
                    {compact(request.cachedInputTokens)}
                  </td>
                  <td className="p-2.5 text-right font-mono text-slate-400">
                    {compact(
                      request.outputTokens + request.reasoningOutputTokens,
                    )}
                  </td>
                  <td className="p-2.5 text-right font-mono text-slate-400">
                    {compact(request.newContentChars)} симв.
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AnalysisPanel>
    </section>
  );
}

function AnalysisPanel({
  title,
  icon: Icon,
  open = false,
  children,
}: {
  title: string;
  icon: typeof Activity;
  open?: boolean;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(open);
  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="group min-w-0 overflow-hidden rounded-xl border border-white/8 bg-white/[.025]"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 p-4 font-medium text-slate-200">
        <Icon className="h-4 w-4 text-emerald-300" />
        {title}
        <ChevronRight className="ml-auto h-4 w-4 transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t border-white/6 p-4">{children}</div>
    </details>
  );
}

function MetricBar({
  label,
  value,
  maximum,
  suffix,
  estimated = false,
}: {
  label: string;
  value: number;
  maximum: number;
  suffix: string;
  estimated?: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-end justify-between gap-3 text-sm">
        <span className="text-slate-300">{label}</span>
        <span className="shrink-0 font-mono text-slate-200">
          {estimated ? '≈' : ''}
          {compact(value)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
        <div
          className="h-full rounded-full bg-emerald-400"
          style={{ width: `${Math.max(2, (value / maximum) * 100)}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-slate-500">{suffix}</p>
    </div>
  );
}

type ChartRange = '1h' | '6h' | '24h' | 'all';

function ContextChart({
  points,
  compactionTimestamps,
}: {
  points: DetailPoint[];
  compactionTimestamps: number[];
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [range, setRange] = useState<ChartRange>('all');
  const [zoom, setZoom] = useState(1);
  const latestTimestamp = points.at(-1)?.timestamp ?? 0;
  const rangeHours = range === 'all' ? null : Number.parseInt(range, 10);
  const rangeStart = rangeHours
    ? latestTimestamp - rangeHours * 60 * 60 * 1000
    : (points[0]?.timestamp ?? latestTimestamp);
  const basePoints = points.filter((point) => point.timestamp >= rangeStart);
  const baseStart = basePoints[0]?.timestamp ?? latestTimestamp;
  const baseDuration = Math.max(1, latestTimestamp - baseStart);
  const visibleStart = latestTimestamp - baseDuration / zoom;
  let visiblePoints = basePoints.filter(
    (point) => point.timestamp >= visibleStart,
  );
  if (visiblePoints.length < 2 && points.length >= 2) {
    visiblePoints = points.slice(-2);
  }
  const firstTimestamp = visiblePoints[0]?.timestamp ?? latestTimestamp;
  const visibleDuration = Math.max(1, latestTimestamp - firstTimestamp);
  const values = visiblePoints.map((point) => point.inputTokens);
  const maximum = Math.max(...values, 1);
  const coordinates = visiblePoints
    .map((point) => {
      const x =
        visibleDuration === 1
          ? 0
          : ((point.timestamp - firstTimestamp) / visibleDuration) * 100;
      const y = 36 - (point.inputTokens / maximum) * 31;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const area = `0,40 ${coordinates} 100,40`;
  const visibleCompactions = compactionTimestamps.filter(
    (timestamp) => timestamp >= firstTimestamp && timestamp <= latestTimestamp,
  );
  const periodLabel = `${new Date(firstTimestamp).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })} — ${new Date(latestTimestamp).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
  const chooseRange = (next: ChartRange) => {
    setRange(next);
    setZoom(1);
    setHovered(null);
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex rounded-lg border border-white/8 bg-black/10 p-0.5">
          {(['1h', '6h', '24h', 'all'] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => chooseRange(item)}
              className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                range === item
                  ? 'bg-white/10 text-slate-100'
                  : 'text-slate-500 hover:text-slate-200'
              }`}
            >
              {item === 'all' ? 'Всё' : item.replace('h', ' ч')}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title="Приблизить последние данные"
            aria-label="Приблизить график"
            disabled={zoom >= 16}
            onClick={() => {
              setZoom((current) => Math.min(16, current * 2));
              setHovered(null);
            }}
            className="rounded-md p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-200 disabled:opacity-30"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Отдалить"
            aria-label="Отдалить график"
            disabled={zoom <= 1}
            onClick={() => {
              setZoom((current) => Math.max(1, current / 2));
              setHovered(null);
            }}
            className="rounded-md p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-200 disabled:opacity-30"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <span className="w-8 text-right font-mono text-[10px] text-slate-500">
            {zoom}×
          </span>
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between px-1 text-[10px] text-slate-600">
        <span>{periodLabel}</span>
        <span>макс. {compact(maximum)}</span>
      </div>
      <div
        className="relative mt-2 min-h-0 flex-1 touch-none"
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = Math.min(
            1,
            Math.max(0, (event.clientX - rect.left) / rect.width),
          );
          const targetTimestamp = firstTimestamp + ratio * visibleDuration;
          let next = 0;
          let distance = Number.POSITIVE_INFINITY;
          for (let index = 0; index < visiblePoints.length; index += 1) {
            const nextDistance = Math.abs(
              visiblePoints[index].timestamp - targetTimestamp,
            );
            if (nextDistance < distance) {
              distance = nextDistance;
              next = index;
            }
          }
          setHovered((current) => (current === next ? current : next));
        }}
        onPointerLeave={() => setHovered(null)}
      >
        <svg
          viewBox="0 0 100 40"
          preserveAspectRatio="none"
          className="h-full w-full overflow-visible"
        >
          <title>График роста входного контекста</title>
          <defs>
            <linearGradient id="contextFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#34d399" stopOpacity="0.36" />
              <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`M ${area} Z`} fill="url(#contextFill)" />
          <polyline
            points={coordinates}
            fill="none"
            stroke="#34d399"
            strokeWidth="0.8"
            vectorEffect="non-scaling-stroke"
          />
          {visibleCompactions.map((timestamp) => {
            const x = ((timestamp - firstTimestamp) / visibleDuration) * 100;
            return (
              <line
                key={timestamp}
                x1={x}
                x2={x}
                y1="2"
                y2="39"
                stroke="#fbbf24"
                strokeWidth="0.8"
                strokeDasharray="2 2"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>
        {hovered != null && (
          <ChartCursor
            point={visiblePoints[hovered]}
            left={
              ((visiblePoints[hovered].timestamp - firstTimestamp) /
                visibleDuration) *
              100
            }
            maximum={maximum}
          />
        )}
      </div>
      <div className="flex justify-between px-1 text-xs text-slate-500">
        <span>
          {visiblePoints.length} замеров
          {visibleCompactions.length > 0 && (
            <span className="ml-2 text-amber-300">
              │ {visibleCompactions.length} сжат.
            </span>
          )}
        </span>
        <span>сейчас {compact(values.at(-1) ?? 0)}</span>
      </div>
    </div>
  );
}

function ChartCursor({
  point,
  left,
  maximum,
}: {
  point: DetailPoint;
  left: number;
  maximum: number;
}) {
  const top = 12.5 + (1 - point.inputTokens / maximum) * 77.5;
  const alignRight = left > 72;
  return (
    <>
      <span
        className="pointer-events-none absolute inset-y-0 w-px bg-emerald-200/50"
        style={{ left: `${left}%` }}
      />
      <span
        className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-slate-950 bg-emerald-300 shadow-[0_0_0_3px_rgba(52,211,153,.18)]"
        style={{ left: `${left}%`, top: `${top}%` }}
      />
      <div
        className="pointer-events-none absolute top-1 z-20 w-56 rounded-xl border border-white/10 bg-slate-950/95 p-3 text-xs shadow-2xl"
        style={alignRight ? { right: `${100 - left}%` } : { left: `${left}%` }}
      >
        <p className="mb-2 font-medium text-slate-100">
          {new Date(point.timestamp).toLocaleString('ru-RU', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </p>
        <ChartValue label="Вход" value={compact(point.inputTokens)} />
        <ChartValue
          label="Окно"
          value={
            point.contextPercent == null
              ? '—'
              : `${Math.round(point.contextPercent)}%`
          }
        />
        <ChartValue label="Кэш" value={compact(point.cachedInputTokens)} />
        <ChartValue label="Выход" value={compact(point.outputTokens)} />
        <ChartValue
          label="Reasoning"
          value={compact(point.reasoningOutputTokens)}
        />
      </div>
    </>
  );
}

function ChartValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-0.5 text-slate-400">
      <span>{label}</span>
      <span className="font-mono text-slate-100">{value}</span>
    </div>
  );
}

function SmallStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[.035] p-3.5">
      <p className="text-xs font-medium text-slate-400">{label}</p>
      <p className="mt-1.5 font-mono text-lg font-medium text-slate-100">
        {value}
      </p>
    </div>
  );
}
