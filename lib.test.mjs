import {test} from 'node:test';
import assert from 'node:assert/strict';
import {agentError, agentText, normalizeOutcome, parseRun, runSummary, splitRunDir} from './lib.mjs';

test('splitRunDir делит по первому дефису, а не по последнему', () => {
  assert.deepEqual(splitRunDir('aa940ed9-FM-6324'), {
    runTag: 'aa940ed9',
    taskRef: 'FM-6324',
  });
  // Метка прогона не всегда шестнадцатеричная: бывает `smoke`, `cg`, `no-task`.
  assert.deepEqual(splitRunDir('smoke-NO-TASK'), {
    runTag: 'smoke',
    taskRef: 'NO-TASK',
  });
  assert.equal(splitRunDir('безДефиса'), undefined);
});

test('исход: обёртка вокруг исхода конвейера', () => {
  assert.deepEqual(
    normalizeOutcome({kind: 'outcome', outcome: {kind: 'pr', prUrl: 'https://x/pull/7', branch: 'b'}}),
    {kind: 'pr', prUrl: 'https://x/pull/7', branch: 'b', reason: undefined},
  );
  // У исхода `pr` текст лежит в `summary`, у остальных — в `reason`.
  assert.equal(
    normalizeOutcome({kind: 'outcome', outcome: {kind: 'pr', summary: 'сделано'}}).reason,
    'сделано',
  );
});

test('исход: три вида, которые не обёрнуты', () => {
  // Без этой ветки отменённый прогон был бы неотличим от упавшего, а панель
  // красит их по-разному: отмена — пауза по воле человека, падение — поломка.
  assert.deepEqual(normalizeOutcome({kind: 'cancelled', reason: 'человек'}), {
    kind: 'cancelled',
    reason: 'человек',
    questions: undefined,
  });
  assert.equal(normalizeOutcome({kind: 'failed', reason: 'упал'}).kind, 'failed');
  assert.equal(normalizeOutcome({kind: 'asked', questions: ['a', 'b']}).questions, 2);
});

test('исход: нечего разбирать', () => {
  assert.equal(normalizeOutcome(undefined), undefined);
  assert.equal(normalizeOutcome({}), undefined);
  // Обёртка без исхода внутри — не исход.
  assert.equal(normalizeOutcome({kind: 'outcome'}), undefined);
});

test('файл прогона: недописанная строка не роняет разбор', () => {
  const text = [
    '{"kind":"session","model":"sonnet","at":"2026-08-27T21:14:18.895Z"}',
    '{"kind":"checks","attempt":1,"green":true}',
    '{"kind":"session-end","at":"2026-08-27T21:16:24.120Z","ended":{"kind":"outcome","outcome":{"kind":"pr"',
  ].join('\n');
  const rows = parseRun(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].kind, 'checks');
});

test('сводка прогона: несколько сессий — работа и ожидание не складываются', () => {
  const rows = parseRun([
    '{"kind":"session","at":"09:18","model":"sonnet"}',
    // Связь с родителем лежит в строке разбора, а не сессии.
    '{"kind":"analysis","at":"09:20","continues":"abc"}',
    '{"kind":"session-end","at":"10:50","ended":{"kind":"asked","questions":["q"]}}',
    '{"kind":"session","at":"12:06"}',
    '{"kind":"session-end","at":"12:09","ended":{"kind":"outcome","outcome":{"kind":"pr"}}}',
  ].join('\n'));
  assert.deepEqual(runSummary(rows), {
    model: 'sonnet',
    continues: 'abc',
    // Начало берётся у первой сессии, конец — у последней: между ними час
    // ожидания человека, и он в длительность не входит.
    startedAt: '09:18',
    finishedAt: '12:09',
    resumed: true,
    outcome: {kind: 'pr', prUrl: undefined, branch: undefined, reason: undefined},
  });
});

test('сводка прогона: идущий прогон ещё без исхода', () => {
  const rows = parseRun('{"kind":"session","at":"09:18","model":"opus"}');
  const summary = runSummary(rows);
  assert.equal(summary.finishedAt, undefined);
  assert.equal(summary.outcome, undefined);
  assert.equal(summary.resumed, false);
});

test('текст агента: формы, снятые с живого агента', () => {
  // JSON-RPC: сообщение внутри result, текст части — в `text`.
  assert.equal(
    agentText({
      result: {
        message: {parts: [{text: 'NO_ACTION: по FM-6301 нечего отменять.', mediaType: 'text/plain'}]},
      },
    }),
    'NO_ACTION: по FM-6301 нечего отменять.',
  );
  // REST: то же сообщение без обёртки result.
  assert.equal(
    agentText({message: {parts: [{text: 'Отменяю FM-2 — работа сохранится в stash.'}]}}),
    'Отменяю FM-2 — работа сохранится в stash.',
  );
  // Запас на форму запроса: content.$case.
  assert.equal(agentText({result: {parts: [{content: {value: 'PR открыт'}}]}}), 'PR открыт');
  assert.equal(agentText(undefined), undefined);
  assert.equal(agentText({result: {message: {parts: []}}}), undefined);
});

test('ошибка протокола не выглядит успешной отправкой', () => {
  // Ровно тот отказ, на который панель отвечала «отправлено».
  assert.equal(
    agentError({
      jsonrpc: '2.0',
      error: {code: -32009, message: "The requested A2A protocol version '0.3' is not supported."},
    }),
    "The requested A2A protocol version '0.3' is not supported.",
  );
  assert.equal(agentError({error: {code: 400, status: 'FAILED_PRECONDITION'}}), 'FAILED_PRECONDITION');
  assert.equal(agentError({result: {message: {parts: []}}}), undefined);
});
