#!/usr/bin/env node
import {createServer} from 'node:http';
import {readFile, readdir, stat, open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(
  process.argv[2] ?? path.join(HERE, '..', 'agents', 'artifacts', 'jarvis'),
);
const JOURNAL = path.join(ROOT, 'events.jsonl');
const PORT = Number(process.env.PORT ?? 4100);
const AGENT = process.env.JARVIS_A2A ?? 'http://localhost:4000';
const POLL_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
};

const sendJson = (res, body, code = 200) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

/** Строки журнала целиком: нужны для списка прогонов и для отказов без папки. */
const readJournal = async () => {
  let raw;
  try {
    raw = await readFile(JOURNAL, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Обрыв процесса на дозаписи оставляет половину строки. Пропускаем её,
      // а не роняем весь разбор: остальные строки к ней отношения не имеют.
    }
  }
  return rows;
};

/**
 * Имя папки — `<runTag>-<taskRef>`, а в taskRef дефисы есть (FM-6324).
 * Поэтому делим по первому дефису, а не по последнему.
 */
const splitRunDir = (name) => {
  const at = name.indexOf('-');
  return at < 0 ? undefined : {runTag: name.slice(0, at), taskRef: name.slice(at + 1)};
};

/**
 * Форматов исхода в артефактах три, и все живые: `result.json` с размеченным
 * `kind`, `meta.ended` нынешних прогонов и `prOpened`/`meta.outcome` старых.
 */
const normalizeOutcome = (result, meta) => {
  if (result?.kind) {
    return {kind: result.kind, prUrl: result.prUrl, reason: result.reason};
  }
  if (result?.prOpened || result?.prUrl) {
    return {kind: 'pr', prUrl: result.prUrl};
  }
  const ended = meta?.ended;
  if (ended?.kind === 'outcome' && ended.outcome?.kind) {
    const {kind, prUrl, reason} = ended.outcome;
    return {kind, prUrl, reason};
  }
  // `asked` — прогон встал на вопросах к человеку.
  if (ended?.kind) return {kind: ended.kind, questions: ended.questions?.length};
  if (meta?.outcome?.kind) return {kind: meta.outcome.kind};
  // Прогоны до 13 августа писали исход прозой. Разбирать её не будем, но ссылку
  // на PR вытащим — по ней история чем-то полезна.
  if (typeof meta?.outcome === 'string') {
    const link = meta.outcome.match(/https:\/\/github\.com\S+/);
    return link ? {kind: 'pr', prUrl: link[0]} : {kind: 'проза', reason: meta.outcome};
  }
  return undefined;
};

const listRuns = async () => {
  const byTag = new Map();

  let entries = [];
  try {
    entries = await readdir(ROOT, {withFileTypes: true});
  } catch {
    return {root: ROOT, runs: [], error: 'каталог артефактов не читается'};
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'pending') continue;
    const split = splitRunDir(entry.name);
    if (!split) continue;
    const dir = path.join(ROOT, entry.name);
    const [meta, resume, result] = await Promise.all([
      readJson(path.join(dir, 'meta.json')),
      readJson(path.join(dir, 'meta.resume.json')),
      readJson(path.join(dir, 'result.json')),
    ]);
    byTag.set(split.runTag, {
      ...split,
      dir: entry.name,
      model: meta?.model,
      startedAt: meta?.startedAt,
      finishedAt: resume?.finishedAt ?? meta?.finishedAt,
      resumed: Boolean(resume),
      // Продолжение после ответа человека — последнее слово о судьбе прогона,
      // но если в нём исхода нет, берём его из первой сессии.
      outcome: normalizeOutcome(result, resume) ?? normalizeOutcome(result, meta),
    });
  }

  // Отказ на приёме папки не создаёт — такой прогон виден только по журналу.
  for (const row of await readJournal()) {
    const tag = row.runTag;
    if (!tag) continue;
    const known = byTag.get(tag);
    if (known) {
      if (!known.taskRef && row.taskRef) known.taskRef = row.taskRef;
      known.lastAt = row.at;
      continue;
    }
    byTag.set(tag, {
      runTag: tag,
      taskRef: row.taskRef ?? row.replyKey ?? 'без задачи',
      journalOnly: true,
      startedAt: row.at,
      lastAt: row.at,
    });
  }

  const runs = [...byTag.values()].sort((a, b) =>
    String(b.lastAt ?? b.startedAt ?? '').localeCompare(
      String(a.lastAt ?? a.startedAt ?? ''),
    ),
  );
  return {root: ROOT, runs};
};

const RUN_ARTIFACTS = /^(analysis|claims|result|meta|meta\.resume|verify|checks\.\d+|review\.\d+|code\.\d+)\.json$/;

const runDetail = async (tag) => {
  const {runs} = await listRuns();
  const run = runs.find((r) => r.runTag === tag);
  if (!run) return undefined;
  if (!run.dir) return {run, files: [], json: {}};

  const dir = path.join(ROOT, run.dir);
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return {run, files: [], json: {}};
  }
  const json = {};
  for (const name of names.filter((n) => RUN_ARTIFACTS.test(n))) {
    json[name] = await readJson(path.join(dir, name));
  }
  return {run, files: names.sort(), json};
};

const SAFE_NAME = /^[\w.-]+$/;

const streamEvents = (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  let offset = 0;
  let alive = true;
  req.on('close', () => {
    alive = false;
  });

  const pump = async () => {
    while (alive) {
      try {
        const info = await stat(JOURNAL).catch(() => undefined);
        if (info) {
          // Файл усох — журнал подрезали или переписали, читаем заново с начала.
          if (info.size < offset) offset = 0;
          if (info.size > offset) {
            const handle = await open(JOURNAL, 'r');
            const buf = Buffer.alloc(info.size - offset);
            await handle.read(buf, 0, buf.length, offset);
            await handle.close();
            // Режем по последнему переводу строки в байтах: недописанная строка
            // ждёт следующего опроса, а офсет остаётся точным.
            const nl = buf.lastIndexOf(0x0a);
            if (nl >= 0) {
              offset += nl + 1;
              for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) {
                if (line.trim()) res.write(`data: ${line}\n\n`);
              }
            }
          }
        }
      } catch {
        // Читающий не должен падать из-за писателя: пробуем на следующем круге.
      }
      await sleep(POLL_MS);
    }
  };
  pump();
};

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
};

/**
 * Ответа не ждём: `execute` в Jarvis синхронно дожидается всего прогона, то есть
 * ответ пришёл бы через два часа. Отправляем и переключаемся на журнал.
 */
const startTask = async (req, res) => {
  const body = await readBody(req);
  const text = String(body.text ?? '').trim();
  const source =
    body.issueId ? {type: 'youtrack', issueId: String(body.issueId)} : {type: 'direct'};
  const message = {
    messageId: crypto.randomUUID(),
    role: 'ROLE_USER',
    parts: [{content: {$case: 'text', value: text}}],
    metadata: {
      source,
      understandingConfirmed: Boolean(body.confirmed),
      ...(body.model ? {model: body.model} : {}),
    },
  };
  const envelope = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'message/send',
    params: {message},
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const upstream = await fetch(`${AGENT}/a2a/jsonrpc`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    sendJson(res, {sent: true, status: upstream.status});
  } catch (error) {
    // Обрыв по нашему же таймауту — норма: задача принята, прогон идёт.
    const aborted = error?.name === 'AbortError';
    sendJson(res, {
      sent: aborted,
      note: aborted ? 'ответ не ждём — смотрите журнал' : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
};

const serve = async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/api/start') {
    return startTask(req, res);
  }

  switch (url.pathname) {
    case '/':
    case '/index.html': {
      const page = await readFile(path.join(HERE, 'index.html'));
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      return res.end(page);
    }
    case '/api/state': {
      const snapshot = await readJson(path.join(ROOT, 'state.json'));
      return sendJson(res, snapshot ?? {phase: 'unknown'});
    }
    case '/api/runs':
      return sendJson(res, await listRuns());
    case '/api/run': {
      const tag = url.searchParams.get('tag') ?? '';
      const detail = await runDetail(tag);
      return detail
        ? sendJson(res, detail)
        : sendJson(res, {error: 'прогон не найден'}, 404);
    }
    case '/api/file': {
      const tag = url.searchParams.get('tag') ?? '';
      const name = url.searchParams.get('name') ?? '';
      if (!SAFE_NAME.test(name)) {
        return sendJson(res, {error: 'недопустимое имя файла'}, 400);
      }
      const detail = await runDetail(tag);
      if (!detail?.run.dir) return sendJson(res, {error: 'нет папки'}, 404);
      try {
        const body = await readFile(path.join(ROOT, detail.run.dir, name));
        res.writeHead(200, {'content-type': 'text/plain; charset=utf-8'});
        return res.end(body);
      } catch {
        return sendJson(res, {error: 'файл не читается'}, 404);
      }
    }
    case '/api/events':
      return streamEvents(req, res);
    default:
      return sendJson(res, {error: 'нет такой ручки'}, 404);
  }
};

createServer((req, res) => {
  serve(req, res).catch((error) => {
    sendJson(res, {error: String(error)}, 500);
  });
}).listen(PORT, () => {
  process.stdout.write(`панель: http://localhost:${PORT}\n`);
  process.stdout.write(`артефакты: ${ROOT}\n`);
  process.stdout.write(`агент: ${AGENT}\n`);
});
