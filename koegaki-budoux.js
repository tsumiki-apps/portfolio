// こえがき — 日本語を文節単位で折り返す（BudouX）。
// 本文(p/li)と日本語見出し(h2/h3)に適用。見出しの英字ラベルはZWSPが入らず実害なし。
// CDNが落ちても import が失敗するだけで本文は普通に読める（壊れない）。
import { loadDefaultJapaneseParser } from 'https://esm.sh/budoux@0.8.3';

const EXCLUDE = ['en', 'sub', 'foot', 'kicker', 'date', 'big'];

function run() {
  let parser;
  try { parser = loadDefaultJapaneseParser(); } catch (e) { return; }
  document.querySelectorAll('p, li, .cta-note, .ui-row .t').forEach((el) => {
    if (el.closest('header, nav, footer')) return;        // ナビ・フッターは除外
    if (el.matches('.closing .t')) return;                // LPの締めタグラインは手動nbを維持
    if (EXCLUDE.some((c) => el.classList.contains(c))) return; // 英文/メタ/ブランド文は除外
    if (el.dataset.budouxApplied) return;
    el.classList.add('budoux-target');
    try { parser.applyToElement(el); } catch (e) {}
    el.dataset.budouxApplied = 'true';
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', run);
} else {
  run();
}
