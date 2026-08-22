/**
 * Чистые разборщики: артефакты писались тремя разными способами, а ответы агента
 * приходят в двух формах. Здесь нет ни диска, ни сети — только это и тестируется.
 */

/**
 * Имя папки — `<runTag>-<taskRef>`, а в taskRef дефисы есть (FM-6324).
 * Поэтому делим по первому дефису, а не по последнему.
 */
export const splitRunDir = (name) => {
  const at = name.indexOf('-');
  return at < 0
    ? undefined
    : {runTag: name.slice(0, at), taskRef: name.slice(at + 1)};
};

/**
 * Форматов исхода в артефактах три, и все живые: `result.json` с размеченным
 * `kind`, `meta.ended` нынешних прогонов и `prOpened`/`meta.outcome` старых.
 */
export const normalizeOutcome = (result, meta) => {
  if (result?.kind) {
    return {kind: result.kind, prUrl: result.prUrl, reason: result.reason};
  }
  if (result?.prOpened || result?.prUrl) {
    return {kind: 'pr', prUrl: result.prUrl};
  }
  const ended = meta?.ended;
  if (ended?.kind === 'outcome' && ended.outcome?.kind) {
    const {kind, prUrl, reason} = ended.outcome;
    return {kind, prUrl, reason};
  }
  // `asked` — прогон встал на вопросах к человеку.
  if (ended?.kind) return {kind: ended.kind, questions: ended.questions?.length};
  if (meta?.outcome?.kind) return {kind: meta.outcome.kind};
  // Прогоны до 13 августа писали исход прозой. Разбирать её не будем, но ссылку
  // на PR вытащим — по ней история чем-то полезна.
  if (typeof meta?.outcome === 'string') {
    const link = meta.outcome.match(/https:\/\/github\.com\S+/);
    return link ? {kind: 'pr', prUrl: link[0]} : {kind: 'проза', reason: meta.outcome};
  }
  return undefined;
};

/**
 * Что сказал агент. Формы проверены на живом агенте: JSON-RPC заворачивает ответ
 * в `result`, REST отдаёт сообщение без обёртки, а часть текста лежит в `text`
 * (форма `content.$case` — это запрос, не ответ; оставлена как запас).
 */
export const agentText = (payload) => {
  const message = payload?.result?.message ?? payload?.result ?? payload?.message;
  const said = (message?.parts ?? [])
    .map((part) => part?.text ?? part?.content?.value)
    .filter((value) => typeof value === 'string')
    .join('\n');
  return said || undefined;
};

/** Ошибка протокола: без этого неверный конверт выглядел как успешная отправка. */
export const agentError = (payload) =>
  payload?.error?.message ?? payload?.error?.status ?? undefined;
