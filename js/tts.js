// 브라우저 내장 Web Speech API 래퍼.
// 긴 텍스트를 한 번에 넘기면 Chrome에서 중간에 끊기는 문제가 있어 문장 단위로 읽는다.

const TTS = (() => {
  const synth = window.speechSynthesis;
  let voices = [];
  let voice = null;
  let rate = 1;
  let token = 0; // cancel()된 발화의 onend를 무시하기 위한 식별자

  function loadVoices() {
    voices = synth.getVoices()
      .filter(v => v.lang.toLowerCase().startsWith('en'))
      .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
    return voices;
  }

  // 자연스러운 음성(Edge의 Natural, Chrome의 Google 음성)을 우선한다.
  function score(v) {
    let s = 0;
    if (/natural/i.test(v.name)) s += 4;
    if (/google/i.test(v.name)) s += 2;
    if (v.lang === 'en-US') s += 1;
    return s;
  }

  function onVoicesChanged(cb) {
    loadVoices();
    cb(voices);
    synth.addEventListener('voiceschanged', () => cb(loadVoices()));
  }

  function setVoice(voiceURI) {
    voice = voices.find(v => v.voiceURI === voiceURI) || voices[0] || null;
  }

  function setRate(r) { rate = r; }

  // onWord(charIndex, charLength), onEnd()
  function speak(text, { onWord, onEnd } = {}) {
    stop();
    const my = token;
    const u = new SpeechSynthesisUtterance(text);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'en-US'; }
    u.rate = rate;
    u.onboundary = e => {
      if (my !== token || e.name !== 'word') return;
      onWord?.(e.charIndex, e.charLength || wordLength(text, e.charIndex));
    };
    u.onend = () => { if (my === token) onEnd?.(); };
    u.onerror = e => {
      if (my !== token || e.error === 'interrupted' || e.error === 'canceled') return;
      console.warn('TTS error:', e.error);
      onEnd?.();
    };
    synth.speak(u);
  }

  function wordLength(text, start) {
    const m = /^[\w'’-]+/.exec(text.slice(start));
    return m ? m[0].length : 1;
  }

  function stop() {
    token++;
    synth.cancel();
  }

  return { onVoicesChanged, setVoice, setRate, speak, stop, get voice() { return voice; } };
})();
