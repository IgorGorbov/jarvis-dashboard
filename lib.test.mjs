import {test} from 'node:test';
import assert from 'node:assert/strict';
import {agentText, normalizeOutcome, splitRunDir} from './lib.mjs';

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

test('исход: нынешний result.json с размеченным kind', () => {
  assert.deepEqual(
    normalizeOutcome({kind: 'pr', prUrl: 'https://github.com/o/r/pull/1'}, undefined),
    {kind: 'pr', prUrl: 'https://github.com/o/r/pull/1', reason: undefined},
  );
  assert.deepEqual(normalizeOutcome({kind: 'kept', reason: 'проверки красные'}, undefined), {
    kind: 'kept',
    prUrl: undefined,
    reason: 'проверки красные',
  });
});

test('исход: meta.ended нынешних прогонов', () => {
  // Прогон встал на вопросах — исход `asked`, а число вопросов идёт рядом.
  assert.deepEqual(
    normalizeOutcome(undefined, {ended: {kind: 'asked', questions: ['a', 'b', 'c']}}),
    {kind: 'asked', questions: 3},
  );
  // Продолжение после ответа: исход лежит внутри `ended.outcome`.
  assert.deepEqual(
    normalizeOutcome(undefined, {
      ended: {kind: 'outcome', outcome: {kind: 'stopped', reason: 'нужно подтверждение'}},
    }),
    {kind: 'stopped', prUrl: undefined, reason: 'нужно подтверждение'},
  );
});

test('исход: старые форматы — prOpened, объект и проза', () => {
  assert.deepEqual(normalizeOutcome({prOpened: true, prUrl: 'https://x/pull/7'}, undefined), {
    kind: 'pr',
    prUrl: 'https://x/pull/7',
  });
  assert.deepEqual(normalizeOutcome(undefined, {outcome: {kind: 'suspended'}}), {
    kind: 'suspended',
  });
  // Проза до 13 августа: ссылку вытаскиваем, остальное не разбираем.
  assert.deepEqual(
    normalizeOutcome(undefined, {
      outcome: 'Готово. https://github.com/EruditorGroup/mono-front/pull/14572 — смотрите',
    }),
    {kind: 'pr', prUrl: 'https://github.com/EruditorGroup/mono-front/pull/14572'},
  );
  assert.deepEqual(normalizeOutcome(undefined, {outcome: 'NO_ACTION: остались вопросы'}), {
    kind: 'проза',
    reason: 'NO_ACTION: остались вопросы',
  });
});

test('исход: нечего разбирать', () => {
  assert.equal(normalizeOutcome(undefined, undefined), undefined);
  assert.equal(normalizeOutcome({}, {}), undefined);
});

test('текст агента достаётся из обеих форм конверта', () => {
  assert.equal(
    agentText({result: {parts: [{content: {value: 'NO_ACTION: по FM-1 нет вопроса'}}]}}),
    'NO_ACTION: по FM-1 нет вопроса',
  );
  // Вторая форма — сообщение внутри result.
  assert.equal(
    agentText({result: {message: {parts: [{content: {value: 'Отменяю FM-2'}}]}}}),
    'Отменяю FM-2',
  );
  // Успех тоже возвращается: отмена сообщает по делу, а не только отказывает.
  assert.equal(agentText({result: {parts: [{content: {value: 'PR открыт'}}]}}), 'PR открыт');
  assert.equal(agentText(undefined), undefined);
  assert.equal(agentText({result: {parts: []}}), undefined);
});
