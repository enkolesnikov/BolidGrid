#!/usr/bin/env python3
"""
pdf_decode.py — извлечение текста из PDF с повреждённой картой ToUnicode
(на примере рабочей документации «ДФО .... СПС.СОУЭ», шрифт ISOCPEUR).

Зачем: у встроенного подмножества шрифта битая таблица ToUnicode, поэтому
pdftotext/pymupdf отдают «квадратики» вместо большинства кириллических букв.
Имена глифов в подмножестве при этом сохранены (`uni0410`, `A`, `two`, …),
поэтому текст восстанавливается по именам через fontTools.

Пример:
    python3 tools/pdf_decode.py "ДФО СПС.СОУЭ -г.Елизово л.pdf" -o spec.txt
    python3 tools/pdf_decode.py doc.pdf --pages 19 20 -o spec-table.txt

Зависимости: pymupdf, fonttools
    python3 -m pip install pymupdf fonttools
"""
from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

try:
    import pymupdf
    from fontTools import agl
    from fontTools.ttLib import TTFont
except ImportError as exc:  # pragma: no cover
    sys.exit(
        "Нужны зависимости pymupdf и fonttools:\n"
        "  python3 -m pip install pymupdf fonttools\n"
        f"({exc})"
    )


def load_glyph_names(font_path: Path) -> dict[int, str]:
    """GID → символ по имени глифа (uniXXXX / AGL)."""
    font = TTFont(str(font_path))
    names: dict[int, str] = {}
    for gid, name in enumerate(font.getGlyphOrder()):
        uni = agl.toUnicode(name)
        if uni:
            names[gid] = uni
    return names


def extract_embedded_font(doc: "pymupdf.Document", basefont_hint: str = "ISOCPEUR") -> Path | None:
    """Вытащить встроенный TTF из PDF во временный файл."""
    seen: set[int] = set()
    for pno in range(min(doc.page_count, 4)):
        for entry in doc.get_page_fonts(pno, full=True):
            xref, ext, _kind, basefont = entry[0], entry[1], entry[2], entry[3]
            if xref in seen:
                continue
            seen.add(xref)
            if basefont_hint.lower() not in basefont.lower():
                continue
            try:
                _name, _ext, _type, content = doc.extract_font(xref)
            except Exception:
                continue
            if not content:
                continue
            tmp = Path(tempfile.mkstemp(suffix=".ttf", prefix="embedded_")[1])
            tmp.write_bytes(content)
            return tmp
    return None


def decode_page(page: "pymupdf.Page", names: dict[int, str], font_name: str | None) -> list[str]:
    """Собрать строки по координатам спан-фрагментов."""
    spans = []
    for span in page.get_texttrace():
        chars = span.get("chars", [])
        if not chars:
            continue
        use_names = font_name is None or span.get("font") == font_name
        buf = []
        for code, gid in ((c[0], c[1]) for c in chars):
            ch = names.get(gid) if use_names else None
            if ch is None:
                ch = chr(code) if code and code != 0xFFFD else "▮"
            buf.append(ch)
        spans.append((round(span["bbox"][1]), span["bbox"][0], "".join(buf)))

    spans.sort(key=lambda t: (t[0], t[1]))
    lines: list[str] = []
    last_y = None
    parts: list[tuple[float, str]] = []
    for y, x, text in spans:
        if last_y is None or abs(y - last_y) <= 5:
            parts.append((x, text))
        else:
            parts.sort(key=lambda p: p[0])
            lines.append(f"y={last_y:4d} | " + "  «" + "||".join(t for _, t in parts) + "»")
            parts = [(x, text)]
        last_y = y
    if parts:
        parts.sort(key=lambda p: p[0])
        lines.append(f"y={last_y:4d} | " + "  «" + "||".join(t for _, t in parts) + "»")
    return lines


def main() -> int:
    ap = argparse.ArgumentParser(description="Декодирование текста PDF с битым ToUnicode по именам глифов")
    ap.add_argument("pdf", type=Path, help="входной PDF")
    ap.add_argument("-o", "--output", type=Path, help="файл результата (по умолчанию stdout)")
    ap.add_argument("--pages", type=int, nargs="*", help="номера страниц (с 1), по умолчанию все")
    ap.add_argument("--font", default="ISOCPEUR", help="какой встроенный шрифт декодировать (по умолчанию ISOCPEUR)")
    args = ap.parse_args()

    doc = pymupdf.open(str(args.pdf))
    font_path = extract_embedded_font(doc, args.font)
    if font_path is None:
        print(f"Встроенный шрифт «{args.font}» не найден — декодирование по ToUnicode", file=sys.stderr)
        names: dict[int, str] = {}
    else:
        names = load_glyph_names(font_path)
        print(f"Шрифт: {font_path.name}, глифов с именами: {len(names)}", file=sys.stderr)

    pages = [p - 1 for p in args.pages] if args.pages else list(range(doc.page_count))
    chunks: list[str] = []
    for pno in pages:
        if not 0 <= pno < doc.page_count:
            continue
        chunks.append(f"\n===== PAGE {pno + 1} =====")
        chunks.extend(decode_page(doc[pno], names, None if not names else args.font))

    text = "\n".join(chunks) + "\n"
    if args.output:
        args.output.write_text(text, encoding="utf-8")
        print(f"Записано: {args.output} ({len(text)} символов)", file=sys.stderr)
    else:
        sys.stdout.write(text)
    if font_path:
        font_path.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
