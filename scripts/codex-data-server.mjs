import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  createReadStream,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.CODEX_USAGE_PORT || 64111);
const DEFAULT_DATA_DIR =
  process.env.CODEX_DATA_DIR || join(homedir(), '.codex');
const SETTINGS_DIR = join(homedir(), '.codex-usage-monitor');
const SETTINGS_PATH = join(SETTINGS_DIR, 'settings.json');
const AUDIT_DIR = join(SETTINGS_DIR, 'audit');
const AUDIT_REPORT_PATH = join(AUDIT_DIR, 'usage-report.json');
const AUDIT_RESULT_PATH = join(AUDIT_DIR, 'latest-result.md');
const AUDIT_SKILL_PATH = join(AUDIT_DIR, 'codex-usage-audit', 'SKILL.md');
const BUNDLED_AUDIT_SKILL = new URL(
  '../skills/codex-usage-audit/SKILL.md',
  import.meta.url,
);
const DEFAULT_SETTINGS = {
  dataDir: DEFAULT_DATA_DIR,
  refreshIntervalMs: 2500,
  recentThreadsLimit: 80,
  overviewTailMb: 1,
  detailPointLimit: 320,
  analyzeToolOutputs: true,
};
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, Math.round(parsed)))
    : fallback;
}

function expandHome(value) {
  const path = String(value || '').trim();
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(path || DEFAULT_DATA_DIR);
}

function normalizeSettings(value = {}) {
  return {
    dataDir: expandHome(value.dataDir || DEFAULT_DATA_DIR),
    refreshIntervalMs: clampInteger(
      value.refreshIntervalMs,
      DEFAULT_SETTINGS.refreshIntervalMs,
      1000,
      60_000,
    ),
    recentThreadsLimit: clampInteger(
      value.recentThreadsLimit,
      DEFAULT_SETTINGS.recentThreadsLimit,
      20,
      500,
    ),
    overviewTailMb: clampInteger(
      value.overviewTailMb,
      DEFAULT_SETTINGS.overviewTailMb,
      1,
      32,
    ),
    detailPointLimit: clampInteger(
      value.detailPointLimit,
      DEFAULT_SETTINGS.detailPointLimit,
      100,
      2000,
    ),
    analyzeToolOutputs: value.analyzeToolOutputs !== false,
  };
}

function loadSettings() {
  try {
    return normalizeSettings(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function validateDataDir(dataDir) {
  const directory = expandHome(dataDir);
  try {
    if (!statSync(directory).isDirectory()) throw new Error();
    statSync(join(directory, 'state_5.sqlite'));
    statSync(join(directory, 'thread_history_1.sqlite'));
  } catch {
    throw new Error(
      'В каталоге не найдены state_5.sqlite и thread_history_1.sqlite',
    );
  }
  return directory;
}

function createRuntime(nextSettings) {
  const dataDir = validateDataDir(nextSettings.dataDir);
  const stateDb = new DatabaseSync(join(dataDir, 'state_5.sqlite'), {
    readOnly: true,
  });
  let historyDb;
  try {
    historyDb = new DatabaseSync(join(dataDir, 'thread_history_1.sqlite'), {
      readOnly: true,
    });
  } catch (error) {
    stateDb.close();
    throw error;
  }
  const recentThreads = stateDb.prepare(`
  SELECT t.id, t.rollout_path, t.created_at_ms, t.updated_at_ms, t.recency_at_ms,
         COALESCE(NULLIF(t.name, ''), NULLIF(t.title, ''), NULLIF(t.preview, ''), t.id) AS display_title,
         t.tokens_used, t.model, t.reasoning_effort, t.cwd, t.project_id,
         p.name AS project_name, p.position AS project_position
  FROM threads t
  LEFT JOIN projects p ON p.id = t.project_id
  WHERE t.archived = 0 AND t.preview <> ''
  ORDER BY t.recency_at_ms DESC
  LIMIT ?
  `);
  const threadById = stateDb.prepare(
    'SELECT id, rollout_path FROM threads WHERE id = ? LIMIT 1',
  );
  const latestTurn = historyDb.prepare(
    'SELECT status FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1',
  );
  const turnCount = historyDb.prepare(
    'SELECT COUNT(*) AS count FROM thread_turns WHERE thread_id = ?',
  );
  const subagentsByParent = stateDb.prepare(`
    WITH RECURSIVE descendants(parent_id, id, depth) AS (
      SELECT parent_thread_id, child_thread_id, 1
      FROM thread_spawn_edges
      WHERE parent_thread_id = ?
      UNION ALL
      SELECT edge.parent_thread_id, edge.child_thread_id, descendants.depth + 1
      FROM thread_spawn_edges edge
      JOIN descendants ON edge.parent_thread_id = descendants.id
    )
    SELECT descendants.parent_id, descendants.depth, threads.id,
           threads.rollout_path, threads.agent_nickname, threads.agent_path,
           threads.model, threads.reasoning_effort, threads.cwd,
           threads.tokens_used, threads.created_at_ms
    FROM descendants
    JOIN threads ON threads.id = descendants.id
    ORDER BY threads.created_at_ms ASC
  `);
  const recentSubagents = stateDb.prepare(`
    WITH RECURSIVE descendants(root_id, id) AS (
      SELECT edge.parent_thread_id, edge.child_thread_id
      FROM thread_spawn_edges edge
      WHERE NOT EXISTS (
        SELECT 1 FROM thread_spawn_edges parent
        WHERE parent.child_thread_id = edge.parent_thread_id
      )
      UNION ALL
      SELECT descendants.root_id, edge.child_thread_id
      FROM thread_spawn_edges edge
      JOIN descendants ON edge.parent_thread_id = descendants.id
    )
    SELECT descendants.root_id, threads.rollout_path
    FROM descendants
    JOIN threads ON threads.id = descendants.id
    WHERE threads.updated_at_ms >= ?
  `);
  const savedProjects = stateDb
    .prepare(`
    SELECT p.id, p.name, p.position, r.path
    FROM projects p
    JOIN project_roots r ON r.project_id = p.id
    ORDER BY LENGTH(r.path) DESC, p.position ASC
    `)
    .all();
  return {
    dataDir,
    stateDb,
    historyDb,
    recentThreads,
    threadById,
    latestTurn,
    turnCount,
    subagentsByParent,
    recentSubagents,
    savedProjects,
    close() {
      stateDb.close();
      historyDb.close();
    },
  };
}

let settings = loadSettings();
let runtime = createRuntime(settings);
const usageCache = new Map();
const detailCache = new Map();

function loadCachedAudit() {
  try {
    const result = readFileSync(AUDIT_RESULT_PATH, 'utf8').trim();
    const report = JSON.parse(readFileSync(AUDIT_REPORT_PATH, 'utf8'));
    if (!result) throw new Error('Empty audit result');
    return {
      status: 'completed',
      startedAt: Number(report.generatedAt || 0) || null,
      completedAt: statSync(AUDIT_RESULT_PATH).mtimeMs,
      result,
      report,
      error: null,
    };
  } catch {
    return {
      status: 'idle',
      startedAt: null,
      completedAt: null,
      result: null,
      report: null,
      error: null,
    };
  }
}

function removeFile(path) {
  try {
    unlinkSync(path);
  } catch {
    // Временного файла могло ещё не быть.
  }
}

let auditState = loadCachedAudit();

function saveSettings(value) {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  const temporaryPath = `${SETTINGS_PATH}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, SETTINGS_PATH);
}

function applySettings(value) {
  const nextSettings = normalizeSettings({ ...settings, ...value });
  const nextRuntime = createRuntime(nextSettings);
  try {
    saveSettings(nextSettings);
  } catch (error) {
    nextRuntime.close();
    throw error;
  }
  const previousRuntime = runtime;
  runtime = nextRuntime;
  settings = nextSettings;
  usageCache.clear();
  detailCache.clear();
  previousRuntime.close();
  return publicSettings();
}

function publicSettings() {
  return {
    ...settings,
    dataDir: runtime.dataDir,
    settingsPath: SETTINGS_PATH,
    telemetrySource: 'Локальные rollout JSONL Codex',
    databaseSource: 'state_5.sqlite + thread_history_1.sqlite',
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error('Слишком большой запрос');
  }
  return JSON.parse(body || '{}');
}

function safeTitle(value) {
  return (
    String(value || 'Без названия')
      .split('\n')[0]
      .trim()
      .slice(0, 180) || 'Без названия'
  );
}

function normalizeTokens(raw) {
  if (!raw) return null;
  return {
    inputTokens: Number(raw.input_tokens || 0),
    cachedInputTokens: Number(raw.cached_input_tokens || 0),
    outputTokens: Number(raw.output_tokens || 0),
    reasoningOutputTokens: Number(raw.reasoning_output_tokens || 0),
    totalTokens: Number(raw.total_tokens || 0),
  };
}

function normalizeStatus(value) {
  if (value === 'inProgress') return 'running';
  if (value === 'failed') return 'failed';
  if (value === 'interrupted') return 'interrupted';
  return 'completed';
}

function weeklyRateLimit(event) {
  const rateLimits = event?.payload?.rate_limits;
  if (!rateLimits) return null;
  const rate = [rateLimits.primary, rateLimits.secondary].find(
    (candidate) => Number(candidate?.window_minutes) === WEEKLY_WINDOW_MINUTES,
  );
  if (!rate) return null;
  const timestamp = Date.parse(event.timestamp);
  const usedPercent = Number(rate.used_percent);
  if (!Number.isFinite(timestamp) || !Number.isFinite(usedPercent)) return null;
  return {
    limitId: String(rateLimits.limit_id || ''),
    usedPercent,
    resetsAt: rate.resets_at ? Number(rate.resets_at) * 1000 : null,
    timestamp,
  };
}

function summarizeWeeklyUsage(observations) {
  const accountObservations = observations.filter(
    (observation) => observation.limitId === 'codex',
  );
  if (accountObservations.length === 0) {
    return { rateLimit: null, contributions: new Map() };
  }

  const latest = accountObservations.reduce((newest, observation) =>
    observation.timestamp > newest.timestamp ? observation : newest,
  );
  const currentWindow = accountObservations
    .filter((observation) => observation.resetsAt === latest.resetsAt)
    .sort((left, right) => left.timestamp - right.timestamp);
  let highWaterMark = 0;
  const contributions = new Map();
  for (const observation of currentWindow) {
    if (!contributions.has(observation.threadId)) {
      contributions.set(observation.threadId, 0);
    }
    const nextHighWaterMark = Math.max(
      highWaterMark,
      Math.min(100, Math.max(0, observation.usedPercent)),
    );
    const increase = nextHighWaterMark - highWaterMark;
    if (increase > 0) {
      contributions.set(
        observation.threadId,
        (contributions.get(observation.threadId) || 0) + increase,
      );
      highWaterMark = nextHighWaterMark;
    }
  }
  return {
    rateLimit: {
      usedPercent: highWaterMark,
      resetsAt: latest.resetsAt,
    },
    contributions,
  };
}

function startupCategory(text, role) {
  if (text.includes('<app-context>')) return 'Контекст приложения Codex';
  if (text.includes('<skills_instructions>')) return 'Каталог навыков';
  if (text.includes('<permissions instructions>'))
    return 'Разрешения и песочница';
  if (text.includes('<collaboration_mode>')) return 'Режим совместной работы';
  if (text.includes('<apps_instructions>')) return 'Правила приложений';
  if (text.includes('<plugins_instructions>')) return 'Правила плагинов';
  if (text.includes('<recommended_plugins>')) return 'Доступные плагины';
  if (text.includes('AGENTS.md instructions')) return 'AGENTS.md';
  if (text.includes('<environment_context>')) return 'Окружение и пути';
  if (role === 'developer') return 'Системные инструкции и инструменты';
  if (role === 'user') return 'Первый запрос пользователя';
  return 'Другой стартовый контекст';
}

function toolName(name, input = '') {
  const nested = String(input).match(
    /(?:^|[^.A-Za-z0-9_])tools\.([A-Za-z0-9_]+)\s*\(/,
  )?.[1];
  return nested || String(name || 'неизвестный инструмент');
}

function parsedCallInput(input) {
  if (input && typeof input === 'object') return input;
  try {
    return JSON.parse(String(input || ''));
  } catch {
    return null;
  }
}

function quotedField(source, field) {
  const match = String(source || '').match(
    new RegExp(`${field}\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`),
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function compactInvocation(value, limit = 240) {
  const normalized = String(value || '')
    .split(/\r?\n/, 1)[0]
    .replace(/\s+/g, ' ')
    .replace(
      /((?:^|\s)[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)=)(?:'[^']*'|"[^"]*"|\S+)/g,
      '$1•••',
    )
    .replace(
      /(--?(?:token|secret|password|api[-_]?key)\s+)(?:'[^']*'|"[^"]*"|\S+)/gi,
      '$1•••',
    )
    .trim();
  if (!normalized) return null;
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 1)}…`;
}

function commandFiles(command) {
  const firstLine = String(command || '').split(/\r?\n/, 1)[0];
  const files = new Set();
  for (const match of firstLine.matchAll(/(['"])([^'"\n]+\/[^'"\n]+)\1/g)) {
    const value = match[2];
    if (!/^https?:\/\//i.test(value)) files.add(value);
  }
  return [...files]
    .map((value) => compactInvocation(value, 180))
    .filter(Boolean)
    .map((label) => ({ kind: 'file', label }));
}

function invocationDetails(name, input) {
  const raw = String(input || '');
  const parsed = parsedCallInput(input);
  if (name === 'exec_command') {
    const command = parsed?.cmd || quotedField(raw, 'cmd');
    const label = compactInvocation(command);
    return label ? [{ kind: 'command', label }, ...commandFiles(command)] : [];
  }
  if (name === 'apply_patch') {
    const patch = (
      typeof input === 'string' ? input : String(parsed?.input || '')
    ).replace(/\\n/g, '\n');
    return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
      .map((match) => compactInvocation(match[1]))
      .filter(Boolean)
      .map((label) => ({ kind: 'file', label }));
  }
  const path = parsed?.path || parsed?.target?.path;
  const label = compactInvocation(path);
  return label ? [{ kind: 'file', label }] : [];
}

function contentLength(value) {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value))
    return value.reduce((sum, item) => sum + contentLength(item), 0);
  if (value && typeof value === 'object') {
    if (['image', 'audio'].includes(String(value.type || ''))) return 0;
    if (typeof value.text === 'string') return value.text.length;
    return Object.entries(value).reduce(
      (sum, [key, item]) =>
        sum +
        (['data', 'image_url', 'audio_url'].includes(key) &&
        typeof item === 'string' &&
        (item.startsWith('data:') || item.length > 100_000)
          ? 0
          : contentLength(item)),
      0,
    );
  }
  return 0;
}

function actionCategory(name) {
  const normalized = name.toLowerCase();
  if (normalized.includes('imagegen')) return 'Генерация изображений';
  if (
    normalized.includes('browser') ||
    normalized.includes('cua') ||
    normalized.includes('web__')
  )
    return 'Браузер и интерфейс';
  if (normalized.includes('mcp__') || normalized.includes('codex_app'))
    return 'MCP и приложения';
  if (
    normalized.includes('exec') ||
    normalized.includes('write_stdin') ||
    normalized.includes('wait') ||
    normalized.includes('apply_patch')
  )
    return 'Команды и работа с файлами';
  return 'Другие инструменты';
}

function addMetric(map, key, usage) {
  const current = map.get(key) || {
    name: key,
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  current.requests += 1;
  current.inputTokens += Number(usage.input_tokens || 0);
  current.cachedInputTokens += Number(usage.cached_input_tokens || 0);
  current.outputTokens += Number(usage.output_tokens || 0);
  current.reasoningOutputTokens += Number(usage.reasoning_output_tokens || 0);
  map.set(key, current);
}

function addActionMetric(map, category, label, usage) {
  const key = `${category}\u0000${label}`;
  const current = map.get(key) || {
    name: label,
    category,
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  current.requests += 1;
  current.inputTokens += Number(usage.input_tokens || 0);
  current.cachedInputTokens += Number(usage.cached_input_tokens || 0);
  current.outputTokens += Number(usage.output_tokens || 0);
  current.reasoningOutputTokens += Number(usage.reasoning_output_tokens || 0);
  map.set(key, current);
}

function readTailEvents(filePath, bytes = 1024 * 1024) {
  let descriptor;
  try {
    descriptor = openSync(filePath, 'r');
    const size = fstatSync(descriptor).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(descriptor, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const events = [];
    let lifecycle = null;
    for (const line of lines) {
      if (
        !line.includes('token_count') &&
        !line.includes('contextCompaction') &&
        !line.includes('"type":"compacted"') &&
        !line.includes('task_started') &&
        !line.includes('task_complete') &&
        !line.includes('turn_aborted')
      )
        continue;
      try {
        const event = JSON.parse(line);
        events.push(event);
        if (
          event?.type === 'event_msg' &&
          ['task_started', 'task_complete', 'turn_aborted'].includes(
            event?.payload?.type,
          )
        ) {
          lifecycle = event.payload.type;
        }
      } catch {
        // Последняя строка может дописываться прямо во время чтения.
      }
    }
    return { events, lifecycle, updatedAt: fstatSync(descriptor).mtimeMs };
  } catch {
    return { events: [], lifecycle: null, updatedAt: 0 };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function latestUsage(filePath) {
  let fileStat;
  try {
    fileStat = statSync(filePath);
    const cached = usageCache.get(filePath);
    if (cached?.size === fileStat.size && cached?.mtimeMs === fileStat.mtimeMs)
      return cached.value;
  } catch {
    return {
      last: null,
      total: null,
      contextWindow: null,
      weeklyObservations: [],
      compactions: 0,
      lifecycle: null,
      updatedAt: 0,
    };
  }
  const snapshot = readTailEvents(
    filePath,
    settings.overviewTailMb * 1024 * 1024,
  );
  const { events } = snapshot;
  const weeklyObservations = events
    .map(weeklyRateLimit)
    .filter((observation) => observation !== null);
  let tokenEvent = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    if (
      candidate?.type === 'event_msg' &&
      candidate?.payload?.type === 'token_count' &&
      candidate.payload.info?.last_token_usage
    ) {
      tokenEvent = candidate;
      break;
    }
  }
  if (!tokenEvent) {
    const value = {
      last: null,
      total: null,
      contextWindow: null,
      weeklyObservations,
      compactions: snapshot.events.filter(
        (event) => event?.type === 'compacted',
      ).length,
      lifecycle: snapshot.lifecycle,
      updatedAt: snapshot.updatedAt,
    };
    usageCache.set(filePath, {
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      value,
    });
    return value;
  }
  const info = tokenEvent.payload.info;
  const value = {
    last: normalizeTokens(info.last_token_usage),
    total: normalizeTokens(info.total_token_usage),
    contextWindow: info.model_context_window
      ? Number(info.model_context_window)
      : null,
    weeklyObservations,
    compactions: events.filter((event) => event?.type === 'compacted').length,
    lifecycle: snapshot.lifecycle,
    updatedAt: snapshot.updatedAt,
  };
  usageCache.set(filePath, {
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    value,
  });
  return value;
}

function currentStatus(threadId, usage) {
  const storedStatus = normalizeStatus(
    runtime.latestTurn.get(String(threadId))?.status,
  );
  const recentlyWritten = Date.now() - Number(usage.updatedAt || 0) < 15_000;
  return recentlyWritten
    ? 'running'
    : usage.lifecycle === 'turn_aborted'
      ? 'interrupted'
      : usage.lifecycle === 'task_complete'
        ? 'completed'
        : storedStatus;
}

function getSubagents(parentId) {
  return runtime.subagentsByParent.all(parentId).map((row) => {
    const usage = latestUsage(resolve(String(row.rollout_path)));
    return {
      id: String(row.id),
      parentId: String(row.parent_id),
      depth: Number(row.depth),
      nickname: row.agent_nickname ? String(row.agent_nickname) : null,
      taskPath: row.agent_path ? String(row.agent_path) : null,
      model: row.model ? String(row.model) : null,
      reasoningEffort: row.reasoning_effort
        ? String(row.reasoning_effort)
        : null,
      cwd: String(row.cwd || ''),
      status: currentStatus(row.id, usage),
      total: usage.total,
      contextWindow: usage.contextWindow,
      contextPercent:
        usage.last && usage.contextWindow
          ? (usage.last.inputTokens / usage.contextWindow) * 100
          : null,
      totalTokens: Math.max(
        Number(row.tokens_used || 0),
        usage.total?.totalTokens || 0,
      ),
    };
  });
}

function getOverview() {
  const rows = runtime.recentThreads.all(settings.recentThreadsLimit);
  const weeklyObservations = [];
  let threads = rows.map((row) => {
    const cwd = String(row.cwd || '');
    const inferredProject = row.project_id
      ? null
      : runtime.savedProjects.find(
          (project) =>
            resolve(String(project.path)) !== resolve(homedir()) &&
            (cwd === String(project.path) ||
              cwd.startsWith(`${String(project.path).replace(/\/$/, '')}/`)),
        );
    const usage = latestUsage(resolve(String(row.rollout_path)));
    weeklyObservations.push(
      ...usage.weeklyObservations.map((observation) => ({
        ...observation,
        threadId: String(row.id),
      })),
    );
    const totalTokens = Math.max(
      Number(row.tokens_used || 0),
      usage.total?.totalTokens || 0,
    );
    const contextPercent =
      usage.last && usage.contextWindow
        ? (usage.last.inputTokens / usage.contextWindow) * 100
        : null;
    const status = currentStatus(row.id, usage);
    return {
      id: String(row.id),
      title: safeTitle(row.display_title),
      updatedAt: Math.max(
        Number(row.recency_at_ms || row.updated_at_ms || 0),
        Number(usage.updatedAt || 0),
      ),
      createdAt: Number(row.created_at_ms || 0),
      totalTokens,
      model: row.model ? String(row.model) : null,
      reasoningEffort: row.reasoning_effort
        ? String(row.reasoning_effort)
        : null,
      cwd,
      projectId: row.project_id
        ? String(row.project_id)
        : inferredProject
          ? String(inferredProject.id)
          : null,
      projectName: row.project_name
        ? String(row.project_name)
        : inferredProject
          ? String(inferredProject.name)
          : null,
      projectPosition:
        row.project_position == null
          ? inferredProject
            ? Number(inferredProject.position)
            : null
          : Number(row.project_position),
      status,
      last: usage.last,
      contextWindow: usage.contextWindow,
      contextPercent,
      weeklyUsagePercent: null,
      compactions:
        detailCache.get(String(row.id))?.value.compactions ?? usage.compactions,
    };
  });
  const visibleThreadIds = new Set(threads.map((thread) => thread.id));
  const weeklyCutoff = Date.now() - WEEKLY_WINDOW_MINUTES * 60 * 1000;
  for (const subagent of runtime.recentSubagents.all(weeklyCutoff)) {
    const rootId = String(subagent.root_id);
    if (!visibleThreadIds.has(rootId)) continue;
    const usage = latestUsage(resolve(String(subagent.rollout_path)));
    weeklyObservations.push(
      ...usage.weeklyObservations.map((observation) => ({
        ...observation,
        threadId: rootId,
      })),
    );
  }
  const weekly = summarizeWeeklyUsage(weeklyObservations);
  threads = threads.map((thread) => ({
    ...thread,
    weeklyUsagePercent: weekly.contributions.has(thread.id)
      ? weekly.contributions.get(thread.id)
      : null,
  }));
  return {
    generatedAt: Date.now(),
    source: runtime.dataDir,
    rateLimit: weekly.rateLimit,
    threads,
  };
}

async function getDetail(id) {
  const row = runtime.threadById.get(id);
  if (!row) return null;
  const filePath = resolve(String(row.rollout_path));
  let fileStat;
  try {
    fileStat = statSync(filePath);
    const cached = detailCache.get(id);
    if (cached?.size === fileStat.size && cached?.mtimeMs === fileStat.mtimeMs)
      return { ...cached.value, subagents: getSubagents(id) };
  } catch {
    return null;
  }
  const points = [];
  const requests = [];
  const startupParts = new Map();
  const categoryMetrics = new Map();
  const actionMetrics = new Map();
  const toolMetrics = new Map();
  const callRecords = new Map();
  const turnIds = new Set();
  const compactionTimestamps = [];
  let compactions = 0;
  let firstUsage = null;
  let previousInput = null;
  let contextWindow = null;
  let pendingAction = { category: 'Ответы пользователю', label: 'Ответ' };
  let charsSinceUsage = 0;
  const reader = createInterface({
    input: createReadStream(filePath, {
      encoding: 'utf8',
    }),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = event?.payload || {};

    if (event?.type === 'compacted') {
      compactions += 1;
      compactionTimestamps.push(Date.parse(event.timestamp));
    }

    if (event?.type === 'response_item') {
      if (payload.type === 'message') {
        const texts = (payload.content || [])
          .map((part) => String(part.text || part.content || ''))
          .filter(Boolean);
        const chars = texts.reduce((sum, text) => sum + text.length, 0);
        charsSinceUsage += chars;
        if (!firstUsage && ['developer', 'user'].includes(payload.role)) {
          for (const text of texts) {
            const category = startupCategory(text, payload.role);
            startupParts.set(
              category,
              (startupParts.get(category) || 0) + text.length,
            );
          }
        }
        if (payload.role === 'assistant') {
          pendingAction = {
            category: 'Ответы пользователю',
            label: 'Ответ пользователю',
          };
        }
      }

      if (['custom_tool_call', 'function_call'].includes(payload.type)) {
        const rawInput = payload.input || payload.arguments;
        const name = toolName(payload.name, rawInput);
        const category = actionCategory(name);
        const callId = String(payload.call_id || payload.id || '');
        const details = invocationDetails(name, rawInput);
        if (callId) callRecords.set(callId, { name, details });
        const metric = toolMetrics.get(name) || {
          name,
          category,
          calls: 0,
          outputChars: 0,
          details: new Map(),
        };
        metric.calls += 1;
        for (const detail of details) {
          const key = `${detail.kind}\u0000${detail.label}`;
          const current = metric.details.get(key) || {
            ...detail,
            calls: 0,
            outputChars: 0,
          };
          current.calls += 1;
          metric.details.set(key, current);
        }
        toolMetrics.set(name, metric);
        pendingAction = { category, label: name };
      }

      if (
        ['custom_tool_call_output', 'function_call_output'].includes(
          payload.type,
        )
      ) {
        const outputChars = contentLength(payload.output);
        charsSinceUsage += outputChars;
        const call = callRecords.get(String(payload.call_id || ''));
        if (call && settings.analyzeToolOutputs) {
          const metric = toolMetrics.get(call.name);
          if (metric) {
            metric.outputChars += outputChars;
            for (const detail of call.details) {
              const item = metric.details.get(
                `${detail.kind}\u0000${detail.label}`,
              );
              if (item) item.outputChars += outputChars;
            }
          }
        }
      }
    }

    if (event?.type === 'token_usage_record' && payload.usage) {
      const usage = payload.usage;
      const inputTokens = Number(usage.input_tokens || 0);
      const isFirst = firstUsage === null;
      if (isFirst) firstUsage = usage;
      if (payload.turn_id) turnIds.add(String(payload.turn_id));
      const category = isFirst ? 'Стартовый пакет' : pendingAction.category;
      const label = isFirst ? 'Первый запрос модели' : pendingAction.label;
      addMetric(categoryMetrics, category, usage);
      addActionMetric(actionMetrics, category, label, usage);
      requests.push({
        timestamp: Date.parse(event.timestamp),
        category,
        label,
        inputTokens,
        cachedInputTokens: Number(usage.cached_input_tokens || 0),
        outputTokens: Number(usage.output_tokens || 0),
        reasoningOutputTokens: Number(usage.reasoning_output_tokens || 0),
        inputDelta:
          previousInput === null ? inputTokens : inputTokens - previousInput,
        newContentChars: charsSinceUsage,
      });
      previousInput = inputTokens;
      charsSinceUsage = 0;
    }

    if (event?.type === 'event_msg' && payload.type === 'token_count') {
      const info = payload.info;
      if (!info?.last_token_usage) continue;
      if (info.model_context_window)
        contextWindow = Number(info.model_context_window);
      const last = normalizeTokens(info.last_token_usage);
      points.push({
        ...last,
        timestamp: Date.parse(event.timestamp),
        contextPercent: info.model_context_window
          ? (last.inputTokens / Number(info.model_context_window)) * 100
          : null,
      });
    }
  }
  const stride = Math.max(
    1,
    Math.ceil(points.length / settings.detailPointLimit),
  );
  const startupChars = [...startupParts.values()].reduce(
    (sum, chars) => sum + chars,
    0,
  );
  const startupInput = Number(firstUsage?.input_tokens || 0);
  const startup = [...startupParts.entries()]
    .map(([name, chars]) => ({
      name,
      chars,
      estimatedTokens:
        startupChars > 0
          ? Math.round((chars / startupChars) * startupInput)
          : 0,
    }))
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens);
  const totals = requests.reduce(
    (result, request) => {
      result.modelRequests += 1;
      result.inputTokens += request.inputTokens;
      result.cachedInputTokens += request.cachedInputTokens;
      result.outputTokens += request.outputTokens;
      result.reasoningOutputTokens += request.reasoningOutputTokens;
      result.peakInputTokens = Math.max(
        result.peakInputTokens,
        request.inputTokens,
      );
      if (request.inputDelta < 0)
        result.compactionSavings += Math.abs(request.inputDelta);
      return result;
    },
    {
      modelRequests: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      peakInputTokens: 0,
      compactionSavings: 0,
      firstRequestInputTokens: startupInput,
    },
  );
  const value = {
    id,
    contextWindow,
    points: points.filter(
      (_, index) => index % stride === 0 || index === points.length - 1,
    ),
    turns: Math.max(
      turnIds.size,
      Number(runtime.turnCount.get(id)?.count || 0),
    ),
    compactions,
    compactionTimestamps,
    analysis: {
      totals,
      startup,
      startupChars,
      categories: [...categoryMetrics.values()].sort(
        (a, b) => b.inputTokens - a.inputTokens,
      ),
      actions: [...actionMetrics.values()].sort(
        (a, b) => b.inputTokens - a.inputTokens,
      ),
      tools: [...toolMetrics.values()]
        .sort((a, b) => b.outputChars - a.outputChars)
        .slice(0, 20)
        .map((tool) => ({
          ...tool,
          details: [...tool.details.values()]
            .sort((a, b) => b.outputChars - a.outputChars || b.calls - a.calls)
            .slice(0, 20),
        })),
      requests:
        requests.length <= 160
          ? requests
          : [requests[0], ...requests.slice(-159)],
    },
  };
  detailCache.set(id, {
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    value,
  });
  return { ...value, subagents: getSubagents(id) };
}

function addTotals(target, source) {
  target.requests += Number(source.requests || 0);
  target.inputTokens += Number(source.inputTokens || 0);
  target.cachedInputTokens += Number(source.cachedInputTokens || 0);
  target.outputTokens += Number(source.outputTokens || 0);
  target.reasoningOutputTokens += Number(source.reasoningOutputTokens || 0);
}

async function getGlobalAudit() {
  const overview = getOverview();
  const candidates = [...overview.threads]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 20);
  const details = (
    await Promise.all(candidates.map((thread) => getDetail(thread.id)))
  ).filter(Boolean);
  const categories = new Map();
  const tools = new Map();
  let startupTokens = 0;
  let modelRequests = 0;
  for (const detail of details) {
    startupTokens += detail.analysis.totals.firstRequestInputTokens;
    modelRequests += detail.analysis.totals.modelRequests;
    for (const category of detail.analysis.categories) {
      const total = categories.get(category.name) || {
        name: category.name,
        requests: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      };
      addTotals(total, category);
      categories.set(category.name, total);
    }
    for (const tool of detail.analysis.tools) {
      const total = tools.get(tool.name) || {
        name: tool.name,
        category: tool.category,
        calls: 0,
        outputChars: 0,
      };
      total.calls += tool.calls;
      total.outputChars += tool.outputChars;
      tools.set(tool.name, total);
    }
  }
  const compactions = overview.threads.reduce(
    (sum, thread) => sum + thread.compactions,
    0,
  );
  const restartCandidates = overview.threads.filter(
    (thread) => thread.compactions >= 2,
  );
  const latestInput = overview.threads.reduce(
    (sum, thread) => sum + Number(thread.last?.inputTokens || 0),
    0,
  );
  const latestCached = overview.threads.reduce(
    (sum, thread) => sum + Number(thread.last?.cachedInputTokens || 0),
    0,
  );
  const cachePercent = latestInput
    ? Math.round((latestCached / latestInput) * 100)
    : null;
  const averageStartupTokens = details.length
    ? Math.round(startupTokens / details.length)
    : 0;
  const totalToolOutputChars = [...tools.values()].reduce(
    (sum, tool) => sum + tool.outputChars,
    0,
  );
  const recommendations = [];
  if (restartCandidates.length > 0) {
    recommendations.push({
      severity: restartCandidates.some((thread) => thread.compactions >= 4)
        ? 'high'
        : 'medium',
      title: 'Переносить длинные задачи в новую сессию',
      evidence: `${restartCandidates.length} задач прошли не менее двух сжатий; всего обнаружено ${compactions}.`,
      action:
        'После второго сжатия попросите подготовить короткий промпт продолжения и откройте новую задачу.',
    });
  }
  if (averageStartupTokens >= 40_000) {
    recommendations.push({
      severity: averageStartupTokens >= 100_000 ? 'high' : 'medium',
      title: 'Сократить стартовый пакет',
      evidence: `Средний первый запрос в ${details.length} самых затратных задачах — ${averageStartupTokens} входных токенов.`,
      action:
        'Уберите редко нужные инструкции из AGENTS.md и отключите навыки и MCP, которые не нужны большинству задач.',
    });
  }
  if (cachePercent !== null && cachePercent < 80) {
    recommendations.push({
      severity: cachePercent < 50 ? 'high' : 'medium',
      title: 'Повысить повторное использование входа',
      evidence: `В последних запросах кэшировано ${cachePercent}% входных токенов.`,
      action:
        'Стабильные инструкции держите в начале, а меняющиеся данные добавляйте ближе к концу запроса.',
    });
  }
  if (totalToolOutputChars >= 500_000) {
    const largestTool = [...tools.values()].sort(
      (a, b) => b.outputChars - a.outputChars,
    )[0];
    recommendations.push({
      severity: totalToolOutputChars >= 2_000_000 ? 'high' : 'medium',
      title: 'Ограничить объём ответов инструментов',
      evidence: `${largestTool?.name || 'Инструменты'} вернул больше всего данных; суммарно проанализировано ${totalToolOutputChars} символов.`,
      action:
        'Сужайте поиск, ограничивайте строки вывода и запрашивайте только нужные поля перед передачей результата модели.',
    });
  }
  const crowded = overview.threads.filter(
    (thread) => (thread.contextPercent || 0) >= 60,
  );
  if (crowded.length > 0) {
    recommendations.push({
      severity: 'medium',
      title: 'Завершить задачи с заполненным контекстом',
      evidence: `${crowded.length} задач сейчас используют не менее 60% контекстного окна.`,
      action:
        'Зафиксируйте результат и перенесите продолжение до следующего большого этапа работы.',
    });
  }
  if (recommendations.length === 0) {
    recommendations.push({
      severity: 'low',
      title: 'Явных потерь не обнаружено',
      evidence:
        'Пороговые значения сжатий, стартового пакета, кэша и ответов инструментов не превышены.',
      action: 'Продолжайте наблюдать за самыми затратными задачами.',
    });
  }
  return {
    generatedAt: Date.now(),
    scope: {
      threads: overview.threads.length,
      detailedThreads: details.length,
      modelRequests,
    },
    metrics: {
      compactions,
      restartCandidates: restartCandidates.length,
      averageStartupTokens,
      cachePercent,
      totalToolOutputChars,
    },
    recommendations,
    categories: [...categories.values()].sort(
      (a, b) => b.inputTokens - a.inputTokens,
    ),
    tools: [...tools.values()]
      .sort((a, b) => b.outputChars - a.outputChars)
      .slice(0, 10),
  };
}

let globalAuditPromise = null;

function getGlobalAuditShared() {
  if (!globalAuditPromise) {
    globalAuditPromise = getGlobalAudit().finally(() => {
      globalAuditPromise = null;
    });
  }
  return globalAuditPromise;
}

function findCodexBinary() {
  const candidates = [
    process.env.CODEX_BINARY,
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    ...String(process.env.PATH || '')
      .split(':')
      .filter(Boolean)
      .map((directory) => join(directory, 'codex')),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function runCodexAudit() {
  if (auditState.status === 'running' || auditState.status === 'preparing')
    return auditState;
  auditState = {
    ...auditState,
    status: 'preparing',
    startedAt: Date.now(),
    completedAt: null,
    error: null,
  };
  void (async () => {
    const runId = auditState.startedAt;
    const pendingReportPath = join(AUDIT_DIR, `usage-report-${runId}.json`);
    const pendingResultPath = join(AUDIT_DIR, `result-${runId}.md`);
    try {
      const codexBinary = findCodexBinary();
      if (!codexBinary) throw new Error('Не найден установленный Codex CLI');
      const report = await getGlobalAuditShared();
      mkdirSync(join(AUDIT_DIR, 'codex-usage-audit'), { recursive: true });
      writeFileSync(
        pendingReportPath,
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8',
      );
      writeFileSync(
        AUDIT_SKILL_PATH,
        readFileSync(BUNDLED_AUDIT_SKILL, 'utf8'),
        'utf8',
      );
      auditState = { ...auditState, status: 'running', report };
      const prompt = [
        `Используй навык из ${AUDIT_SKILL_PATH}.`,
        `Проанализируй агрегированный отчёт ${pendingReportPath}.`,
        'Не читай исходные журналы Codex и файлы пользовательских проектов.',
        'Верни практические рекомендации на русском языке.',
      ].join(' ');
      const child = spawn(
        codexBinary,
        [
          '--ask-for-approval',
          'never',
          'exec',
          '-',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          '--cd',
          AUDIT_DIR,
          '--output-last-message',
          pendingResultPath,
        ],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
      let errorOutput = '';
      child.stderr.on('data', (chunk) => {
        errorOutput = `${errorOutput}${chunk}`.slice(-8000);
      });
      child.stdin.end(prompt);
      child.on('error', (error) => {
        removeFile(pendingReportPath);
        removeFile(pendingResultPath);
        auditState = {
          ...auditState,
          status: 'failed',
          completedAt: Date.now(),
          error: error.message,
        };
      });
      child.on('close', (code) => {
        if (auditState.status === 'failed') return;
        if (code !== 0) {
          removeFile(pendingReportPath);
          removeFile(pendingResultPath);
          auditState = {
            ...auditState,
            status: 'failed',
            completedAt: Date.now(),
            error: errorOutput.trim() || `Codex завершился с кодом ${code}`,
          };
          return;
        }
        const result = readFileSync(pendingResultPath, 'utf8').trim();
        renameSync(pendingReportPath, AUDIT_REPORT_PATH);
        renameSync(pendingResultPath, AUDIT_RESULT_PATH);
        auditState = {
          ...auditState,
          status: 'completed',
          completedAt: Date.now(),
          result,
          report,
          error: null,
        };
      });
    } catch (error) {
      removeFile(pendingReportPath);
      removeFile(pendingResultPath);
      auditState = {
        ...auditState,
        status: 'failed',
        completedAt: Date.now(),
        error:
          error instanceof Error ? error.message : 'Не удалось запустить аудит',
      };
    }
  })();
  return auditState;
}

function isAllowedOrigin(origin) {
  return (
    !origin ||
    origin === 'null' ||
    /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)
  );
}

export function createDataServer() {
  return createServer(async (request, response) => {
    if (!isAllowedOrigin(request.headers.origin))
      return sendJson(response, 403, { error: 'Origin is not allowed' });
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      response.end();
      return;
    }
    const url = new URL(
      request.url || '/',
      `http://${request.headers.host || '127.0.0.1'}`,
    );
    if (url.pathname === '/api/health')
      return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/settings' && request.method === 'GET')
      return sendJson(response, 200, publicSettings());
    if (url.pathname === '/api/settings' && request.method === 'PUT') {
      try {
        return sendJson(response, 200, applySettings(await readJson(request)));
      } catch (error) {
        return sendJson(response, 400, {
          error:
            error instanceof Error
              ? error.message
              : 'Не удалось применить настройки',
        });
      }
    }
    if (url.pathname === '/api/overview')
      return sendJson(response, 200, getOverview());
    if (url.pathname === '/api/audit' && request.method === 'GET')
      return sendJson(response, 200, await getGlobalAuditShared());
    if (url.pathname === '/api/codex-audit' && request.method === 'GET')
      return sendJson(response, 200, auditState);
    if (url.pathname === '/api/codex-audit' && request.method === 'POST')
      return sendJson(response, 202, runCodexAudit());
    const match = url.pathname.match(/^\/api\/threads\/([0-9a-z-]+)$/i);
    if (match) {
      const detail = await getDetail(match[1]);
      return detail
        ? sendJson(response, 200, detail)
        : sendJson(response, 404, { error: 'Thread not found' });
    }
    return sendJson(response, 404, { error: 'Not found' });
  });
}

export function startDataServer(port = PORT) {
  const server = createDataServer();
  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      console.log(`Codex usage data: http://127.0.0.1:${port}`);
      resolveServer(server);
    });
  });
}

const isDirectRun =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  await startDataServer();
}
