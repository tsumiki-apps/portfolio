# -*- coding: utf-8 -*-
"""アプリ詳細ページの先頭に置く「要約カバー」を つみきの紙×墨で生成する。

  実行: DYLD_LIBRARY_PATH=/opt/homebrew/lib python3 tools/make_app_covers.py
  出力: assets/covers/cover-<app>.png

## なぜ横1080pxで、なぜ文字がこんなに大きいのか

ランサーズ用のバナーは 1220x686（16:9）で本文19px。あれは一覧で小さく出て
から拡大される前提なので成立していたが、**サイトの本文に置くと iPhone で潰れる**。
iPhone（横375px）ではシート本文の幅が約335px しかないため、

    画面上の文字サイズ = 画像内の文字サイズ x (335 / 画像の横幅)

16:9・幅1220 なら倍率 0.27 で、本文19px は **画面上5px**。読めない。
そこで本文の下限を13px と決め、幅1080 の倍率 0.31 から逆算して

    本文 42px / 見出し 65px / キッカー 34px

を下限にしている。**この数字を小さくすると iPhone で読めなくなる**ので、
文字を増やしたくなったら「サイズを下げる」のではなく「言葉を削る」こと。
縦は固定せず、中身（見出しの行数＋要点の行数）から算出している。16:9 に
戻すとこの文字サイズでは入りきらない。

## 実機スクショを入れていない理由
アプリ詳細ページには「プレビュー」節にスマホ実機のスクショが既に10枚ある。
カバーにも実機を置くと重複し、そのぶん文字が小さくなる。ここは文字に振る。
"""
import io
import os

import cairosvg
from PIL import Image, ImageDraw, ImageFont

W = 1080                   # 横幅。iPhone で本文13px を確保できる最小値（下記の計算）
BULLETS_TOP = 626          # 要点の1行目の y（見出し2行＋罫線の下）
S = 2                      # 2倍でレンダ→縮小（文字を締める）
# 縦は中身に合わせて自動で決まる（余白を作りすぎないため）。
# 現行の5枚は 見出し2行＋要点4行 なので、いずれも 1080x1154 前後になる。

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


def cover(slug, kicker, appname, head, bullets):
    M = 88 * S
    right = (W - 88) * S

    # --- 1パス目：高さを測る（余白を作りすぎないよう、中身に合わせて縦を決める） ---
    probe = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    bf = f(FONT_BODY, 42)
    bullet_lines = [wrap(probe, b, bf, right - M - 40 * S) for b in bullets]
    body_end = (BULLETS_TOP * S
                + sum(len(ls) * 60 * S + 22 * S for ls in bullet_lines))
    H = (body_end + 200 * S) // S          # 要点の下端＋フッター帯
    if len(head) > 2:
        raise ValueError(f"{slug}: 見出しは2行まで（iPhoneで潰れる）")

    im = Image.new("RGB", (W * S, H * S), PAPER)
    d = ImageDraw.Draw(im)

    # 右下の余白に淡い積み木（紙の質感の代わり。pkgバナーと同じ手）
    # ⚠️ 要点と重なると読みにくくなるので、要点の下端より下から始める
    big = logo(400 * S, stroke="#E7E3DB", sw=3.0)
    im.paste(big, (W * S - big.width + 55 * S, H * S - big.height + 45 * S), big)

    # 上部：ロゴ＋屋号
    mark = logo(52 * S, sw=6.5)
    im.paste(mark, (M, 78 * S), mark)
    d.text((M + 64 * S, 88 * S), "つみき", font=f(FONT_DISP, 24), fill=INK)
    d.text((M + 64 * S, 120 * S), "TSUMIKI", font=f(FONT_NUM, 12), fill=GHOST)

    # キッカー（黒地の小さなラベル）
    kf = f(FONT_BODB, 22)
    kw = d.textlength(kicker, font=kf)
    d.rectangle([M, 200 * S, M + kw + 32 * S, 200 * S + 50 * S], fill=INK)
    d.text((M + 16 * S, 210 * S), kicker, font=kf, fill=PAPER)

    # アプリ名
    d.text((M, 288 * S), appname, font=f(FONT_BODB, 30), fill=SUB)

    # 見出し（A1ゴシック・最大2行）
    y = 366 * S
    hf = f(FONT_DISP, 65)
    for ln in head:
        d.text((M, y), ln, font=hf, fill=INK)
        y += 90 * S

    # 罫線
    y += 22 * S
    d.line([M, y, M + 240 * S, y], fill=LINE, width=2 * S)

    # 要点（折り返しあり）
    y = BULLETS_TOP * S
    indent = 40 * S
    for lines in bullet_lines:
        for i, ln in enumerate(lines):
            if i == 0:
                d.ellipse([M + 4 * S, y + 20 * S, M + 17 * S, y + 33 * S], fill=GHOST)
            d.text((M + indent, y), ln, font=bf, fill=SUB)
            y += 60 * S
        y += 22 * S

    # フッター
    d.text((M, (H - 110) * S), "tsumiki-apps.com", font=f(FONT_NUM, 30), fill=GHOST)

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"cover-{slug}.png")
    flat = im.resize((W, H), Image.LANCZOS)
    flat = flat.convert("P", palette=Image.ADAPTIVE, colors=128)  # 3色設計なので減色で劣化しない
    flat.save(path, "PNG", optimize=True)
    print(f"✓ {path}  ({os.path.getsize(path) // 1024} KB)")


# ---------------------------------------------------------------- 5枚
# 文言はサイト本文とランサーズ ポートフォリオ（本人承認済み）から起こしている。
# 事実でないことは書かないこと。

cover("kouban", "舞台・稽古／スケジュール", "香盤メーカー",
      ["欠席者を選ぶだけで", "「今日できる場面」が出る"],
      ["各場面の出演者を、一度だけ登録",
       "欠席をタップ → できる場面を自動抽出",
       "香盤表をA4のPDFで書き出し",
       "ブラウザだけで動く。インストール不要"])

cover("mazeiro", "美容室／ヘアカラー配合", "まぜいろ",
      ["レシピの比率から、", "必要なグラムを即計算"],
      ["比率と作りたい総量を入れるだけ",
       "2剤（オキシ）の倍率にも対応",
       "総量からの逆算もできる",
       "混ぜ間違いによる材料のロスを減らす"])

cover("credit", "経理・家計／明細の自動集計", "クレカ明細",
      ["明細CSVを読み込むだけで、", "カテゴリ別に自動集計"],
      ["CSVを放り込むと、カテゴリ別に自動集計",
       "立て替えと分割払いを切り分け",
       "「自分の実質支出」と前月比を自動算出",
       "手作業の仕分けを、ゼロにする"])

cover("dakoku", "人材派遣／勤怠・労働者用", "打刻",
      ["出勤と退勤を、", "大きなボタンでタップ"],
      ["打刻はタップ1回。紙のシートが不要",
       "自分の勤務記録と月の合計をその場で確認",
       "交通費・定期もそのまま残せる",
       "打刻はクラウドで会社と共有される"])

cover("dakoku-kanri", "人材派遣／勤怠・管理者用", "打刻管理",
      ["現場の打刻から、", "請求算定まで一本に"],
      ["従業員ごとに打刻コードを発行するだけ",
       "全員の打刻が集まり、月度で自動集計",
       "勤怠管理表をExcel・PDFで書き出し",
       "請求算定まで、そのまま通る"])
