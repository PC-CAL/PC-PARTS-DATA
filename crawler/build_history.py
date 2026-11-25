# -*- coding: utf-8 -*-
"""
다나와 가격 추이 기록: 크롤링할 때마다 history/prices.json 에 가격을 덧붙임 (GitHub Pages로 공개)

- 입력: crawler/crawl_data/<카테고리>.csv (이번 크롤링) + crawler/crawl_data/codes/<카테고리>.json (줄마다 상품 코드)
- 처음 한 번(기록 파일이 없을 때)은 csv 브랜치에 남아 있는 지난 크롤링 CSV로 먼저 채움
  (지난 CSV에는 상품 코드가 없어서, 이번 크롤링의 '이름+옵션 → 코드'로 찾아 붙임)
- 묶는 기준: 다나와 상품 코드(pcode) + 옵션(용량·옵션·킷). 코드가 없으면 이름으로
- 가격이 바뀐 때만 점을 찍어 파일을 작게 유지. l = 마지막으로 가격이 있었던 회차

파일 모양:
{"v": 1, "dates": ["2026-11-24 19:23", ...],
 "items": {"SSD|12345678|1TB": {"n": "WD SN850X", "h": [[0, 135000], [3, 129000]], "l": 5}, ...}}
  h = [[회차 번호(dates의 위치), 가격], ...]
"""
import csv
import io
import json
import re
import subprocess
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent
DATA = BASE / "crawl_data"
CODES = DATA / "codes"
HIST = ROOT / "history" / "prices.json"


def log(msg):
    print(f"[가격 기록] {msg}", flush=True)


def label(r):
    return " / ".join(x for x in (str(r.get("Capacity", "")).strip(), str(r.get("Option", "")).strip(), str(r.get("Kit", "")).strip()) if x)


def price_of(r):
    d = re.sub(r"\D", "", str(r.get("Price", "")))
    return int(d) if d else 0


def read_rows(text):
    text = text.lstrip("﻿")
    return [r for r in csv.DictReader(io.StringIO(text)) if r.get("Name")]


def load_codes():
    """이번 크롤링의 (카테고리, 이름, 옵션) → 상품 코드"""
    out = {}
    if not CODES.exists():
        return out
    for f in CODES.glob("*.json"):
        cat = f.stem
        try:
            for r in json.loads(f.read_text(encoding="utf-8")):
                if r.get("Code"):
                    out[(cat, r["Name"].strip(), label(r))] = r["Code"]
        except Exception as e:
            log(f"코드 파일 읽기 실패 {f.name}: {e}")
    return out


def add_snapshot(hist, date, files, codes):
    """files: {카테고리: [CSV 줄]} 한 번의 크롤링 결과를 기록"""
    if date in hist["dates"]:
        log(f"{date} 이미 기록됨 → 건너뜀")
        return 0
    di = len(hist["dates"])
    hist["dates"].append(date)
    items, n = hist["items"], 0
    for cat, rows in files.items():
        rows = [r for r in rows if price_of(r)]
        base = lambda r: (lambda name, lab, code: f"{cat}|{code}|{lab}" if code else f"{cat}|n:{name}|{lab}")(
            r["Name"].strip(), label(r), codes.get((cat, r["Name"].strip(), label(r)), ""))
        cnt = {}
        for r in rows:
            cnt[base(r)] = cnt.get(base(r), 0) + 1
        used = set()
        for r in rows:
            p, name = price_of(r), r["Name"].strip()
            key = base(r)
            if cnt[key] > 1:   # 같은 상품 코드에 옵션이 이름에 붙어 있는 경우(그래픽카드 색상 등) → 이름까지 붙여 구분
                key = f"{key}|{name}"
            if key in used:
                continue
            used.add(key)
            e = items.setdefault(key, {"n": name, "h": []})
            e["n"] = name
            if not e["h"] or e["h"][-1][1] != p or e.get("l", di - 1) < di - 1:
                e["h"].append([di, p])   # 가격이 바뀌었거나 한동안 없다가 다시 생김
            e["l"] = di
            n += 1
    return n


def current_files():
    files = {}
    for f in sorted(DATA.glob("*.csv")):
        if ".partial" in f.name:
            continue
        files[f.stem] = read_rows(f.read_text(encoding="utf-8-sig"))
    return files


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")


def seed_from_csv_branch(hist, codes):
    """csv 브랜치의 지난 커밋들(오래된 것부터)로 기록을 채움"""
    if git("fetch", "-q", "--depth=2000", "origin", "csv:refs/remotes/origin/csv").returncode != 0:
        log("csv 브랜치 없음 → 지난 기록 없이 시작")
        return
    lg = git("log", "--reverse", "--format=%H|%cI|%s", "refs/remotes/origin/csv")
    commits = [l.split("|", 2) for l in lg.stdout.splitlines() if l.count("|") >= 2]
    log(f"지난 크롤링 {len(commits)}회 불러오는 중")
    for sha, iso, subj in commits:
        m = re.search(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2})", subj)
        date = m.group(1) if m else iso[:16].replace("T", " ")
        names = git("ls-tree", "--name-only", sha).stdout.split()
        files = {}
        for nm in names:
            if not nm.endswith(".csv"):
                continue
            show = git("show", f"{sha}:{nm}")
            if show.returncode == 0:
                files[nm[:-4]] = read_rows(show.stdout)
        cnt = add_snapshot(hist, date, files, codes)
        log(f"  {date}: {cnt}줄")


def main():
    codes = load_codes()
    files = current_files()
    if not files:
        log("이번 크롤링 CSV 없음 → 기록 안 함")
        return 0
    if HIST.exists():
        hist = json.loads(HIST.read_text(encoding="utf-8"))
    else:
        hist = {"v": 1, "dates": [], "items": {}}
        seed_from_csv_branch(hist, codes)
    date = time.strftime("%Y-%m-%d %H:%M")
    cnt = add_snapshot(hist, date, files, codes)
    coded = sum(1 for k in hist["items"] if "|n:" not in k)
    log(f"{date}: {cnt}줄 기록 · 전체 {len(hist['items'])}개 (상품 코드로 묶인 것 {coded}개) · {len(hist['dates'])}회차")
    HIST.parent.mkdir(parents=True, exist_ok=True)
    HIST.write_text(json.dumps(hist, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"파일 크기 {HIST.stat().st_size / 1024:.0f}KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
