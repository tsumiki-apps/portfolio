// いつつ — JP/EN 言語切替。
// <html> に lang-en クラスを付け外しし、選択を localStorage に保存する。
// 初期クラスは各ページ <head> のインラインスクリプトで先に当てて、ちらつきを防ぐ。
(function () {
  const KEY = 'itsutsu-lang';

  function apply(lang) {
    const en = lang === 'en';
    document.documentElement.classList.toggle('lang-en', en);
    document.documentElement.lang = en ? 'en' : 'ja';
    document.querySelectorAll('.lang-toggle').forEach((b) => {
      b.textContent = en ? '日本語' : 'EN';
      b.setAttribute('aria-label', en ? 'Switch to Japanese' : 'Switch to English');
    });
  }

  function init() {
    let lang = 'ja';
    try { lang = localStorage.getItem(KEY) || 'ja'; } catch (e) {}
    apply(lang);
    document.querySelectorAll('.lang-toggle').forEach((b) => {
      b.addEventListener('click', () => {
        const next = document.documentElement.classList.contains('lang-en') ? 'ja' : 'en';
        try { localStorage.setItem(KEY, next); } catch (e) {}
        apply(next);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
