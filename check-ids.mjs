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

const idsOf = (source, name) => {
  const block = source.match(new RegExp(`export type ${name}[\\s\\S]*?;`));
  return block ? [...block[0].matchAll(/'([A-Z]+\d*)'/g)].map((m) => m[1]) : [];
};

const bucketOf = (page, name) => {
  const block = page.match(new RegExp(`const ${name} = new Set\\(\\[[\\s\\S]*?\\]`));
  return block ? [...block[0].matchAll(/'([A-Z]+\d*)'/g)].map((m) => m[1]) : [];
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

if (declared.length === 0 || known.size === 0) {
  process.stdout.write('идентификаторы: не смог вычитать списки — проверьте разметку\n');
  process.exit(1);
}

const missing = declared.filter((id) => !known.has(id));
const stale = [...known].filter((id) => !declared.includes(id));

if (missing.length === 0 && stale.length === 0) {
  process.stdout.write(`идентификаторы: все ${declared.length} разложены по корзинам\n`);
  process.exit(0);
}

if (missing.length) {
  process.stdout.write(`панель не знает решений: ${missing.join(', ')}\n`);
}
if (stale.length) {
  process.stdout.write(`в панели лишние: ${stale.join(', ')}\n`);
}
process.exit(1);
