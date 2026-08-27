/**
 * Сверка идентификаторов решений с источником в репозитории агентов.
 *
 * Заведено потому, что этот класс ошибки кусал дважды: новое решение агента
 * (сначала `PR3`, потом `I5`) панель не знала и красила зелёным. Умолчание
 * теперь безопасное, но молчаливое расхождение остаётся — эта проверка делает
 * его громким.
 *
 * Репозиторий агентов рядом не обязателен: если его нет, проверка пропускается.
 */
import {readFile} from 'node:fs/promises';

const AGENT_SCHEMAS = new URL(
  '../agents/src/agents/jarvis/internal/schemas.ts',
  import.meta.url,
);

// С `1c63064` идентификаторы — говорящие имена в кебаб-кейсе, а не коды вроде
// `A5`. Прежнее выражение под коды перестало ловить что-либо, и проверка падала
// с «не смог вычитать списки» — громко, но не по делу.
const QUOTED = /'([a-z][a-z0-9-]*)'/g;

const idsOf = (source, name) => {
  const block = source.match(new RegExp(`export type ${name}[\\s\\S]*?;`));
  return block ? [...block[0].matchAll(QUOTED)].map((m) => m[1]) : [];
};

const bucketOf = (page, name) => {
  const block = page.match(new RegExp(`const ${name} = new Set\\(\\[[\\s\\S]*?\\]`));
  return block ? [...block[0].matchAll(QUOTED)].map((m) => m[1]) : [];
};

let schemas;
try {
  schemas = await readFile(AGENT_SCHEMAS, 'utf8');
} catch {
  process.stdout.write('идентификаторы: репозиторий агентов рядом не найден, пропускаю\n');
  process.exit(0);
}

const page = await readFile(new URL('./index.html', import.meta.url), 'utf8');

const declared = [...idsOf(schemas, 'DecisionId'), ...idsOf(schemas, 'IncomingId')];
const known = new Set([
  ...bucketOf(page, 'STOP'),
  ...bucketOf(page, 'HOLD'),
  ...bucketOf(page, 'GOOD'),
]);

// Виды исхода: те же грабли, что с решениями. `runOutcomeSchema` — исходы
// конвейера, `RunEnded` в jarvis.ts — то, чем кончился прогон целиком.
const kindsOf = (source) => [...source.matchAll(/kind: z\.literal\('([\w-]+)'\)/g)].map((m) => m[1]);
const endedKindsOf = (source) => [...source.matchAll(/\{kind: '([\w-]+)'/g)].map((m) => m[1]);
const kindBucket = (name) =>
  (page.match(new RegExp(`const ${name} = new Set\\(\\[[\\s\\S]*?\\]`)) ?? [''])[0]
    .match(/'([^']+)'/g)?.map((q) => q.slice(1, -1)) ?? [];

let jarvis = '';
try {
  jarvis = await readFile(new URL('../agents/src/agents/jarvis/internal/jarvis.ts', import.meta.url), 'utf8');
} catch {
  // Файл мог переехать при рефакторинге: тогда сверяем только схему исходов.
}

// `{kind: 'outcome', outcome: {...}}` — обёртка вокруг исхода конвейера, а не
// вид исхода сама по себе: раскрашивать по ней нечего.
const WRAPPERS = new Set(['outcome']);
const kinds = [...new Set([...kindsOf(schemas), ...endedKindsOf(jarvis)])].filter(
  (kind) => !WRAPPERS.has(kind),
);
const knownKinds = new Set([
  ...kindBucket('KIND_OK'),
  ...kindBucket('KIND_BAD'),
  ...kindBucket('KIND_WAIT'),
]);

if (declared.length === 0 || known.size === 0 || knownKinds.size === 0) {
  process.stdout.write('идентификаторы: не смог вычитать списки — проверьте разметку\n');
  process.exit(1);
}

const missing = declared.filter((id) => !known.has(id));
const stale = [...known].filter((id) => !declared.includes(id));
const missingKinds = kinds.filter((kind) => !knownKinds.has(kind));

if (missing.length === 0 && stale.length === 0 && missingKinds.length === 0) {
  process.stdout.write(
    `идентификаторы: все ${declared.length} разложены, виды исхода (${kinds.length}) тоже\n`,
  );
  process.exit(0);
}

if (missing.length) {
  process.stdout.write(`панель не знает решений: ${missing.join(', ')}\n`);
}
if (stale.length) {
  process.stdout.write(`в панели лишние: ${stale.join(', ')}\n`);
}
if (missingKinds.length) {
  process.stdout.write(`панель не знает исходов: ${missingKinds.join(', ')}\n`);
}
process.exit(1);
