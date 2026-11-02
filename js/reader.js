// 읽기 화면: 페이지 표시, 문장 단위 읽기, 하이라이트, 드래그 번역 팝업.

const Reader = (() => {
  const $ = id => document.getElementById(id);
  const reader = $('reader');
  const content = $('content');
  const btnPlay = $('btn-play');
  const rateInput = $('rate');
  const rateValue = $('rate-value');
  const voiceSelect = $('voice-select');
  const progress = $('progress');
  const popup = $('popup');

  let page = null;
  let sentences = []; // { text, el }
  let cur = 0;
  let playing = false;
  let hooks = { onPageEnd() {} };

  // ---------- 설정 저장 ----------
  function loadSettings() {
    try { return { rate: 1, voiceURI: null, ...JSON.parse(localStorage.getItem('esh.settings')) }; }
    catch { return { rate: 1, voiceURI: null }; }
  }
  const settings = loadSettings();
  const saveSettings = () => localStorage.setItem('esh.settings', JSON.stringify(settings));

  // 문장이 바뀔 때마다 위치를 저장하되, 너무 자주 쓰지 않도록 모아서 저장한다.
  let saveTimer = null;
  function savePageSoon() {
    clearTimeout(saveTimer);
    const p = page;
    saveTimer = setTimeout(() => p && Library.savePage(p), 500);
  }

  // ---------- 페이지 열기 ----------
  // startAt: 특정 문장으로 바로 이동 (형광펜 모아보기에서 들어올 때)
  function open(p, { autoplay = false, startAt = null } = {}) {
    pause();
    hidePopup();
    page = p;
    content.textContent = '';
    sentences = [];

    for (const para of TextParser.parse(p.text)) {
      const el = document.createElement('p');
      para.forEach((s, i) => {
        if (i) el.append(' ');
        const span = document.createElement('span');
        span.className = 'sentence';
        span.dataset.i = sentences.length;
        span.textContent = s;
        el.append(span);
        sentences.push({ text: s, el: span });
      });
      content.append(el);
    }

    page.total = sentences.length;
    page.highlights ??= [];
    renderHighlights();
    cur = -1;
    reader.scrollTop = 0;
    let start = page.done && page.pos >= sentences.length - 1 ? 0 : page.pos;
    if (startAt != null) start = startAt;
    setCurrent(Math.max(0, Math.min(start, sentences.length - 1)), { initial: true });
    if (autoplay) play();
  }

  function close() {
    pause();
    hidePopup();
    clearTimeout(saveTimer);
    if (page) Library.savePage(page);
    page = null;
    progress.textContent = '';
    clearHighlights();
  }

  // ---------- 형광펜 ----------
  // 위치는 { s: 문장 번호, o: 문장 안 글자 위치 }로 저장한다.
  // 페이지 텍스트는 끝에 이어 붙이기만 하므로 앞부분 위치는 바뀌지 않는다.
  const HL_COLORS = ['yellow', 'green', 'blue', 'pink'];
  const cmp = (a, b) => a.s - b.s || a.o - b.o;

  function clearHighlights() {
    if (!('highlights' in CSS)) return;
    for (const c of HL_COLORS) CSS.highlights.delete('hl-' + c);
  }

  function renderHighlights() {
    if (!('highlights' in CSS)) return;
    const byColor = Object.fromEntries(HL_COLORS.map(c => [c, []]));
    for (const h of page.highlights) {
      const a = sentences[h.start.s]?.el.firstChild;
      const b = sentences[h.end.s]?.el.firstChild;
      if (!a || !b) continue;
      const range = new Range();
      range.setStart(a, Math.min(h.start.o, a.length));
      range.setEnd(b, Math.min(h.end.o, b.length));
      byColor[h.color]?.push(range);
    }
    for (const c of HL_COLORS) CSS.highlights.set('hl-' + c, new Highlight(...byColor[c]));
  }

  // 선택 영역 → { start, end } (문장 번호 + 글자 위치). 문장 밖(문단 사이 등)만 선택했으면 null.
  function rangeToSpan(range) {
    let start = null;
    let end = null;
    sentences.forEach((s, i) => {
      const node = s.el.firstChild;
      if (!node || !range.intersectsNode(node)) return;
      const from = range.startContainer === node ? range.startOffset : 0;
      const to = range.endContainer === node ? range.endOffset : node.length;
      if (from >= to) return;
      if (!start) start = { s: i, o: from };
      end = { s: i, o: to };
    });
    return start && { start, end };
  }

  const overlaps = (h, span) => cmp(h.start, span.end) < 0 && cmp(span.start, h.end) < 0;

  // 겹치는 기존 형광펜은 새 것으로 바꾼다.
  function addHighlight(span, color, text, translation) {
    page.highlights = page.highlights.filter(h => !overlaps(h, span));
    page.highlights.push({
      id: Date.now().toString(36), color, text, translation,
      start: span.start, end: span.end, createdAt: Date.now(),
    });
    page.highlights.sort((a, b) => cmp(a.start, b.start));
    renderHighlights();
    Library.savePage(page);
  }

  function eraseHighlights(span) {
    page.highlights = page.highlights.filter(h => !overlaps(h, span));
    renderHighlights();
    Library.savePage(page);
  }

  // ---------- 현재 문장 / 하이라이트 ----------
  function setCurrent(i, { initial = false } = {}) {
    if (!sentences.length || i < 0) { updateProgress(); return; }
    if (sentences[cur]) sentences[cur].el.classList.remove('current');
    cur = i;
    const el = sentences[cur].el;
    el.classList.add('current');
    clearWordHighlight();
    scrollIntoViewIfNeeded(el, initial);
    if (!initial) {
      page.pos = cur;
      savePageSoon();
    }
    updateProgress();
  }

  function scrollIntoViewIfNeeded(el, initial) {
    if (initial && cur === 0) return;
    const r = el.getBoundingClientRect();
    const v = reader.getBoundingClientRect();
    if (initial || r.top < v.top + 40 || r.bottom > v.bottom - 40) {
      el.scrollIntoView({ block: 'center', behavior: initial ? 'auto' : 'smooth' });
    }
  }

  function highlightWord(el, start, length) {
    if (!('highlights' in CSS)) return;
    const node = el.firstChild;
    if (!node) return;
    const len = node.textContent.length;
    const range = new Range();
    range.setStart(node, Math.min(start, len));
    range.setEnd(node, Math.min(start + length, len));
    const h = new Highlight(range);
    h.priority = 1; // 형광펜 위에 표시
    CSS.highlights.set('tts-word', h);
  }

  function clearWordHighlight() {
    if ('highlights' in CSS) CSS.highlights.delete('tts-word');
  }

  function updateProgress() {
    if (!sentences.length) { progress.textContent = ''; return; }
    const pct = Math.round(((cur + 1) / sentences.length) * 100);
    progress.textContent = `문장 ${cur + 1} / ${sentences.length} (${pct}%)`;
  }

  // ---------- 재생 ----------
  function speakCurrent() {
    const s = sentences[cur];
    if (!s) return;
    TTS.speak(s.text, {
      onWord: (start, length) => highlightWord(s.el, start, length),
      onEnd: () => {
        if (!playing) return;
        if (cur < sentences.length - 1) {
          setCurrent(cur + 1);
          speakCurrent();
        } else {
          finishPage({ continuePlaying: true });
        }
      },
    });
  }

  // 페이지 끝: 완료 표시 후 다음 페이지로 넘어갈지 app에 맡긴다.
  function finishPage({ continuePlaying }) {
    pause();
    if (!page) return;
    page.done = true;
    clearTimeout(saveTimer);
    Library.savePage(page);
    hooks.onPageEnd(page, { autoplay: continuePlaying });
  }

  function play() {
    if (!sentences.length) return;
    playing = true;
    btnPlay.textContent = '⏸';
    speakCurrent();
  }

  function pause() {
    playing = false;
    btnPlay.textContent = '▶';
    TTS.stop();
    clearWordHighlight();
  }

  function goTo(i) {
    if (!sentences.length) return;
    setCurrent(Math.max(0, Math.min(i, sentences.length - 1)));
    if (playing) speakCurrent();
  }

  btnPlay.addEventListener('click', () => (playing ? pause() : play()));
  $('btn-prev').addEventListener('click', () => goTo(cur - 1));
  $('btn-next').addEventListener('click', () => goTo(cur + 1));

  // 문장 클릭 → 그 문장부터 읽기.
  // 더블클릭(단어 선택)과 구분하기 위해 잠깐 기다렸다가 선택 영역이 없을 때만 처리한다.
  let clickTimer = null;
  let suppressClick = false; // 팝업을 닫으려고 누른 클릭은 읽기 시작으로 처리하지 않는다
  content.addEventListener('click', e => {
    const span = e.target.closest('.sentence');
    if (!span || suppressClick) return;
    clearTimeout(clickTimer);
    if (e.detail > 1) return;
    clickTimer = setTimeout(() => {
      if (!window.getSelection().isCollapsed) return;
      goTo(Number(span.dataset.i));
      if (!playing) play();
    }, 250);
  });
  content.addEventListener('dblclick', () => clearTimeout(clickTimer));

  document.addEventListener('keydown', e => {
    if (!page || reader.hidden) return;
    if (e.target.closest('input, select, textarea, button, dialog')) return;
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(cur - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); goTo(cur + 1); }
    else if (e.key === 'Escape') hidePopup();
  });

  window.addEventListener('beforeunload', () => {
    TTS.stop();
    if (page) Library.savePage(page);
  });

  // ---------- 속도 / 음성 ----------
  function applyRate(r) {
    rateInput.value = r;
    rateValue.textContent = Number(r).toFixed(1) + 'x';
    TTS.setRate(Number(r));
  }
  applyRate(settings.rate);

  rateInput.addEventListener('input', () => {
    applyRate(rateInput.value);
    settings.rate = Number(rateInput.value);
    saveSettings();
  });
  rateInput.addEventListener('change', () => { if (playing) speakCurrent(); });

  TTS.onVoicesChanged(voices => {
    voiceSelect.textContent = '';
    if (!voices.length) {
      voiceSelect.append(new Option('(기본 음성)', ''));
      return;
    }
    for (const v of voices) voiceSelect.append(new Option(`${v.name} (${v.lang})`, v.voiceURI));
    if (voices.some(v => v.voiceURI === settings.voiceURI)) voiceSelect.value = settings.voiceURI;
    TTS.setVoice(voiceSelect.value);
  });

  voiceSelect.addEventListener('change', () => {
    TTS.setVoice(voiceSelect.value);
    settings.voiceURI = voiceSelect.value;
    saveSettings();
    if (playing) speakCurrent();
  });

  // ---------- 드래그 번역 팝업 ----------
  const popupSource = $('popup-source');
  const popupPhonetic = $('popup-phonetic');
  const popupTranslation = $('popup-translation');
  const popupDict = $('popup-dict');
  const SINGLE_WORD = /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/;
  const MAX_SELECTION = 1500;
  let popupToken = 0;
  let popupText = '';

  // 폰/태블릿: 팝업을 화면 아래 시트로 띄운다 (브라우저 기본 선택 메뉴와 겹치지 않게).
  const sheetMode = matchMedia('(pointer: coarse)');
  let lastPointer = 'mouse';
  let selKey = '';

  function handleSelection() {
    const sel = window.getSelection();
    if (sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!content.contains(range.commonAncestorContainer)) return;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text || !/[A-Za-z]/.test(text)) return;
    const span = rangeToSpan(range);
    // 선택 핸들을 움직이는 동안 같은 선택으로 여러 번 불리므로 바뀌었을 때만 다시 띄운다.
    const key = text + JSON.stringify(span);
    if (!popup.hidden && key === selKey) return;
    selKey = key;
    showPopup(text.slice(0, MAX_SELECTION), range.getBoundingClientRect(), span);
  }

  // 마우스: 드래그가 끝나고 선택 영역이 확정된 뒤에 읽는다.
  content.addEventListener('mouseup', () => setTimeout(handleSelection, 0));

  // 터치: 길게 눌러 선택하면 mouseup이 오지 않으므로 선택 변경을 감지한다.
  let selTimer = null;
  document.addEventListener('selectionchange', () => {
    if (lastPointer === 'mouse' || !page || reader.hidden) return;
    clearTimeout(selTimer);
    selTimer = setTimeout(handleSelection, 350);
  });

  const popupTools = popup.querySelector('.popup-tools');
  const btnErase = $('hl-erase');
  let popupSpan = null;
  let popupTranslated = '';

  function updateEraseButton() {
    btnErase.hidden = !popupSpan || !page.highlights.some(h => overlaps(h, popupSpan));
  }

  popupTools.addEventListener('click', e => {
    const color = e.target.closest('.hl-btn')?.dataset.color;
    if (!color || !popupSpan) return;
    addHighlight(popupSpan, color, popupText, popupTranslated);
    window.getSelection().removeAllRanges();
    updateEraseButton();
  });

  btnErase.addEventListener('click', () => {
    if (!popupSpan) return;
    eraseHighlights(popupSpan);
    window.getSelection().removeAllRanges();
    updateEraseButton();
  });

  function showPopup(text, rect, span) {
    const my = ++popupToken;
    popupText = text;
    popupSpan = span;
    popupTranslated = '';
    popupTools.hidden = !span;
    updateEraseButton();
    const isWord = SINGLE_WORD.test(text);

    popupSource.textContent = text;
    popupPhonetic.textContent = '';
    popupDict.textContent = '';
    setMessage(popupTranslation, '번역 중…', 'loading');
    popup.hidden = false;
    popup.scrollTop = 0;
    positionPopup(rect, reader.scrollTop);

    // 형광펜에 함께 저장할 한국어 뜻. 번역이 오기 전에 칠했으면 나중에 채워 넣는다.
    const setKorean = out => {
      popupTranslated = out;
      const h = page?.highlights.find(h => h.text === text && !h.translation);
      if (h) { h.translation = out; Library.savePage(page); }
    };

    const translated = Translate.translate(text)
      .then(out => {
        if (my !== popupToken) return null;
        // 단어를 번역하지 못하고 그대로 돌려주면 숨기고 사전 결과에 맡긴다.
        if (isWord && Translate.isUntranslated(text, out)) {
          popupTranslation.textContent = '';
          return null;
        }
        popupTranslation.textContent = out;
        setKorean(out);
        return out;
      })
      .catch(err => {
        if (my === popupToken) setMessage(popupTranslation, '번역 실패: ' + err.message, 'error');
        return null;
      })
      .finally(() => { if (my === popupToken) positionPopup(rect); });

    if (!isWord) return;

    setMessage(popupDict, '사전 찾는 중…', 'loading');
    Promise.all([
      Translate.lookupKorean(text).catch(() => null),
      Translate.lookup(text).catch(() => null),
      translated,
    ]).then(([ko, en, out]) => {
      if (my !== popupToken) return;
      popupDict.textContent = '';
      if (en) popupPhonetic.textContent = en.phonetic;
      if (ko) {
        renderDictionary('📖 한영사전', ko, text);
        if (!out) setKorean(ko.meanings[0].definitions[0]);
      }
      // 한영사전에 없으면 영영 뜻을 한국어로 번역해서 함께 보여준다.
      if (en) renderDictionary('📘 영영사전', en, text, { translateDefs: !ko, onFirstKorean: out || ko ? null : setKorean });
      if (!ko && !en && !out) setMessage(popupDict, '사전에서 뜻을 찾지 못했어요.', 'error');
      positionPopup(rect);
    });
  }

  function renderDictionary(title, entry, original, { translateDefs = false, onFirstKorean = null } = {}) {
    const head = document.createElement('div');
    head.className = 'dict-title';
    head.textContent = title;
    if (entry.word !== original.toLowerCase()) head.textContent += ` · 원형 ${entry.word}`;
    popupDict.append(head);

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
        if (translateDefs) {
          const ko = document.createElement('div');
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
        first = false;
      }
      popupDict.append(pos, ol);
    }
  }

  function setMessage(el, text, cls) {
    el.textContent = '';
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    el.append(span);
  }

  // 팝업은 reader(스크롤 영역) 안에 absolute로 붙어 있어서 스크롤해도 선택 위치를 따라간다.
  // rect는 선택 시점의 화면 좌표이므로 그 시점의 scrollTop을 함께 기억해 reader 내부 좌표로 바꾼다.
  // scrollTop을 넘기는 건 처음 띄울 때뿐이고, 번역/사전 결과가 올 때는 생략해서 다시 맞추기만 한다.
  function positionPopup(rect, scrollTop) {
    const initial = scrollTop !== undefined;
    if (initial) popup._scrollTop = scrollTop;
    else scrollTop = popup._scrollTop;
    popup.classList.toggle('sheet', sheetMode.matches);
    reader.classList.toggle('sheet-open', sheetMode.matches);
    if (sheetMode.matches) {
      popup.style.left = popup.style.top = '';
      // 선택한 글자가 시트 뒤에 가려지면 본문을 올려서 보이게 한다.
      const sheetTop = window.innerHeight - popup.offsetHeight;
      if (initial && rect.bottom > sheetTop - 12) reader.scrollBy({ top: rect.bottom - sheetTop + 48, behavior: 'smooth' });
      return;
    }
    const margin = 8;
    const v = reader.getBoundingClientRect();
    const w = popup.offsetWidth;
    const h = popup.offsetHeight;
    let left = rect.left - v.left + rect.width / 2 - w / 2;
    left = Math.max(margin, Math.min(left, reader.clientWidth - w - margin));
    let top = rect.bottom - v.top + margin;
    if (top + h > reader.clientHeight - margin && rect.top - v.top - h - margin > margin) {
      top = rect.top - v.top - h - margin;
    }
    popup.style.left = left + 'px';
    popup.style.top = top + scrollTop + 'px';
  }

  function hidePopup() {
    popupToken++;
    popup.hidden = true;
    reader.classList.remove('sheet-open');
  }

  $('popup-speak').addEventListener('click', () => {
    pause();
    TTS.speak(popupText);
  });

  document.addEventListener('pointerdown', e => {
    lastPointer = e.pointerType;
    suppressClick = !popup.hidden && !popup.contains(e.target);
    if (suppressClick) hidePopup();
  });

  return {
    init(h) { hooks = { ...hooks, ...h }; },
    open,
    close,
    finishPage,
    get page() { return page; },
  };
})();
