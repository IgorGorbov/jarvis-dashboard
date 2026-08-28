/**
 * Чистые разборщики файла прогона и ответов агента. Здесь нет ни диска, ни сети —
 * только это и тестируется.
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
 * Файл прогона: строка на факт, вид в поле `kind`. Порядок — контракт: `session`
 * первой, `session-end` последней. Недописанную последнюю строку пропускаем —
 * файл могли читать в момент дозаписи.
 */
export const parseRun = (text) => {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Строка ещё пишется: следующее чтение её застанет целой.
    }
  }
  return rows;
};

/**
 * Сводка прогона из его строк: то, что нужно списку, — без разбора середины.
 * Сессий может быть несколько: анализ спросил, человек ответил через час, прогон
 * поехал дальше под той же меткой. Работа и ожидание не складываются.
 */
export const runSummary = (rows) => {
  const sessions = rows.filter((r) => r.kind === 'session');
  const ends = rows.filter((r) => r.kind === 'session-end');
  const first = sessions[0];
  const last = ends[ends.length - 1];
  return {
    model: first?.model,
    // Связь с прогоном-родителем агент кладёт в строку разбора, а не сессии:
    // берём из любой, где она есть, — место в файле не наше дело.
    continues: rows.find((r) => r.continues)?.continues,
    startedAt: first?.at,
    finishedAt: last?.at,
    resumed: sessions.length > 1,
    outcome: normalizeOutcome(last?.ended),
  };
};

/**
 * Исход сессии. `Ended` в агенте — четыре вида: `outcome` несёт исход конвейера,
 * остальные три (`asked`, `cancelled`, `failed`) сами и есть исход. Без второй
 * ветки отменённый прогон был бы неотличим от упавшего.
 */
export const normalizeOutcome = (ended) => {
  if (!ended?.kind) return undefined;
  if (ended.kind === 'outcome') {
    const out = ended.outcome;
    return out?.kind
      ? {kind: out.kind, prUrl: out.prUrl, branch: out.branch, reason: out.reason ?? out.summary}
      : undefined;
  }
  return {
    kind: ended.kind,
    reason: ended.reason,
    questions: ended.questions?.length,
  };
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
