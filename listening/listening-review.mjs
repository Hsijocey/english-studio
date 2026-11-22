const SIGNAL_WORDS = [
  'no longer',
  'used to',
  'instead of',
  'in fact',
  'at first',
  'originally',
  'actually',
  'however',
  'although',
  'though',
  'unfortunately',
  'instead',
  'rather',
  'except',
  'sorry',
  'wait',
  'change',
  'changed',
  'but',
  'not',
  'never',
  'only',
];

function escHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function parseSeconds(t) {
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (!t || typeof t !== 'string') return null;
  const parts = t.replace(',', '.').split(':').map(Number);
  if (!parts.every(Number.isFinite)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanAnswerTokens(rawAnswer) {
  const variants = String(rawAnswer || '')
    .split('/')
    .map((v) => v.trim())
    .filter(Boolean);
  const tokens = [];
  for (const v of variants) {
    const clean = v.replace(/[()]/g, '').trim();
    if (clean.length >= 2) tokens.push(clean);
    for (const part of clean.split(/\s+/)) {
      if (part.length >= 3 || /^\d+$/.test(part)) tokens.push(part);
    }
  }
  return [...new Set(tokens)].sort((a, b) => b.length - a.length);
}

export function buildReviewModel(set) {
  const rawTranscript = Array.isArray(set?.transcript) ? set.transcript : [];
  const replayCues = set?.replay?.cues || null;

  const cues = rawTranscript.map((row, index) => {
    const [rawStart, rawEnd, rawText] = row;
    const text = String(rawText || '');
    const rc = replayCues?.[index] || null;
    const start = rc?.start ?? parseSeconds(rawStart);
    let end = rc?.end ?? parseSeconds(rawEnd);
    if (start !== null && (end === null || end <= start)) {
      const nextRaw = rawTranscript[index + 1]?.[0];
      const nextStart = replayCues?.[index + 1]?.start ?? parseSeconds(nextRaw);
      end = nextStart !== null && nextStart > start ? nextStart : start + 4;
    }
    const explicit = [];
    const re = /\(Q(\d+)\b/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const qNum = Number(m[1]);
      if (Number.isInteger(qNum) && !explicit.includes(qNum)) explicit.push(qNum);
    }
    return {
      index,
      start,
      end,
      timed: start !== null && end !== null && end > start,
      text,
      clip: rc?.clip || null,
      calibrated: !!rc?.calibrated,
      explicit,
    };
  });

  const qNums = Object.keys(set?.answers || {})
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const questions = [];
  let cursor = 0;

  for (const q of qNums) {
    const answer = String(set.answers[q] ?? '');
    // 1. Check explicit (Q# ...) markers
    const explicitIndices = cues.filter((c) => c.explicit.includes(q)).map((c) => c.index);
    if (explicitIndices.length) {
      cursor = Math.max(cursor, explicitIndices[0]);
      questions.push({ q, answer, source: 'explicit', indices: explicitIndices });
      continue;
    }

    // 2. Fallback: keyword candidate match in transcript text (preferring cues >= cursor)
    const variants = answer
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    const matched = [];
    for (const v of variants) {
      if (v.length <= 1 && /^[A-Z]$/i.test(v)) continue; // single-letter MCQ option cannot be matched by letter alone
      const rx = new RegExp(`\\b${escapeRegExp(v)}\\b`, 'i');
      for (const c of cues) {
        if (rx.test(c.text)) matched.push(c.index);
      }
      if (matched.length) break;
    }
    if (!matched.length) {
      const tokens = cleanAnswerTokens(answer).filter((t) => t.length >= 4 || /^\d{2,}$/.test(t));
      for (const t of tokens) {
        const rx = new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i');
        for (const c of cues) {
          if (rx.test(c.text)) matched.push(c.index);
        }
        if (matched.length) break;
      }
    }

    const uniq = [...new Set(matched)].sort((a, b) => a - b);
    if (uniq.length) {
      const forward = uniq.filter((i) => i >= Math.max(0, cursor - 2));
      const picked = forward.length ? [forward[0]] : [uniq[0]];
      cursor = picked[0];
      questions.push({ q, answer, source: 'candidate', indices: picked });
    } else {
      questions.push({ q, answer, source: 'none', indices: [] });
    }
  }

  const answerTerms = [...new Set(
    qNums
      .flatMap((q) => cleanAnswerTokens(set.answers[q]))
      .filter((t) => t.length >= 3 || /^\d{2,}$/.test(t))
  )].sort((a, b) => b.length - a.length);

  return { set, cues, questions, answerTerms };
}

export function focusQuestions(entry) {
  if (!entry || entry.external) return [];
  const right = entry.right || {};
  const flags = new Set((entry.flags || []).map(Number));
  const qs = new Set();
  for (const [k, ok] of Object.entries(right)) {
    const n = Number(k);
    if (!ok || flags.has(n)) qs.add(n);
  }
  for (const f of flags) qs.add(f);
  return [...qs].filter(Number.isFinite).sort((a, b) => a - b);
}

export function selectReviewCues(model, { questions = [], difficult = [], mode = 'focus', query = '' } = {}) {
  const qNorm = String(query || '').trim().toLowerCase();
  const matchesQuery = (c) => !qNorm || c.text.toLowerCase().includes(qNorm);

  if (mode === 'all' || mode === 'hidden') {
    return {
      rows: model.cues.filter(matchesQuery),
      unmatched: [],
      fallback: false,
    };
  }

  // focus mode
  const selected = new Set();
  const unmatched = [];
  for (const q of questions) {
    const qInfo = model.questions.find((x) => x.q === q);
    if (!qInfo || !qInfo.indices.length) {
      unmatched.push(q);
      continue;
    }
    for (const idx of qInfo.indices) {
      if (idx > 0) selected.add(idx - 1);
      selected.add(idx);
      if (idx + 1 < model.cues.length) selected.add(idx + 1);
    }
  }
  for (const idx of difficult || []) {
    if (idx >= 0 && idx < model.cues.length) selected.add(idx);
  }

  if (!selected.size) {
    return {
      rows: model.cues.filter(matchesQuery),
      unmatched,
      fallback: true,
    };
  }

  const rows = [...selected]
    .sort((a, b) => a - b)
    .map((i) => model.cues[i])
    .filter(matchesQuery);

  return { rows, unmatched, fallback: false };
}

export function markedTranscript(text, model, { highlights = true, query = '' } = {}) {
  let html = escHtml(text);

  if (highlights) {
    const answerSet = new Set((model?.answerTerms || []).map((t) => t.toLowerCase()));
    const combined = [
      ...(model?.answerTerms || []),
      ...SIGNAL_WORDS,
    ]
      .filter((t) => t && t.length >= 2)
      .sort((a, b) => b.length - a.length);

    if (combined.length) {
      const pattern = new RegExp(`\\b(${combined.map(escapeRegExp).join('|')})\\b`, 'gi');
      html = html.replace(pattern, (match) => {
        const cls = answerSet.has(match.toLowerCase()) ? 'word-answer' : 'word-signal';
        return `<mark class="${cls}">${match}</mark>`;
      });
    }
  }

  const q = String(query || '').trim();
  if (q) {
    const rx = new RegExp(`(${escapeRegExp(escHtml(q))})`, 'gi');
    // Highlight only text nodes outside HTML tags
    html = html
      .split(/(<[^>]+>)/g)
      .map((part) => (part.startsWith('<') ? part : part.replace(rx, '<mark class="word-search">$1</mark>')))
      .join('');
  }

  return html;
}

export function questionReplay(model, set, q) {
  const qInfo = model.questions.find((x) => x.q === Number(q));
  if (!qInfo || !qInfo.indices.length) return null;
  const idx = qInfo.indices[0];
  const cue = model.cues[idx];
  if (!cue || !cue.timed) return null;

  // Prefer standalone calibrated clip if available (e.g. Batch 6 p1-32's 49 M4A clips)
  if (cue.clip) {
    return {
      clip: cue.clip,
      start: cue.start,
      end: cue.end,
      index: idx,
    };
  }

  // Otherwise return a tight context slice on the full MP3 (prev cue -> next cue)
  const prev = idx > 0 && model.cues[idx - 1]?.timed ? model.cues[idx - 1] : cue;
  const next = idx + 1 < model.cues.length && model.cues[idx + 1]?.timed ? model.cues[idx + 1] : cue;
  return {
    clip: null,
    start: prev.start,
    end: next.end,
    index: idx,
  };
}
