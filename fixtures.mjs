/**
 * Поддельный каталог артефактов: состояния, которых на живых прогонах не было.
 *
 * Три пути панели написаны и ни разу не отрисовывались — упавший прогон, диф
 * оборванной работы и ожидание ответа в треде Mattermost. Ждать, пока они
 * случатся сами, можно месяцами, а сломаться они успеют молча. Здесь они
 * собираются за секунду.
 *
 * Это не замена живым прогонам: подделка проверяет отрисовку, а не поведение
 * агента. Ветки самого конвейера закрываются задачами (`yarn coverage`) и
 * модульными тестами на чистые функции решений в репозитории агентов.
 *
 *   node fixtures.mjs [куда]     по умолчанию — ./fixtures/artifacts
 *   node dash.mjs ./fixtures/artifacts
 */
import {mkdir, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] ?? path.join(HERE, 'fixtures', 'artifacts'));

// Время фиксированное: подделка должна давать один и тот же результат при
// каждом запуске, иначе её нельзя сравнивать со вчерашней.
const DAY = '2026-08-30';
const at = (hhmmss) => `${DAY}T${hhmmss}.000Z`;

const journal = [];
const runs = [];

/** Прогон: строки ленты и файл прогона рядом, чтобы не разъезжались. */
const run = (runTag, taskRef, {events, rows, files = {}}) => {
  journal.push(...events.map((e) => ({runTag, taskRef, ...e})));
  runs.push({dir: `${runTag}-${taskRef}`, rows, files});
};

// ── упал агент ───────────────────────────────────────────────────────────────
// Вид `failed` панель красит красным и показывает причину. Ни одного такого
// прогона не было: агент за всё время ни разу не свалился.
run('fa11ed00', 'FM-0001', {
  events: [
    {at: at('09:00:00'), replyKey: 'FM-0001', stage: 'incoming', decision: 'accepted', go: 'no-task', reason: 'FM-0001'},
    {at: at('09:00:01'), stage: 'analyze', start: true, turnLimit: 120},
    {at: at('09:02:00'), stage: 'analyze', decision: 'analyze-failed', go: 'stop', cause: 'agent-error', reason: 'SDK вернул ошибку: connection reset by peer'},
    {at: at('09:02:00'), stage: 'analyze', ms: 119000},
  ],
  rows: [
    {at: at('09:00:00'), kind: 'session', runTag: 'fa11ed00', taskRef: 'FM-0001', model: 'openrouter/claude-sonnet-5'},
    {at: at('09:02:00'), kind: 'run-end', ended: {kind: 'failed', reason: 'SDK вернул ошибку: connection reset by peer'}},
  ],
});

// ── оборван после правок ─────────────────────────────────────────────────────
// Ветку при обрыве удаляют, поэтому патч — единственная копия работы. Вкладка
// «Диф» живёт только ради него и до сих пор ни разу не открывалась.
run('ab04ded0', 'FM-0002', {
  events: [
    {at: at('10:00:00'), replyKey: 'FM-0002', stage: 'incoming', decision: 'accepted', go: 'no-task', reason: 'FM-0002'},
    {at: at('10:00:01'), stage: 'analyze', start: true, turnLimit: 120},
    {at: at('10:01:00'), stage: 'analyze', decision: 'plan-ready', go: 'proceed'},
    {at: at('10:01:00'), stage: 'analyze', ms: 59000},
    {at: at('10:01:01'), stage: 'prepare', start: true},
    {at: at('10:01:20'), stage: 'prepare', ms: 19000},
    {at: at('10:01:20'), stage: 'implement', start: true, turnLimit: 120, attempt: 1},
    {at: at('10:05:00'), runTag: 'cance1111', replyKey: 'FM-0002', stage: 'incoming', decision: 'cancel-requested', go: 'no-task', reason: 'запрошена отмена FM-0002', target: 'ab04ded0'},
    {at: at('10:05:02'), stage: 'implement', decision: 'implement-aborted', go: 'stop', cause: 'cancelled', attempt: 1, reason: 'реализация: прогон отменён'},
    {at: at('10:05:02'), stage: 'implement', ms: 222000, attempt: 1},
  ],
  rows: [
    {at: at('10:00:00'), kind: 'session', runTag: 'ab04ded0', taskRef: 'FM-0002', model: 'openrouter/claude-opus-5'},
    {at: at('10:01:00'), kind: 'analysis', summary: 'Поддельный прогон: проверяем показ дифа оборванной работы.', plan: ['правка одного файла'], unclear: [], checked: [], questions: []},
    {at: at('10:05:02'), kind: 'run-end', ended: {kind: 'cancelled', reason: 'остановлен по запросу человека, правки сохранены патчем'}},
  ],
  files: {
    'diff.aborted.patch': [
      'diff --git a/shared/lib/demo/src/index.ts b/shared/lib/demo/src/index.ts',
      'index 1111111..2222222 100644',
      '--- a/shared/lib/demo/src/index.ts',
      '+++ b/shared/lib/demo/src/index.ts',
      '@@ -1,3 +1,4 @@',
      ' export const demo = () => {',
      "+  // правка, пережившая обрыв: ветки уже нет, а патч есть",
      '   return 1;',
      ' };',
      '',
    ].join('\n'),
  },
});

// ── проверки не смогли отработать ────────────────────────────────────────────
// `ran` пустой, и объяснение только в `blocked`: без него карточка проверок
// пустая и молчит.
run('b10cked0', 'FM-0003', {
  events: [
    {at: at('11:00:00'), replyKey: 'FM-0003', stage: 'incoming', decision: 'accepted', go: 'no-task', reason: 'FM-0003'},
    {at: at('11:00:01'), stage: 'analyze', start: true, turnLimit: 120},
    {at: at('11:00:30'), stage: 'analyze', decision: 'plan-ready', go: 'proceed'},
    {at: at('11:00:30'), stage: 'analyze', ms: 29000},
    {at: at('11:00:31'), stage: 'prepare', start: true},
    {at: at('11:00:50'), stage: 'prepare', decision: 'install-failed', go: 'stop', reason: 'не смог поставить зависимости (pnpm): ERR_PNPM_NO_MATCHING_VERSION'},
    {at: at('11:00:50'), stage: 'prepare', ms: 19000},
  ],
  rows: [
    {at: at('11:00:00'), kind: 'session', runTag: 'b10cked0', taskRef: 'FM-0003', model: 'openrouter/claude-sonnet-5'},
    {at: at('11:00:50'), kind: 'run-end', ended: {kind: 'outcome', outcome: {kind: 'stopped', reason: 'не смог поставить зависимости (pnpm): ERR_PNPM_NO_MATCHING_VERSION'}}},
  ],
});

// ── упор в срок прогона ──────────────────────────────────────────────────────
run('cei1in60', 'FM-0004', {
  events: [
    {at: at('12:00:00'), replyKey: 'FM-0004', stage: 'incoming', decision: 'accepted', go: 'no-task', reason: 'FM-0004'},
    {at: at('12:00:01'), stage: 'analyze', start: true, turnLimit: 120},
    {at: at('12:30:00'), stage: 'analyze', decision: 'plan-ready', go: 'proceed'},
    {at: at('12:30:00'), stage: 'analyze', ms: 1799000},
    {at: at('12:30:01'), stage: 'implement', start: true, turnLimit: 120, attempt: 1},
    {at: at('14:00:02'), stage: 'implement', decision: 'implement-aborted', go: 'stop', cause: 'run-ceiling', attempt: 1, reason: 'реализация: истёк срок прогона'},
    {at: at('14:00:02'), stage: 'implement', ms: 5401000, attempt: 1},
  ],
  rows: [
    {at: at('12:00:00'), kind: 'session', runTag: 'cei1in60', taskRef: 'FM-0004', model: 'openrouter/claude-sonnet-5'},
    {at: at('14:00:02'), kind: 'run-end', ended: {kind: 'failed', reason: 'истёк срок прогона: два часа с момента взятия машины'}},
  ],
});

// ── ждёт ответа в треде Mattermost ───────────────────────────────────────────
// Единственное состояние снимка, которого панель не видела: у такого ожидания
// поля ответа быть не должно — ответ уходит в тред.
const state = {
  phase: 'waiting',
  waiting: [
    {taskRef: 'FM-0005', runTag: 'threaded', thread: 'mattermost:9f2c1e'},
    {taskRef: 'FM-0006', runTag: 'p1ainw8t'},
  ],
};
run('threaded', 'FM-0005', {
  events: [
    {at: at('13:00:00'), replyKey: 'FM-0005', stage: 'incoming', decision: 'accepted', go: 'no-task', reason: 'FM-0005'},
    {at: at('13:00:01'), stage: 'analyze', start: true, turnLimit: 120},
    {at: at('13:05:00'), stage: 'analyze', decision: 'has-questions', go: 'ask', reason: 'нужны ответы на 2 вопроса'},
  ],
  rows: [
    {at: at('13:00:00'), kind: 'session', runTag: 'threaded', taskRef: 'FM-0005', model: 'openrouter/claude-sonnet-5'},
    {at: at('13:05:00'), kind: 'analysis', summary: 'Ожидание ответа в треде.', plan: [], unclear: [], checked: [], questions: ['Какой код экрана использовать?', 'Нужна ли миграция старых значений?']},
    {at: at('13:05:00'), kind: 'session-end', ended: {kind: 'asked', questions: ['Какой код экрана использовать?', 'Нужна ли миграция старых значений?'], held: 'mattermost:9f2c1e'}},
  ],
});
run('p1ainw8t', 'FM-0006', {
  events: [
    {at: at('13:10:00'), replyKey: 'FM-0006', stage: 'incoming', decision: 'accepted', go: 'no-task', reason: 'FM-0006'},
    {at: at('13:10:01'), stage: 'analyze', start: true, turnLimit: 120},
    {at: at('13:12:00'), stage: 'analyze', decision: 'has-questions', go: 'ask', reason: 'нужен ответ на 1 вопрос'},
  ],
  rows: [
    {at: at('13:10:00'), kind: 'session', runTag: 'p1ainw8t', taskRef: 'FM-0006', model: 'openrouter/claude-sonnet-5'},
    {at: at('13:12:00'), kind: 'analysis', summary: 'Ожидание ответа из панели.', plan: [], unclear: [], checked: [], questions: ['Округлять вверх или вниз?']},
    {at: at('13:12:00'), kind: 'session-end', ended: {kind: 'asked', questions: ['Округлять вверх или вниз?']}},
  ],
});

await rm(ROOT, {recursive: true, force: true});
await mkdir(ROOT, {recursive: true});

journal.sort((a, b) => a.at.localeCompare(b.at));
await writeFile(
  path.join(ROOT, 'events.jsonl'),
  journal.map((e) => JSON.stringify(e)).join('\n') + '\n',
);
await writeFile(path.join(ROOT, 'state.json'), JSON.stringify(state, null, 2) + '\n');

for (const {dir, rows, files} of runs) {
  const at_ = path.join(ROOT, dir);
  await mkdir(at_, {recursive: true});
  await writeFile(path.join(at_, 'run.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(at_, name), body);
  }
}

process.stdout.write(
  `подделка собрана: ${ROOT}\n` +
    `  прогонов: ${runs.length}, событий: ${journal.length}\n` +
    `  состояния: failed, оборванный с патчем, install-failed, run-ceiling, ожидание в треде\n` +
    `  посмотреть: node dash.mjs ${path.relative(HERE, ROOT)}\n`,
);
