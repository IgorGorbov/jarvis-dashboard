#!/usr/bin/env node
import {createServer} from 'node:http';
import {readFile, readdir, stat, open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {agentError, agentText, normalizeOutcome, splitRunDir} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(
  process.argv[2] ?? path.join(HERE, '..', 'agents', 'artifacts', 'jarvis'),
);
const JOURNAL = path.join(ROOT, 'events.jsonl');
const PORT = Number(process.env.PORT ?? 4100);
const AGENT = process.env.JARVIS_A2A ?? 'http://localhost:4000';
const POLL_MS = 500;
/** Сколько журнала отдаём при подключении. Замер: прогон добавляет ~6 строк. */
const TAIL_BYTES = 256 * 1024;

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
  let primed = false;
  let dropFirstLine = false;
  let alive = true;
  req.on('close', () => {
    alive = false;
  });

  const pump = async () => {
    while (alive) {
      try {
        const info = await stat(JOURNAL).catch(() => undefined);
        if (info) {
          if (!primed) {
            primed = true;
            // Журнал общий на все прогоны и не подрезается. При подключении
            // отдаём только хвост: полный след давнего прогона всё равно лежит
            // в его папке, в `events.json`.
            if (info.size > TAIL_BYTES) {
              offset = info.size - TAIL_BYTES;
              dropFirstLine = true;
            }
          }
          // Файл усох — журнал подрезали или переписали, читаем заново с начала.
          if (info.size < offset) {
            offset = 0;
            dropFirstLine = false;
          }
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
              let chunk = buf.subarray(0, nl);
              if (dropFirstLine) {
                dropFirstLine = false;
                // Начали с середины файла, значит первая строка обрезана слева.
                const first = chunk.indexOf(0x0a);
                chunk = first >= 0 ? chunk.subarray(first + 1) : Buffer.alloc(0);
              }
              for (const line of chunk.toString('utf8').split('\n')) {
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

/** Метка задачи без тикета: под ней Jarvis паркует прямые вызовы. */
const NO_TASK = 'no-task';

const sourceOf = (issueId) =>
  issueId && issueId !== NO_TASK
    ? {type: 'youtrack', issueId: String(issueId)}
    : {type: 'direct'};

/**
 * Ответа не ждём: `execute` в Jarvis синхронно дожидается всего прогона, то есть
 * успешный ответ пришёл бы через два часа. Ждём три секунды — за них успевает
 * приехать только отказ («занят», «нет вопроса»), и его показываем.
 */
const callAgent = async (res, metadata, text) => {
  // Проверено на живом агенте: без заголовка версии запрос читается как 0.3 и
  // отбивается, а метод в 1.0 называется `SendMessage`, не `message/send`.
  const envelope = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'SendMessage',
    params: {
      message: {
        messageId: crypto.randomUUID(),
        role: 'ROLE_USER',
        parts: [{content: {$case: 'text', value: text}}],
        metadata,
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const upstream = await fetch(`${AGENT}/a2a/jsonrpc`, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'a2a-version': '1.0'},
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    const payload = await upstream.json().catch(() => undefined);
    // Без этого неверный конверт выглядел как успешная отправка.
    const failed = agentError(payload);
    if (failed) {
      return sendJson(res, {sent: false, note: `агент не принял запрос: ${failed}`});
    }
    // Отмена отвечает быстро и по делу («работа сохранится в stash»), поэтому
    // показываем текст агента и при успехе, а не только отказ.
    const said = agentText(payload);
    sendJson(res, {sent: !said?.includes('NO_ACTION'), note: said});
  } catch (error) {
    // Обрыв по нашему таймауту — норма: запрос принят, работа идёт.
    if (error?.name === 'AbortError') {
      sendJson(res, {sent: true});
    } else {
      // Показываем адрес: чаще всего агент просто не запущен.
      sendJson(res, {sent: false, note: `агент недоступен на ${AGENT}`});
    }
  } finally {
    clearTimeout(timer);
  }
};

const startTask = (req, res) =>
  readBody(req).then((body) =>
    callAgent(
      res,
      {
        source: sourceOf(body.issueId),
        understandingConfirmed: Boolean(body.confirmed),
        ...(body.model ? {model: body.model} : {}),
      },
      String(body.text ?? '').trim(),
    ),
  );

/**
 * Ответ на вопросы анализа. Прогон припаркован под меткой задачи, поэтому ключ —
 * `taskRef`, а не `runTag`, и он же определяет источник.
 */
/** Отмена: активный прогон гасится, ждущий снимается с ожидания. */
const cancelTask = (req, res) =>
  readBody(req).then((body) =>
    callAgent(res, {source: sourceOf(body.taskRef), cancel: true}, ''),
  );

const answerTask = (req, res) =>
  readBody(req).then((body) => {
    const answer = String(body.answer ?? '').trim();
    if (!answer) {
      return sendJson(res, {sent: false, note: 'ответ пустой'}, 400);
    }
    return callAgent(res, {source: sourceOf(body.taskRef), answer}, '');
  });

const serve = async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/api/start') {
    return startTask(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/answer') {
    return answerTask(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/cancel') {
    return cancelTask(req, res);
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
