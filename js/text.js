// 텍스트 파일을 문단 → 문장 단위로 나눈다.

const TextParser = (() => {
  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter('en', { granularity: 'sentence' })
    : null;

  function splitSentences(paragraph) {
    if (segmenter) {
      return [...segmenter.segment(paragraph)]
        .map(s => s.segment.trim())
        .filter(Boolean);
    }
    return (paragraph.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [])
      .map(s => s.trim())
      .filter(Boolean);
  }

  function splitParagraphs(text) {
    const normalized = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    // 빈 줄이 있으면 빈 줄 기준으로 문단을 나누고, 줄바꿈은 공백으로 합친다(하드랩 대응).
    // 빈 줄이 없으면 각 줄을 하나의 문단으로 본다.
    const blocks = /\n\s*\n/.test(normalized)
      ? normalized.split(/\n\s*\n/).map(b => b.replace(/\s*\n\s*/g, ' '))
      : normalized.split('\n');
    return blocks.map(b => b.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }

  // 반환값: [[sentence, sentence, ...], ...] (문단별 문장 배열)
  function parse(text) {
    return splitParagraphs(text).map(splitSentences).filter(p => p.length);
  }

  return { parse };
})();
