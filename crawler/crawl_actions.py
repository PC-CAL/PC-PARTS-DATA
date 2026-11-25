# -*- coding: utf-8 -*-
"""
GitHub Actions(리눅스 클라우드)에서 다나와 크롤러를 돌리는 실행 파일

- danawa_crawler_core.py 는 고치지 않고, 브라우저 부분만 리눅스용 헤드리스 크롬으로 바꿔 끼움
- 결과: crawler/crawl_data/<카테고리>.csv (성공한 카테고리만 생김)
- 요약: crawler/crawl_summary.txt (워크플로가 시트 가져오기 기록에 같이 보냄)
- 상품 코드: crawler/crawl_data/codes/<카테고리>.json (CSV 줄마다 다나와 상품 코드, 가격 추이 기록용)
  CSV 양식은 그대로 둠 (시트 가져오기에 영향 없음)
"""
import json
import re
import os
import sys
import time
import traceback
from pathlib import Path

MAX_OLD_LAYOUT = 30   # 구 화면이 이만큼 연속으로 나오면 그 카테고리는 실패 처리 (원래 코드는 무한 반복)

BASE = Path(__file__).resolve().parent
os.chdir(BASE)
sys.path.insert(0, str(BASE))


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def patch_core(core):
    from selenium import webdriver

    core.PAUSE_ON_ERROR = False
    core.NEW_LAYOUT_MAX_REOPEN = MAX_OLD_LAYOUT

    def create_browser(self):
        opt = webdriver.ChromeOptions()
        opt.page_load_strategy = "eager"
        for a in ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
                  "--window-size=1920,1080", "--lang=ko-KR", "--log-level=3", "--incognito"]:
            opt.add_argument(a)
        opt.add_experimental_option("prefs", {"intl.accept_languages": "ko-KR,ko"})
        opt.add_experimental_option("excludeSwitches", ["enable-logging"])
        browser = webdriver.Chrome(options=opt)   # 셀레니움이 크롬 버전에 맞는 드라이버를 알아서 씀
        try:
            # 헤드리스 표시(HeadlessChrome)를 지우고 한국 시간대로 접속
            ua = browser.execute_script("return navigator.userAgent").replace("HeadlessChrome", "Chrome")
            browser.execute_cdp_cmd("Network.setUserAgentOverride", {"userAgent": ua, "acceptLanguage": "ko-KR,ko"})
            browser.execute_cdp_cmd("Emulation.setTimezoneOverride", {"timezoneId": "Asia/Seoul"})
        except Exception as e:
            log(f"브라우저 설정 일부 실패(무시): {e}")
        browser.implicitly_wait(core.IMPLICIT_WAIT)
        browser.set_page_load_timeout(core.PAGE_LOAD_TIMEOUT)
        return browser

    core.DanawaCrawler.CreateBrowser = create_browser

    # 가격 추이용: CSV에 쓴 줄마다 다나와 상품 코드(pcode)를 따로 모아 둠
    orig_extract = core.DanawaCrawler.ExtractProductRows
    orig_write = core.DanawaCrawler.WriteStructuredRows

    def extract(self, browser, product, category_name):
        pid, rows = orig_extract(self, browser, product, category_name)
        code = re.sub(r"\D", "", str(pid or ""))
        for r in rows:
            r["_code"] = code
        return pid, rows

    def write(self, writer, category_name, rows):
        n = 0
        bucket = self._codes.setdefault(category_name, [])
        for r in rows:
            w = orig_write(self, writer, category_name, [r])
            if w:
                bucket.append({k: str(r.get(k, "")).strip() for k in ("Name", "Capacity", "Option", "Kit")} | {"Code": r.get("_code", "")})
            n += w
        return n

    core.DanawaCrawler.ExtractProductRows = extract
    core.DanawaCrawler.WriteStructuredRows = write


def save_codes(crawler, name):
    rows = crawler._codes.get(name, [])
    seen, out = set(), []
    for r in reversed(rows):   # 다시 시도한 경우 마지막 것만
        k = (r["Name"], r["Capacity"], r["Option"], r["Kit"])
        if k in seen:
            continue
        seen.add(k); out.append(r)
    folder = BASE / "crawl_data" / "codes"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{crawler.SanitizeFilename(name)}.json").write_text(json.dumps(out[::-1], ensure_ascii=False), encoding="utf-8")


def main():
    import danawa_crawler_core as core
    patch_core(core)
    crawler = core.DanawaCrawler()
    crawler._codes = {}
    only = [x for x in os.environ.get("CATEGORIES", "").split(",") if x.strip()]
    if only:
        crawler.FilterCategories(only)
    results = {}
    for cat in crawler.crawlingCategory:
        name = cat[core.STR_NAME]
        t = time.time()
        crawler._codes[name] = []
        log(f"▶ {name} 시작")
        try:
            ok = bool(crawler.CrawlingCategory(cat))
        except Exception:
            traceback.print_exc(); ok = False
        results[name] = ok
        if ok:
            try:
                save_codes(crawler, name)
            except Exception:
                traceback.print_exc()   # 코드 저장 실패는 크롤링 결과에 영향 없음
        log(f"{'✔' if ok else '✘'} {name} {'완료' if ok else '실패'} ({(time.time() - t) / 60:.1f}분)")
    done = [n for n, ok in results.items() if ok]
    failed = [n for n, ok in results.items() if not ok]
    summary = f"성공 {len(done)}/{len(results)}" + (f", 실패: {', '.join(failed)} (이전 CSV 유지)" if failed else "")
    (BASE / "crawl_summary.txt").write_text(summary, encoding="utf-8")
    log("결과 · " + summary)
    return 0 if done else 1


if __name__ == "__main__":
    sys.exit(main())
