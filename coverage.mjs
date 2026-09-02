/**
 * Что из конвейера уже видели живьём, а что ещё нет.
 *
 * Карта сценариев в документе устареет первой: её надо помнить и править
 * руками. Здесь напоминают данные — список решений берётся из схем агента,
 * увиденное считается по ленте, а разница печатается вместе с задачей, которой
 * дыру закрывают. Забыть можно документ, но не строку в выводе `yarn test`.
 *
 * Наблюдения копятся в `coverage.json`: каталог артефактов чистят, и без
 * накопления счёт обнулялся бы вместе с ним.
 *
 * Ничего не роняет: полного покрытия не будет никогда — часть веток живёт
 * только в Mattermost, часть срабатывает лишь на браке модели. Это отчёт, а не
 * ворота.
 */
import './env.mjs';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Путь — первый аргумент, который не флаг: иначе `--short` уезжал в ROOT,
// скрипт читал несуществующий каталог и печатал старое число из накопителя,
// ничего не досчитывая. Ровно тот молчаливый отказ, против которого он написан.
const ROOT = path.resolve(
  process.argv.slice(2).find((a) => !a.startsWith('--')) ??
    process.env.JARVIS_ARTIFACTS ??
    path.join(HERE, '..', 'agents', 'artifacts', 'jarvis'),
);
const SCHEMAS = process.env.JARVIS_SCHEMAS
  ? path.resolve(process.env.JARVIS_SCHEMAS)
  : path.join(HERE, '..', 'agents', 'src', 'agents', 'jarvis', 'internal', 'schemas.ts');
const TALLY = path.join(HERE, 'coverage.json');

const read = async (file) => {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
};

const idsOf = (source, name) => {
  const block = source.match(new RegExp(`export type ${name}[\\s\\S]*?;`));
  return block ? [...block[0].matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]) : [];
};

const schemas = await read(SCHEMAS);
if (!schemas) {
  process.stdout.write('покрытие: репозиторий агентов рядом не найден, пропускаю\n');
  process.exit(0);
}

const declared = [...idsOf(schemas, 'DecisionId'), ...idsOf(schemas, 'IncomingId')];
// Без файла сценариев покрытие всё равно считается — просто без подсказок,
// чем закрыть дыру.
const scenariosRaw = await read(path.join(HERE, 'scenarios.json'));
const scenarios = scenariosRaw ? JSON.parse(scenariosRaw) : {};

// Новое решение агента без сценария — такая же дыра, как непокрытое: про него
// никто не вспомнит, потому что его нет ни в одном списке.
const orphans = scenariosRaw ? declared.filter((id) => !scenarios[id]) : [];
// Обратная сторона: решение переименовали, а сценарий остался. Он не мешает,
// но описывает то, чего нет, и однажды его прочтут как задание.
const stale = Object.keys(scenarios).filter(
  (id) => id !== '_' && !declared.includes(id),
);

const tally = JSON.parse((await read(TALLY)) ?? '{}');
const journal = (await read(path.join(ROOT, 'events.jsonl'))) ?? '';
let fresh = 0;
for (const line of journal.split('\n')) {
  if (!line.trim()) continue;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  const id = row.decision;
  if (!id || tally[id]) continue;
  tally[id] = row.at;
  fresh += 1;
}
if (fresh) await writeFile(TALLY, JSON.stringify(tally, null, 2) + '\n');

const missing = declared.filter((id) => !tally[id]);
const covered = declared.length - missing.length;
const share = Math.round((covered / declared.length) * 100);

process.stdout.write(
  `покрытие сценариев: ${covered} из ${declared.length} (${share}%)` +
    (fresh ? `, ново за этот прогон: ${fresh}` : '') +
    '\n',
);

if (orphans.length) {
  process.stdout.write(`  БЕЗ СЦЕНАРИЯ в scenarios.json: ${orphans.join(', ')}\n`);
}
if (stale.length) {
  process.stdout.write(`  СЦЕНАРИЙ БЕЗ РЕШЕНИЯ, агент такого не знает: ${stale.join(', ')}\n`);
}

if (process.argv.includes('--short')) process.exit(0);

if (missing.length) {
  process.stdout.write('\nещё не видели:\n');
  for (const id of missing) {
    const s = scenarios[id] ?? {};
    process.stdout.write(`\n  ${id} — ${s['когда'] ?? '?'}\n`);
    if (s['задача']) process.stdout.write(`    задача: ${s['задача']}\n`);
    if (s['как']) process.stdout.write(`    как:    ${s['как']}\n`);
  }
  process.stdout.write('\n');
}
