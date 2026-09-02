/**
 * Синтаксис скрипта страницы. Заведено после того, как конфликт имён
 * (`const last` при уже объявленном) уронил весь скрипт: панель открывалась
 * пустой, без единой ошибки в интерфейсе, и нашлось это только в консоли.
 *
 * `new Function` компилирует, но не исполняет — этого достаточно, чтобы поймать
 * повторные объявления и опечатки, и не нужны ни временный файл, ни подпроцесс.
 */
import {readFile} from 'node:fs/promises';

const page = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const opened = page.indexOf('<script>');
const closed = page.indexOf('</script>', opened);

if (opened < 0 || closed < 0) {
  process.stdout.write('в index.html нет блока <script> — проверять нечего\n');
  process.exit(1);
}

try {
  // eslint-disable-next-line no-new-func
  new Function(page.slice(opened + '<script>'.length, closed));
  // Имена артефактов старого формата, которых больше нет на диске. Ссылка на такой
// файл компилируется и молчит: `issue.txt` в подтверждении понимания вернул
// `{"error":"файл не читается"}`, эта строка уехала агенту вместо постановки, и
// разбор не нашёлся. Компилятор такого не ловит — ловим текстом.
const GONE = [
  'issue.txt', 'meta.json', 'meta.resume.json', 'result.json', 'claims.json',
  'analysis.json', 'questions.md', 'review.json', 'diff.patch', 'events.json',
];
// Смотрим на код, а не на прозу: в комментариях эти имена упоминаются
// законно — там объясняют, почему их больше нет.
const code = page
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const found = GONE.filter((name) => code.includes(name));
if (found.length) {
  process.stdout.write(
    `страница ссылается на файлы, которых нет в нынешнем формате: ${found.join(', ')}\n`,
  );
  process.exit(1);
}

process.stdout.write('скрипт страницы: синтаксис в порядке\n');
} catch (error) {
  process.stdout.write(`скрипт страницы не компилируется: ${error.message}\n`);
  process.exit(1);
}
