// 영→한 번역, 한영사전, 영영사전 조회.
// 번역 1순위: Chrome 내장 Translator API (온디바이스, 무료, 무제한)
// 번역 2순위: MyMemory 무료 API (온라인, 하루 약 5000자 제한, 요청당 500바이트 제한)
// 한영사전: 한국어 위키낱말사전 (흔한 단어 위주)
// 영영사전: dictionaryapi.dev

const Translate = (() => {
  // 번역 결과는 브라우저에 저장해 두고 재사용한다 (MyMemory 하루 사용량 절약).
  const CACHE_KEY = 'esh.tcache';
  const CACHE_MAX = 3000;
  const cache = (() => {
    try { return new Map(Object.entries(JSON.parse(localStorage.getItem(CACHE_KEY)) || {})); }
    catch { return new Map(); }
  })();
  let cacheTimer = null;
  function remember(key, value) {
    cache.set(key, value);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(cache))); } catch {}
    }, 1000);
  }

  let translatorPromise = null;
  let onStatus = () => {};

  function hasBuiltin() {
    return 'Translator' in self;
  }

  async function builtinAvailability() {
    if (!hasBuiltin()) return 'unavailable';
    try {
      return await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'ko' });
    } catch {
      return 'unavailable';
    }
  }

  // 모델 다운로드가 필요한 경우 사용자 동작(드래그 직후) 안에서 호출돼야 한다.
  function getBuiltinTranslator() {
    if (!translatorPromise) {
      translatorPromise = Translator.create({
        sourceLanguage: 'en',
        targetLanguage: 'ko',
        monitor(m) {
          m.addEventListener('downloadprogress', e => {
            onStatus(`번역 모델 다운로드 중… ${Math.round(e.loaded * 100)}%`);
          });
        },
      }).then(t => {
        onStatus('번역: Chrome 내장 번역기');
        return t;
      }).catch(err => {
        translatorPromise = null;
        throw err;
      });
    }
    return translatorPromise;
  }

  async function translateWithMyMemory(text) {
    const url = 'https://api.mymemory.translated.net/get?langpair=en|ko&q=' + encodeURIComponent(text);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
    const data = await res.json();
    const out = data?.responseData?.translatedText;
    if (data.responseStatus !== 200 || !out || /MYMEMORY WARNING/i.test(out)) {
      throw new Error(data.responseDetails || out || '번역 실패');
    }
    return out;
  }

  // MyMemory는 요청당 500바이트 제한이 있어 문장 단위로 쪼개 보낸다.
  async function translateChunked(text) {
    const encoder = new TextEncoder();
    if (encoder.encode(text).length <= 450) return translateWithMyMemory(text);
    const parts = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    const chunks = [];
    let cur = '';
    for (const p of parts) {
      if (cur && encoder.encode(cur + p).length > 450) { chunks.push(cur); cur = ''; }
      cur += p;
    }
    if (cur) chunks.push(cur);
    const results = [];
    for (const c of chunks) results.push(await translateWithMyMemory(c.trim()));
    return results.join(' ');
  }

  // 같은 글을 동시에 여러 번 요청하면 하나의 요청을 같이 기다린다.
  const inFlight = new Map();
  function translate(text) {
    const key = text.trim();
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (!inFlight.has(key)) {
      inFlight.set(key, translateUncached(key).finally(() => inFlight.delete(key)));
    }
    return inFlight.get(key);
  }

  async function translateUncached(key) {
    let result;
    if ((await builtinAvailability()) !== 'unavailable') {
      try {
        const t = await getBuiltinTranslator();
        result = await t.translate(key);
      } catch (err) {
        console.warn('Built-in translator failed, falling back:', err);
      }
    }
    if (result == null) {
      result = await translateChunked(key);
      onStatus('번역: MyMemory (온라인)');
    }
    remember(key, result);
    return result;
  }

  // 변화형 → 원형 후보 (sojourning → sojourn, running → run, stopped → stop, flies → fly ...)
  // 첫 번째는 항상 입력 단어 자체.
  const SUFFIXES = [
    ['iest', ['y']], ['ier', ['y']], ['ies', ['y']], ['ied', ['y']],
    ['ing', ['', 'e']], ['ed', ['', 'e']], ['est', ['', 'e']], ['er', ['', 'e']],
    ['es', ['']], ['s', ['']], ['ly', ['']],
  ];

  function lemmaCandidates(word) {
    const w = word.toLowerCase();
    const out = [w];
    const add = s => { if (s.length >= 2 && !out.includes(s)) out.push(s); };
    for (const [suf, reps] of SUFFIXES) {
      if (!w.endsWith(suf) || w.length <= suf.length + 1) continue;
      const stem = w.slice(0, -suf.length);
      for (const r of reps) add(stem + r);
      if (/([bdgklmnprtvz])\1$/.test(stem)) add(stem.slice(0, -1)); // runn → run
    }
    return out;
  }

  // 후보를 차례로 찾아 처음 성공한 결과를 { word, ...결과 }로 돌려준다.
  const dictCache = new Map();
  async function firstFound(kind, word, fetcher) {
    const key = kind + ':' + word.toLowerCase();
    if (!dictCache.has(key)) {
      dictCache.set(key, (async () => {
        for (const w of lemmaCandidates(word)) {
          const found = await fetcher(w).catch(() => null);
          if (found) return { word: w, ...found };
        }
        return null;
      })());
    }
    return dictCache.get(key);
  }

  // dictionaryapi.dev 무료 영영사전. 없으면 null.
  async function fetchEnglish(word) {
    const res = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word));
    if (!res.ok) return null;
    const entries = await res.json();
    if (!Array.isArray(entries) || !entries.length) return null;

    const phonetic = entries.map(e => e.phonetic || e.phonetics?.find(p => p.text)?.text).find(Boolean) || '';
    const meanings = [];
    for (const e of entries) {
      for (const m of e.meanings || []) {
        let group = meanings.find(g => g.partOfSpeech === m.partOfSpeech);
        if (!group) meanings.push(group = { partOfSpeech: m.partOfSpeech, definitions: [] });
        for (const d of m.definitions || []) {
          if (group.definitions.length < 3) group.definitions.push(d.definition);
        }
      }
    }
    return { phonetic, meanings };
  }

  // 위키 문법 제거: [[링크|글자]] → 글자, {{틀}} 삭제, '''굵게''' → 굵게
  function stripWiki(s) {
    let prev;
    do { prev = s; s = s.replace(/\{\{[^{}]*\}\}/g, ''); } while (s !== prev);
    return s
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
      .replace(/\[https?:\/\/\S+\s*([^\]]*)\]/g, '$1')
      .replace(/'{2,}/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 한국어 위키낱말사전의 "영어" 항목에서 품사별 한국어 뜻을 뽑는다. 뜻이 비어 있으면 null.
  async function fetchKorean(word) {
    const url = 'https://ko.wiktionary.org/w/api.php?action=parse&prop=wikitext&format=json&origin=*&redirects=1&page='
      + encodeURIComponent(word);
    const data = await (await fetch(url)).json();
    const wt = data?.parse?.wikitext?.['*'];
    if (!wt) return null;
    const head = /^==\s*영어\s*==\s*$/m.exec(wt);
    if (!head) return null;
    let sec = wt.slice(head.index + head[0].length);
    const next = /^==[^=].*[^=]==\s*$/m.exec(sec);
    if (next) sec = sec.slice(0, next.index);

    const groups = [];
    let g = null;
    for (const line of sec.split('\n')) {
      const h = /^===+\s*([^=]+?)\s*===+\s*$/.exec(line);
      if (h) { groups.push(g = { partOfSpeech: h[1], definitions: [] }); continue; }
      if (!g) continue;
      let def = null;
      if (/^#(?![:*#])/.test(line)) def = line.replace(/^#\s*/, '');
      else if (/^:\*\s*'''\d+-\d+\.'''/.test(line)) def = line.replace(/^:\*\s*'''\d+-\d+\.'''/, ''); // run의 1-1. 같은 세부 뜻
      if (def == null) continue;
      def = stripWiki(def);
      if (def && g.definitions.length < 4) g.definitions.push(def);
    }
    const meanings = groups.filter(x => x.definitions.length);
    return meanings.length ? { meanings } : null;
  }

  const lookup = word => firstFound('en', word, fetchEnglish);
  const lookupKorean = word => firstFound('ko', word, fetchKorean);

  // 번역기가 단어를 번역하지 못하고 그대로 돌려줬는지
  const isUntranslated = (src, out) => !out || out.trim().toLowerCase() === src.trim().toLowerCase();

  async function init(statusCb) {
    onStatus = statusCb;
    const a = await builtinAvailability();
    if (a === 'available') onStatus('번역: Chrome 내장 번역기');
    else if (a === 'downloadable' || a === 'downloading') onStatus('번역: Chrome 내장 번역기 (첫 사용 시 모델 다운로드)');
    else onStatus('번역: MyMemory (온라인)');
  }

  return { init, translate, lookup, lookupKorean, isUntranslated };
})();
