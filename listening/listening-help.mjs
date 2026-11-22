export function cueTranslation(translations, set, cueIndex) {
  const setZh = translations?.[set?.id];
  if (setZh) {
    if (Array.isArray(setZh.cues) && setZh.cues[cueIndex]) {
      return setZh.cues[cueIndex];
    }
    if (Array.isArray(setZh) && setZh[cueIndex]) {
      return setZh[cueIndex];
    }
  }
  return '（本套暂未收录该段中文翻译，可对照上方英文原稿与参考答案词精听。）';
}

function norm(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function questionExplanation(translations, set, q, entry) {
  const ref = String(set?.answers?.[q] ?? '');
  const custom = translations?.[set?.id]?.explanations?.[q];
  if (custom) return custom;

  if (!entry || entry.external) {
    return `参考答案：${ref}。回听本段时注意答案词前后的同义替换与停顿。`;
  }

  const given = String(entry.answers?.[q] ?? '').trim();
  const isRight = entry.right?.[q] === true;
  const isUncertain = Array.isArray(entry.flags) && entry.flags.includes(Number(q));

  if (isRight && !isUncertain) {
    return `本轮答对（${ref}）。可重点听一遍答案词的连读与重音位置，加深耳朵印象。`;
  }
  if (isRight && isUncertain) {
    return `本轮答对（${ref}），但标记了不确定。建议反复听这一句的定位词与信号词，确认听出原因。`;
  }
  if (!given) {
    return `本轮留空，参考答案是「${ref}」。回听时先找题干关键词定位，再注意答案词是否被弱读或快速带过。`;
  }
  const gNorm = norm(given);
  const rNorm = norm(ref.split('/')[0]);
  if (gNorm && rNorm && (gNorm + 's' === rNorm || rNorm + 's' === gNorm || gNorm + 'es' === rNorm || rNorm + 'es' === gNorm)) {
    return `你写了「${given}」，参考答案是「${ref}」——很接近，属于单复数细节差，注意句中语法与尾音 /s/、/z/。`;
  }
  return `你写了「${given}」，参考答案是「${ref}」。对照本段原稿，检查是否被转折干扰项带偏或没听出原词发音。`;
}
