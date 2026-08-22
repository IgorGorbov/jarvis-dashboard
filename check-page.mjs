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
  process.stdout.write('скрипт страницы: синтаксис в порядке\n');
} catch (error) {
  process.stdout.write(`скрипт страницы не компилируется: ${error.message}\n`);
  process.exit(1);
}
