# -*- coding: utf-8 -*-
"""
GitHub Actions(리눅스 클라우드)에서 다나와 크롤러를 돌리는 실행 파일

- danawa_crawler_core.py 는 고치지 않고, 브라우저 부분만 리눅스용 헤드리스 크롬으로 바꿔 끼움
- 결과: crawler/crawl_data/<카테고리>.csv (성공한 카테고리만 생김)
- 요약: crawler/crawl_summary.txt (워크플로가 시트 가져오기 기록에 같이 보냄)
"""
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


def main():
    import danawa_crawler_core as core
    patch_core(core)
    crawler = core.DanawaCrawler()
    only = [x for x in os.environ.get("CATEGORIES", "").split(",") if x.strip()]
    if only:
        crawler.FilterCategories(only)
    results = {}
    for cat in crawler.crawlingCategory:
        name = cat[core.STR_NAME]
        t = time.time()
        log(f"▶ {name} 시작")
        try:
            ok = bool(crawler.CrawlingCategory(cat))
        except Exception:
            traceback.print_exc(); ok = False
        results[name] = ok
        log(f"{'✔' if ok else '✘'} {name} {'완료' if ok else '실패'} ({(time.time() - t) / 60:.1f}분)")
    done = [n for n, ok in results.items() if ok]
    failed = [n for n, ok in results.items() if not ok]
    summary = f"성공 {len(done)}/{len(results)}" + (f", 실패: {', '.join(failed)} (이전 CSV 유지)" if failed else "")
    (BASE / "crawl_summary.txt").write_text(summary, encoding="utf-8")
    log("결과 · " + summary)
    return 0 if done else 1


if __name__ == "__main__":
    sys.exit(main())
