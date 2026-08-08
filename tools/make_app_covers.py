# -*- coding: utf-8 -*-
"""アプリ詳細ページの先頭に置く「要約カバー」を つみきの紙×墨で生成する。

  実行: DYLD_LIBRARY_PATH=/opt/homebrew/lib python3 tools/make_app_covers.py
  出力: assets/covers/cover-<app>.png

## 文字サイズの決め方（この節が本体。数字を触る前に必ず読む）

画像は本文の中に置くので、**画像の中の文字はページの文字階層に収まっていないと
浮く**。ズレると「画像だけ大きすぎる」と感じられる（2026-08-08、実際にそうなった）。

    画面上の文字サイズ = 画像内の文字サイズ x (描画幅 / 画像の横幅)

iPhone（横375px）での描画幅は、シート本文＝**335px**、一覧カードの帯＝**306px**。
幅1080なら倍率はそれぞれ 0.310 / 0.283。

**ページ側の実測値（375px・アプリ詳細）**

    アプリ名 .as-name    23px  ← ページで最大
    見出し   .as-h       15px
    本文     .as-about   14px
    キャプション figcaption 12px
    一覧カード名 .app-card-name 17px ／ 説明 .app-card-desc 12.5px

**画像の中はこの範囲に収める。** はみ出すと階層が壊れる：

    カバーの見出し  → 17〜18px（.as-name 23 より小さく、.as-h 15 より大きく）
    カバーの要点    → 12〜13px（figcaption 12 と同じ「キャプションの段」）
    カバーのキッカー→ 11〜12px
    帯の見出し      → 14px前後（.app-card-name 17 より小さく）
    帯のキッカー    →  9〜10px

→ 上の倍率で割り戻したのが下の SIZES。**下限は 12px**（サイトが figcaption で
使っている最小の可読サイズ）。文字を増やしたくなったらサイズを下げず、言葉を削る。

### 過去にやった失敗
- 16:9・幅1220・本文19px（ランサーズ用）をそのまま置いた → iPhone で本文5px。読めない
- 逆に振りすぎて 見出し65px（画面上20.2px）にした → **ページのどの見出しより大きく**
  なり、しかも一番太い書体なので浮いた。キッカーは22px（画面上6.8px）で小さすぎ、
  画像の中だけ 6.8〜20.2px という別の階層ができていた

## 入れていないもの（サイト内に置く画像なので不要）
- **ロゴ「つみき」・URL** … サイト自体がつみき。外に出す用（ランサーズ・SNS）だけ必要
- **アプリ名** … 詳細ページは真上の `.as-name`、一覧はカード内の名前が出している
- **実機スクショ** … 「プレビュー」節に既に10枚ある。重複するうえ文字が縮む
"""
import io
import os

import cairosvg
from PIL import Image, ImageDraw, ImageFont

# 横解像度。**描画幅を縮めるときは、ここも同じ比率で縮める**こと。
# そうしないと画面上の文字まで一緒に小さくなる（画像内の文字サイズは据え置きでよい）。
W_COVER = 960              # 描画 スマホ300px / PC380px → 倍率 0.313 / 0.396
W_STRIP = 1080             # 帯はカード幅いっぱい。描画 スマホ306px / PC390px → 0.283 / 0.361
S = 2                      # 2倍でレンダ→縮小（文字を締める）

# 画像内のフォントサイズ。右のコメントが iPhone375px での実効サイズ＝これが正。
# 冒頭のページ側実測値と突き合わせて決めてある。変えるときは必ず両方見ること。
COVER_HEAD = 56            # /0.310 → 17.4px（.as-name 23 と .as-h 15 のあいだ）
COVER_BODY = 40            # /0.310 → 12.4px（figcaption 12 と同じ段）
COVER_KICK = 38            # /0.310 → 11.8px
STRIP_HEAD = 46            # /0.283 → 13.0px（desktopは帯が390pxに伸びて16.6px。
                           #  どちらも .app-card-name 17 を超えないこの値にしてある）
STRIP_KICK = 34            # /0.283 →  9.6px

PAPER = (244, 242, 238)    # #F4F2EE 紙
INK = (36, 35, 33)         # #242321 墨
LINE = (214, 210, 202)     # #D6D2CA 罫
SUB = (88, 85, 79)         # 本文の補助色
GHOST = (150, 146, 138)    # いちばん淡い文字

FONT_DISP = "/Library/Fonts/AP-OTF-A1GothicStd-Bold.otf"   # 見出し（墨だまり）
FONT_NUM = "/Library/Fonts/Barlow-Bold.ttf"                # 欧文・URL
_A = "/System/Library/AssetsV2/com_apple_MobileAsset_Font7"
FONT_BODY = f"{_A}/54ef167d6c8e99a69a0d41ce252cc5995ba47580.asset/AssetData/YuGothic-Medium.otf"
FONT_BODB = f"{_A}/42062e40d643fdb5bb3fba917212352fb0690de0.asset/AssetData/YuGothic-Bold.otf"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "covers")

# make_index_icon.py / ランサーズ用バナーと同じアイソメトリック積み木
BLOCKS = (
    '<polygon points="35,46 50,53.5 35,61 20,53.5"/>'
    '<polygon points="20,53.5 35,61 35,76 20,68.5"/>'
    '<polygon points="50,53.5 35,61 35,76 50,68.5"/>'
    '<polygon points="65,46 80,53.5 65,61 50,53.5"/>'
    '<polygon points="50,53.5 65,61 65,76 50,68.5"/>'
    '<polygon points="80,53.5 65,61 65,76 80,68.5"/>'
    '<polygon points="50,24 65,31.5 50,39 35,31.5"/>'
    '<polygon points="35,31.5 50,39 50,54 35,46.5"/>'
    '<polygon points="65,31.5 50,39 50,54 65,46.5"/>'
)


def logo(px, stroke="#242321", sw=4.5):
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" '
           f'width="{px}" height="{px}"><g fill="#F4F2EE" stroke="{stroke}" '
           f'stroke-width="{sw}" stroke-linejoin="round" stroke-linecap="round">'
           f'{BLOCKS}</g></svg>')
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=px, output_height=px)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def f(path, size):
    return ImageFont.truetype(path, size * S)


def wrap(draw, text, font, max_w):
    """日本語は単語境界が無いので1文字ずつ積んで折る。約物は行頭に送らない。"""
    lines, cur = [], ""
    for ch in text:
        if draw.textlength(cur + ch, font=font) <= max_w or not cur:
            cur += ch
        else:
            # 行頭にきてはいけない文字は前の行に残す
            if ch in "。、）」』ー":
                cur += ch
                lines.append(cur)
                cur = ""
            else:
                lines.append(cur)
                cur = ch
    if cur:
        lines.append(cur)
    return lines


def save(im, W, H, path):
    flat = im.resize((W, H), Image.LANCZOS)
    flat = flat.convert("P", palette=Image.ADAPTIVE, colors=128)  # 3色設計なので減色で劣化しない
    flat.save(path, "PNG", optimize=True)
    print(f"✓ {path}  {W}x{H}  ({os.path.getsize(path) // 1024} KB)")


def strip(slug, kicker, head):
    """一覧カード用の帯（1080x270）。iPhone375px で 306x76 に描画される。

    一覧の仕事は「explanation」ではなく「recognition」なので、要点は載せない。
    キッカーと見出しだけ。載せると下の1行説明と重複するうえ、カードが縦に伸びて
    一覧が一覧でなくなる。
    """
    W, HS = W_STRIP, 270
    M = 60 * S
    im = Image.new("RGB", (W * S, HS * S), PAPER)
    d = ImageDraw.Draw(im)

    big = logo(190 * S, stroke="#E7E3DB", sw=3.8)
    im.paste(big, (W * S - big.width + 24 * S, HS * S - big.height + 20 * S), big)

    kf = f(FONT_BODB, STRIP_KICK)
    kw = d.textlength(kicker, font=kf)
    d.rectangle([M, 34 * S, M + kw + 26 * S, 34 * S + 50 * S], fill=INK)
    d.text((M + 13 * S, 43 * S), kicker, font=kf, fill=PAPER)

    y = 108 * S
    hf = f(FONT_DISP, STRIP_HEAD)
    for ln in head:
        d.text((M, y), ln, font=hf, fill=INK)
        y += 66 * S

    os.makedirs(OUT, exist_ok=True)
    save(im, W, HS, os.path.join(OUT, f"strip-{slug}.png"))


def cover(slug, kicker, head, bullets):
    """詳細ページ先頭の要約カバー。描画は スマホ300x約203px / PC380x約257px。

    ロゴ・アプリ名・URL は入れない（冒頭の「入れていないもの」参照）。
    横解像度を 1080→960 にしてあるのは、描画幅を 335→300px に縮めても
    画面上の文字サイズが変わらないようにするため（倍率 0.310→0.313 でほぼ同じ）。
    """
    W = W_COVER
    M = 64 * S
    right = (W - 64) * S
    # ⚠️ 横解像度だけ縮めても高さは縮まない（縦横比が縦長になって相殺される）。
    #    小さくしたいときは、この縦の数値も一緒に詰めること。
    KICK_TOP, HEAD_TOP, HEAD_STEP = 48, 138, 72
    LINE_H, GAP = 52, 16                       # 要点の行送りと項目間

    if len(head) > 2:
        raise ValueError(f"{slug}: 見出しは2行まで（ページの見出し階層を超える）")

    # --- 1パス目：高さを測る（余白を作りすぎないよう、中身に合わせて縦を決める） ---
    probe = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    bf = f(FONT_BODY, COVER_BODY)
    bullet_lines = [wrap(probe, b, bf, right - M - 34 * S) for b in bullets]
    rule_y = HEAD_TOP + HEAD_STEP * len(head) + 16
    bullets_top = rule_y + 36
    H = bullets_top + sum(len(ls) * LINE_H + GAP for ls in bullet_lines) + 44

    im = Image.new("RGB", (W * S, H * S), PAPER)
    d = ImageDraw.Draw(im)

    # 右下の余白に淡い積み木（紙の質感の代わり）
    # ⚠️ 縦を詰めたぶん要点の最終行に近づく。積み木は右下の隅へ逃がすこと
    big = logo(210 * S, stroke="#E7E3DB", sw=3.6)
    im.paste(big, (W * S - big.width + 55 * S, H * S - big.height + 45 * S), big)

    # キッカー（黒地の小さなラベル）
    kf = f(FONT_BODB, COVER_KICK)
    kw = d.textlength(kicker, font=kf)
    d.rectangle([M, KICK_TOP * S, M + kw + 28 * S, (KICK_TOP + 54) * S], fill=INK)
    d.text((M + 14 * S, (KICK_TOP + 10) * S), kicker, font=kf, fill=PAPER)

    # 見出し（A1ゴシック・最大2行）
    y = HEAD_TOP * S
    hf = f(FONT_DISP, COVER_HEAD)
    for ln in head:
        d.text((M, y), ln, font=hf, fill=INK)
        y += HEAD_STEP * S

    d.line([M, rule_y * S, M + 200 * S, rule_y * S], fill=LINE, width=2 * S)

    # 要点（折り返しあり）
    y = bullets_top * S
    indent = 34 * S
    for lines in bullet_lines:
        for i, ln in enumerate(lines):
            if i == 0:
                d.ellipse([M + 3 * S, y + 17 * S, M + 15 * S, y + 29 * S], fill=GHOST)
            d.text((M + indent, y), ln, font=bf, fill=SUB)
            y += LINE_H * S
        y += GAP * S

    os.makedirs(OUT, exist_ok=True)
    save(im, W, H, os.path.join(OUT, f"cover-{slug}.png"))


# ---------------------------------------------------------------- 詳細ページの要約カバー
# 文言はサイト本文とランサーズ ポートフォリオ（本人承認済み）から起こしている。
# 事実でないことは書かないこと。

cover("kouban", "舞台・稽古／スケジュール",
      ["欠席者を選ぶだけで", "「今日できる場面」が出る"],
      ["各場面の出演者を、一度だけ登録",
       "欠席をタップ → できる場面を自動抽出",
       "香盤表をA4のPDFで書き出し",
       "ブラウザだけで動く。インストール不要"])

cover("mazeiro", "美容室／ヘアカラー配合",
      ["レシピの比率から、", "必要なグラムを即計算"],
      ["比率と作りたい総量を入れるだけ",
       "2剤（オキシ）の倍率にも対応",
       "総量からの逆算もできる",
       "混ぜ間違いによる材料のロスを減らす"])

cover("credit", "経理・家計／明細の自動集計",
      ["明細CSVを読み込むだけで、", "カテゴリ別に自動集計"],
      ["CSVを放り込むと、カテゴリ別に自動集計",
       "立て替えと分割払いを切り分け",
       "「自分の実質支出」と前月比を自動算出",
       "手作業の仕分けを、ゼロにする"])

cover("dakoku", "人材派遣／勤怠・労働者用",
      ["出勤と退勤を、", "大きなボタンでタップ"],
      ["打刻はタップ1回。紙のシートが不要",
       "勤務記録と月の合計をその場で確認",
       "交通費・定期もそのまま残せる",
       "打刻はクラウドで会社と共有される"])

cover("dakoku-kanri", "人材派遣／勤怠・管理者用",
      ["現場の打刻から、", "請求算定まで一本に"],
      ["従業員ごとに打刻コードを発行するだけ",
       "全員の打刻が集まり、月度で自動集計",
       "勤怠管理表をExcel・PDFで書き出し",
       "請求算定まで、そのまま通る"])

# 看板プロダクト（趣味で制作したiOSアプリ2本）
cover("itsutsu", "iOSアプリ／動画日記",
      ["1日に5回、各2秒。", "夜、1本の動画になる"],
      ["撮るのは1回2秒。身構えずに済む",
       "5つ撮ると、今日が満ちる",
       "夜に自動で1本（最大10秒）に連結",
       "文字のない、モノクロの動画日記"])

cover("koegaki", "iOSキーボード／音声入力",
      ["話すだけで、", "整った文章になる"],
      ["マイクをタップして話すだけ",
       "AIがフィラーを消し、句読点を整える",
       "音声もAIの整形も、端末の外に出ない",
       "機内モードでも動く。月額なし"])

# 料金ページの先頭バナー
# ⚠️ 金額は入れないこと。入れると値段を直すたびに画像の再生成が要るうえ、
#    Google検索にも出ない数字が公開ページの一次情報になってしまう。約束だけを載せる。
cover("pricing", "料金について",
      ["金額は、あとから", "膨らみません。"],
      ["ヒアリングとお見積りは無料です",
       "着手後、金額は変わりません",
       "月額の縛りなし。やめても動きます",
       "ソースコード一式をお渡しします"])


# ---------------------------------------------------------------- 一覧カード用の帯
strip("kouban", "舞台・稽古／スケジュール", ["欠席者を選ぶだけで", "「今日できる場面」が出る"])
strip("mazeiro", "美容室／ヘアカラー配合", ["レシピの比率から、", "必要なグラムを即計算"])
strip("credit", "経理・家計／明細の自動集計", ["明細CSVを読むだけで、", "カテゴリ別に自動集計"])
strip("dakoku", "人材派遣／勤怠・労働者用", ["出勤と退勤を、", "大きなボタンでタップ"])
strip("dakoku-kanri", "人材派遣／勤怠・管理者用", ["現場の打刻から、", "請求算定まで一本に"])
strip("itsutsu", "iOSアプリ／動画日記", ["1日に5回、各2秒。", "夜、1本の動画になる"])
strip("koegaki", "iOSキーボード／音声入力", ["話すだけで、", "整った文章になる"])


# ---------------------------------------------------------------- index.html の寸法を同期
# 画像の縦は中身から自動で決まるので、HTML の width/height を手で書くと必ずずれる。
# ずれると読み込み中のレイアウトが跳ねる（CLS）。ここで実ファイルから書き戻す。
def sync_html():
    import re
    from PIL import Image as _Im
    path = os.path.join(ROOT, "index.html")
    html = open(path, encoding="utf-8").read()
    fixed = 0

    def repl(m):
        nonlocal fixed
        head, fname, mid, w, h, tail = m.groups()
        with _Im.open(os.path.join(OUT, fname)) as im:
            nw, nh = im.size
        if (int(w), int(h)) == (nw, nh):
            return m.group(0)
        fixed += 1
        return f'{head}{fname}{mid}width="{nw}" height="{nh}"{tail}'

    html = re.sub(
        r'(src="assets/covers/)([\w-]+\.png)(\?v=\d+"\s*\n?\s*)width="(\d+)" height="(\d+)"()',
        repl, html)
    if fixed:
        open(path, "w", encoding="utf-8").write(html)
    print(f"index.html の width/height を {fixed} 箇所そろえた")


sync_html()
