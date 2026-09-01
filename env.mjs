/**
 * Настройки из `.env`, если он есть.
 *
 * Флаг `--env-file-if-exists` делает то же самое, но печатает «.env not found»
 * при каждом запуске — а файла по замыслу может не быть, и строка выглядит
 * ошибкой. Здесь отсутствие файла молчаливо, как и задумано.
 *
 * Переменные, уже заданные в оболочке, не перетираются: `JARVIS_ARTIFACTS=… yarn start`
 * должен побеждать файл, иначе разовый запуск на чужих артефактах не сделать.
 */
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
if (existsSync(file)) process.loadEnvFile(file);
