// 번역 + 사전(한영/영영) 표시. 읽기 화면 팝업과 형광펜 수정 창에서 같이 쓴다.

const DictView = (() => {
  const SINGLE_WORD = /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/;
  // 번역 사용량(MyMemory 하루 제한)을 아끼려고 영영 뜻은 앞의 2개만 번역한다.
  const MAX_TRANSLATED_DEFS = 2;

  function setMessage(el, text, cls) {
    el.textContent = '';
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    el.append(span);
  }

  // text의 번역과 (단어면) 사전을 els.translation / els.phonetic / els.dict에 그린다.
  //   isCurrent(): 그새 다른 글을 열었으면 false → 늦게 온 결과는 버린다
  //   onKorean(뜻): 저장해 둘 한국어 뜻 (번역 → 한영사전 첫 뜻 → 영영 첫 뜻 번역 순)
  //   onPick(뜻): 주면 번역 줄과 사전 뜻을 눌러서 고를 수 있다
  //   onUpdate(): 내용이 바뀔 때마다 (팝업 위치 다시 맞추기 등)
  function show(text, els, { isCurrent = () => true, onKorean = () => {}, onPick = null, onUpdate = () => {} } = {}) {
    const isWord = SINGLE_WORD.test(text);
    els.phonetic.textContent = '';
    els.dict.textContent = '';
    setMessage(els.translation, '번역 중…', 'loading');
    els.translation.classList.toggle('pickable', !!onPick);
    els.translation.onclick = onPick ? () => els.translation.textContent && onPick(els.translation.textContent) : null;

    const translated = Translate.translate(text)
      .then(out => {
        if (!isCurrent()) return null;
        // 단어를 번역하지 못하고 그대로 돌려주면 숨기고 사전 결과에 맡긴다.
        if (isWord && Translate.isUntranslated(text, out)) {
          els.translation.textContent = '';
          return null;
        }
        els.translation.textContent = out;
        onKorean(out);
        return out;
      })
      .catch(err => {
        if (isCurrent()) setMessage(els.translation, '번역 실패: ' + err.message, 'error');
        return null;
      })
      .finally(() => { if (isCurrent()) onUpdate(); });

    if (!isWord) return;

    setMessage(els.dict, '사전 찾는 중…', 'loading');
    Promise.all([
      Translate.lookupKorean(text).catch(() => null),
      Translate.lookup(text).catch(() => null),
      translated,
    ]).then(([ko, en, out]) => {
      if (!isCurrent()) return;
      els.dict.textContent = '';
      if (en) els.phonetic.textContent = en.phonetic;
      if (ko) {
        renderEntry(els.dict, '📖 한영사전', ko, text, { onPick });
        if (!out) onKorean(cleanDef(ko.meanings[0].definitions[0]));
      }
      // 한영사전에 없으면 영영 뜻을 한국어로 번역해서 함께 보여준다.
      if (en) {
        renderEntry(els.dict, '📘 영영사전', en, text, {
          onPick,
          translateDefs: !ko,
          onFirstKorean: out || ko ? null : onKorean,
        });
      }
      if (!ko && !en && !out) setMessage(els.dict, '사전에서 뜻을 찾지 못했어요.', 'error');
      onUpdate();
    });
  }

  const cleanDef = d => d.replace(/[.。]\s*$/, '').trim();

  function renderEntry(container, title, entry, original, { translateDefs = false, onFirstKorean = null, onPick = null } = {}) {
    const head = document.createElement('div');
    head.className = 'dict-title';
    head.textContent = title;
    if (entry.word !== original.toLowerCase()) head.textContent += ` · 원형 ${entry.word}`;
    container.append(head);

    let translatedCount = 0;
    let first = true;
    for (const m of entry.meanings) {
      const pos = document.createElement('div');
      pos.className = 'pos';
      pos.textContent = m.partOfSpeech;
      const ol = document.createElement('ol');
      for (const d of m.definitions) {
        const li = document.createElement('li');
        li.textContent = d;
        ol.append(li);
        let ko = null;
        if (translateDefs && translatedCount++ < MAX_TRANSLATED_DEFS) {
          ko = document.createElement('div');
          ko.className = 'def-ko';
          li.append(ko);
          const isFirst = first;
          Translate.translate(d)
            .then(out => {
              ko.textContent = out;
              if (isFirst) onFirstKorean?.(out);
            })
            .catch(() => ko.remove());
        }
        // 고르기: 번역된 한국어가 있으면 그것을, 없으면 사전 뜻 그대로
        if (onPick) {
          li.classList.add('pickable');
          li.addEventListener('click', () => onPick(cleanDef(ko?.textContent || d)));
        }
        first = false;
      }
      container.append(pos, ol);
    }
  }

  return { show, setMessage, SINGLE_WORD };
})();
