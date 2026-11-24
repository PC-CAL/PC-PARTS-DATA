# -*- coding: utf-8 -*-

import csv
import os
import re
import traceback
import sys
from datetime import datetime
from math import ceil
from time import sleep, monotonic
import json
import shutil
from pathlib import Path

from pytz import timezone
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.edge.service import Service
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import InvalidSessionIdException, WebDriverException, TimeoutException
from selenium.webdriver.support.ui import WebDriverWait, Select


CRAWLING_DATA_CSV_FILE = "CrawlingCategory.csv"
DATA_PATH = "crawl_data"
HISTORY_DATA_PATH = os.path.join(DATA_PATH, "history")

TIMEZONE = "Asia/Seoul"

EDGEDRIVER_PATH = "msedgedriver.exe"
EDGE_BINARY_PATH = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

DATA_REMARK = "//"
EXCLUDED_CATEGORIES = {"HDD"}

PAGE_SIZE = 90
MAX_PAGE_COUNT = 22
PAGE_RECOVERY_RETRY_COUNT = 3
WAIT_TIMEOUT = 25
IMPLICIT_WAIT = 5
PAGE_LOAD_TIMEOUT = 60


CORE_VERSION = "2026-10-04-new-layout-reopen"
NEW_LAYOUT_MAX_REOPEN = 0  # 0: 구 화면이면 신 화면이 나올 때까지 반복
NEW_LAYOUT_REOPEN_DELAY = 2
PAUSE_ON_ERROR = True
DIAGNOSTIC_PATH = os.path.join(DATA_PATH, "diagnostics")
OMISSION_PATH = os.path.join(DATA_PATH, "omissions")
NEW_PAGER_CSS = '[data-testid="ProductListPagination"]'
NEW_SIZE_CSS = 'select[aria-label="페이지당 아이템 개수"]'
OMISSION_COLUMNS = ["Time", "Category", "Page", "ProductId", "Name", "Option", "RawPrice", "Reason", "Detail", "EvidenceText", "ProductURL"]
JS_STATE = r"""
const items=Array.from(document.querySelectorAll('[data-testid=ProductListView] > [data-testid=ProductListItem]'));
const codes=items.map(e=>e.querySelector('[data-product-code]')?.getAttribute('data-product-code') || '');
const tabs=Array.from(document.querySelectorAll('[data-testid=ProductTabBar] [role=tab]'));
const s=document.querySelector('select[aria-label="페이지당 아이템 개수"]');
const p=document.querySelector('[data-testid=ProductListPagination]');
const b=p?.querySelector('button[aria-current=page]');
return {layout:document.querySelector('[data-testid=ProductListView],[data-testid=ProductListContainer]') ? 'new' : (document.querySelector('.main_prodlist,.list_num') ? 'old' : ''),
 size:s ? Number(s.value) : 0,count:items.length,codes,
 tabs:tabs.map(e=>({text:e.textContent.trim(),selected:e.getAttribute('aria-selected')})),
 page:b ? Number(b.textContent.trim()) : 0,
 buttons:p ? Array.from(p.querySelectorAll('button')).map(e=>({label:e.getAttribute('aria-label'),disabled:e.disabled})) : []};
"""
JS_ITEMS = r"""
const status=t=>(t||'').match(/가격\s*비교\s*예정|판매\s*준비\s*중|판매\s*중지|일시\s*품절|품절|가격\s*정보\s*없음/)?.[0] || '';
const read=(scope)=>{
 const links=Array.from(scope.querySelectorAll('a[aria-label]'));
 const a=links.find(e=>/[\d,]+\s*원\s*$/.test(e.getAttribute('aria-label')||''));
 if (a) return {price:a.querySelector('span')?.textContent.trim() || a.textContent.trim(),label:a.getAttribute('aria-label')||'',priceElementFound:true};
 const numeric=Array.from(scope.querySelectorAll('strong')).find(e=>/^\s*[\d,]+\s*원?\s*$/.test(e.textContent));
 if (numeric) return {price:numeric.textContent.trim(),label:'',priceElementFound:true};
 const marker=status(scope.innerText);
 return {price:marker,label:'',priceElementFound:!!marker};
};
return Array.from(document.querySelectorAll('[data-testid=ProductListView] > [data-testid=ProductListItem]')).map(it=>{
 const title=it.querySelector('[data-testid=ProductListTitle] a');
 const code=it.querySelector('[data-product-code]');
 const pc=it.querySelector('[data-testid=ProductListPriceCompare]');
 const rows=Array.from(it.querySelectorAll('[data-testid=ProductListPriceCompare] li')).map(li=>{
  const first=li.firstElementChild?.firstElementChild;
  const option=first && !first.querySelector('a[aria-label]') ? Array.from(first.querySelectorAll('span')).map(e=>e.textContent.trim()).filter(x=>x && !/^\d+위$/.test(x) && !status(x)).join(' ') : '';
  return {option,...read(li),evidence:(li.innerText||'').trim().slice(0,1200)};
 });
 const fallback=pc ? read(pc) : {price:'',label:'',priceElementFound:false};
 if (!fallback.price) {
   const marker=status(it.innerText);
   if (marker) {fallback.price=marker;fallback.priceElementFound=true;}
 }
 return {code:code?.getAttribute('data-product-code') || '',title:title?.textContent.trim() || '',rows,
 fallback,evidence:(it.innerText||'').trim().slice(0,1500),url:title?.href||''};
});
"""

STR_NAME = "name"
STR_URL = "url"


def extract_digits(text):
    return re.sub(r"[^\d]", "", str(text))


def safe_click(browser, locator_or_element, timeout=WAIT_TIMEOUT):
    if isinstance(locator_or_element, tuple):
        element = WebDriverWait(browser, timeout).until(
            EC.element_to_be_clickable(locator_or_element)
        )
    else:
        element = locator_or_element

    try:
        browser.execute_script(
            "arguments[0].scrollIntoView({block: 'center', inline: 'center'});",
            element,
        )
        browser.execute_script("arguments[0].click();", element)
    except Exception:
        element.click()


class OldLayoutDetected(RuntimeError):
    """구 화면에서는 수집하지 않고 브라우저를 재생성한다."""


class DanawaCrawler:
    def __init__(self):
        self.crawlingCategory = []
        self.category_seen_keys = {}

        if not os.path.exists(DATA_PATH):
            os.makedirs(DATA_PATH, exist_ok=True)

        if not os.path.exists(HISTORY_DATA_PATH):
            os.makedirs(HISTORY_DATA_PATH, exist_ok=True)

        self.LoadCategories()

    def LoadCategories(self):
        if not os.path.exists(CRAWLING_DATA_CSV_FILE):
            raise FileNotFoundError(f"{CRAWLING_DATA_CSV_FILE} 파일이 없습니다.")

        with open(CRAWLING_DATA_CSV_FILE, "r", newline="", encoding="utf-8-sig") as file:
            for row in csv.reader(file, skipinitialspace=True):
                if not row:
                    continue

                raw_name = str(row[0]).strip()
                if not raw_name or raw_name.startswith(DATA_REMARK):
                    continue

                raw_url = row[1] if len(row) > 1 else ""
                category_name = self.NormalizeCsvValue(raw_name)
                category_url = self.NormalizeUrl(raw_url)

                if not category_name or not category_url:
                    continue

                if category_name.upper() in EXCLUDED_CATEGORIES:
                    print(f"Skip Category : {category_name}")
                    continue

                self.crawlingCategory.append({
                    STR_NAME: category_name,
                    STR_URL: category_url,
                })
                self.category_seen_keys[category_name] = set()

    def NormalizeCsvValue(self, value):
        value = str(value).strip()
        value = value.replace('""', '"').strip()
        value = value.strip(",")
        value = value.strip()
        if value.startswith('"') and value.endswith('"'):
            value = value[1:-1]
        return value.strip()

    def NormalizeUrl(self, value):
        url = self.NormalizeCsvValue(value).replace('"', "").strip()
        if not url:
            return ""

        if url.startswith("https://") or url.startswith("http://"):
            return url

        if "prod.danawa.com" in url:
            return "https://" + url.replace("https://", "").replace("http://", "").lstrip("/")

        return url

    def SanitizeFilename(self, name):
        return re.sub(r'[\\/:*?"<>|]+', "_", str(name)).strip()

    def BackupExistingCsv(self, category_name):
        safe_name = self.SanitizeFilename(category_name)
        current_path = os.path.join(DATA_PATH, f"{safe_name}.csv")

        if not os.path.exists(current_path):
            return

        timestamp = self.GetCurrentDate().strftime("%Y-%m-%d_%H-%M-%S")
        backup_path = os.path.join(HISTORY_DATA_PATH, f"{safe_name}_{timestamp}.csv")

        os.replace(current_path, backup_path)
        print(f"[{category_name}] 기존 CSV 백업 완료 : {backup_path}")

    def GetCurrentDate(self):
        return datetime.now(timezone(TIMEZONE))

    def CreateBrowserWithRetry(self, category_name=None, retry_count=3, retry_delay=2):
        last_error = None

        for attempt in range(1, retry_count + 1):
            browser = None
            try:
                browser = self.CreateBrowser()
                _ = browser.current_url
                return browser
            except Exception as e:
                last_error = e
                print(f"[{category_name or 'COMMON'}] 브라우저 생성 실패 - attempt {attempt}/{retry_count} : {e}")
                if browser:
                    try:
                        browser.quit()
                    except Exception:
                        pass
                sleep(retry_delay)

        raise RuntimeError(f"브라우저 생성 최종 실패: {last_error}")


    def CreateBrowser(self):
        edge_option = webdriver.EdgeOptions()
        edge_option.page_load_strategy = "eager"
        edge_option.add_argument("--window-size=1920,1080")
        edge_option.add_argument("--disable-gpu")
        edge_option.add_argument("--lang=ko-KR")
        edge_option.add_argument("--log-level=3")
        edge_option.add_argument("--disable-dev-shm-usage")
        
        
        edge_option.add_argument("--inprivate")
        edge_option.add_experimental_option("excludeSwitches", ["enable-logging"])

        if os.path.exists(EDGE_BINARY_PATH):
            edge_option.binary_location = EDGE_BINARY_PATH

        browser = webdriver.Edge(
            service=Service(EDGEDRIVER_PATH),
            options=edge_option,
        )
        browser.implicitly_wait(IMPLICIT_WAIT)
        browser.set_page_load_timeout(PAGE_LOAD_TIMEOUT)
        return browser

    def LegacyWaitListLoaded(self, browser, timeout=WAIT_TIMEOUT):
        wait = WebDriverWait(browser, timeout)

        wait.until(EC.presence_of_element_located((By.CLASS_NAME, "list_num")))

        try:
            wait.until(
                EC.invisibility_of_element_located((By.CLASS_NAME, "product_list_cover"))
            )
        except Exception:
            pass

        wait.until(
            EC.presence_of_element_located(
                (By.XPATH, '//div[contains(@class, "main_prodlist")]//ul[contains(@class, "product_list")]/li')
            )
        )

    def LegacyGetCurrentListCount(self, browser):
        select_xpaths = [
            '//select[contains(@class, "view_count")]',
            '//select[contains(@title, "보기 개수")]',
            '//select[contains(@name, "limit")]',
            '//select[option[@value="90"]]',
        ]

        for xpath in select_xpaths:
            try:
                select_box = browser.find_element(By.XPATH, xpath)
                value = (select_box.get_attribute("value") or "").strip()
                digits = extract_digits(value)
                if digits:
                    return int(digits)

                selected_options = select_box.find_elements(By.XPATH, './/option[@selected="selected"]')
                for opt in selected_options:
                    digits = extract_digits(opt.get_attribute("value") or opt.text)
                    if digits:
                        return int(digits)
            except Exception:
                continue

        return 0

    def LegacySetPageSizeTo90(self, browser):
        last_error = None

        select_xpaths = [
            '//select[contains(@class, "view_count")]',
            '//select[contains(@title, "보기 개수")]',
            '//select[contains(@name, "limit")]',
            '//select[option[@value="90"]]',
        ]

        for xpath in select_xpaths:
            try:
                select_box = WebDriverWait(browser, WAIT_TIMEOUT).until(
                    EC.presence_of_element_located((By.XPATH, xpath))
                )

                browser.execute_script(
                    "arguments[0].scrollIntoView({block:'center', inline:'center'});",
                    select_box,
                )

                try:
                    Select(select_box).select_by_value("90")
                except Exception:
                    browser.execute_script(
                        """
                        const select = arguments[0];
                        select.value = '90';
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                        """,
                        select_box,
                    )

                self.WaitListLoaded(browser, timeout=WAIT_TIMEOUT + 5)
                sleep(0.5)

                if self.GetCurrentListCount(browser) == PAGE_SIZE:
                    return

            except Exception as e:
                last_error = e
                continue

        raise RuntimeError(f"90개 보기 설정 실패: {last_error}")

    def LegacyEnsurePageSizeTo90(self, browser):
        current_count = self.GetCurrentListCount(browser)
        if current_count == PAGE_SIZE:
            return

        self.SetPageSizeTo90(browser)

        verified_count = self.GetCurrentListCount(browser)
        print(f"[보기개수 확인] 현재 {verified_count}개")

        if verified_count != PAGE_SIZE:
            raise RuntimeError(f"90개 보기 재확인 실패: 현재 {verified_count}개 보기 상태")

    def LegacyGetCategoryTotalCount(self, browser):
        text = browser.find_element(By.CLASS_NAME, "list_num").text.strip()
        digits = extract_digits(text)
        if not digits:
            raise RuntimeError("카테고리 총 상품 수를 읽지 못했습니다.")
        return int(digits)

    def LegacyGetCurrentPageNo(self, browser):
        page_xpaths = [
            '//div[contains(@class, "number_wrap")]//*[contains(@class, "num on")]',
            '//div[contains(@class, "paging")]//*[@aria-current="page"]',
            '//div[contains(@class, "page_wrap")]//*[@aria-current="page"]',
            '//div[contains(@class, "number_wrap")]//strong[contains(@class, "num")]',
        ]

        for xpath in page_xpaths:
            try:
                text = browser.find_element(By.XPATH, xpath).text.strip()
                digits = extract_digits(text)
                if digits:
                    return int(digits)
            except Exception:
                continue

        return 1

    def LegacyGetFirstProductId(self, browser):
        try:
            product = browser.find_element(
                By.XPATH,
                '//div[contains(@class, "main_prodlist")]//ul[contains(@class, "product_list")]/li[@id]'
            )
            return (product.get_attribute("id") or "").strip()
        except Exception:
            return ""

    def LegacyMoveToPage(self, browser, target_page):
        if target_page <= 1:
            return

        old_page_no = self.GetCurrentPageNo(browser)
        old_first_product_id = self.GetFirstProductId(browser)

        try:
            try:
                browser.execute_script(
                    """
                    if (typeof movePage === 'function') {
                        movePage(arguments[0]);
                    } else {
                        throw new Error('movePage function not found');
                    }
                    """,
                    target_page,
                )
            except InvalidSessionIdException:
                raise
            except WebDriverException as e:
                if self.IsRecoverableDriverError(e):
                    raise
                pager = browser.find_element(
                    By.XPATH,
                    '//div[contains(@class, "number_wrap") or contains(@class, "paging") or contains(@class, "page_wrap")]'
                )
                target = pager.find_element(By.XPATH, f'.//a[normalize-space()="{target_page}"]')
                safe_click(browser, target)

            WebDriverWait(browser, WAIT_TIMEOUT + 5).until(
                lambda d: (
                    self.GetCurrentPageNo(d) == target_page
                    or self.GetFirstProductId(d) != old_first_product_id
                    or self.GetCurrentPageNo(d) != old_page_no
                )
            )
            self.WaitListLoaded(browser, timeout=WAIT_TIMEOUT + 5)
            sleep(0.5)
        except InvalidSessionIdException:
            raise
        except WebDriverException as e:
            if self.IsRecoverableDriverError(e):
                raise
            raise


    def RemoveRankText(self, text):
        if not text:
            return ""
        text = text.strip()
        text = re.sub(r"^\d+위\s*", "", text)
        text = re.sub(r"^\d+위\n?", "", text)
        return text.strip()

    def GetTextByXpaths(self, root, xpaths, default=""):
        for xpath in xpaths:
            try:
                text = root.find_element(By.XPATH, xpath).text.strip()
                if text:
                    return text
            except Exception:
                continue
        return default


    def NormalizeOptionText(self, option_text):
        option_text = self.RemoveRankText(option_text)
        option_parts = [x.strip() for x in option_text.split("\n") if x.strip()]
        return " / ".join(option_parts).strip()

    def BuildRowName(self, base_name, option_text):
        option_text = self.NormalizeOptionText(option_text)
        if not option_text:
            return base_name
        if option_text == base_name:
            return base_name
        return f"{base_name} | {option_text}"

    def IsCpuCategory(self, category_name):
        return str(category_name).strip().upper() == "CPU"

    def IsRamCategory(self, category_name):
        return str(category_name).strip().upper() == "RAM"

    def IsSsdCategory(self, category_name):
        return str(category_name).strip().upper() == "SSD"

    def IsColorCategory(self, category_name):
        return str(category_name).strip().upper() in {"CASE", "AIO COOLER", "AIR COOLER"}

    def SplitOptionParts(self, option_text):
        normalized = self.NormalizeOptionText(option_text)
        return [x.strip() for x in normalized.split(" / ") if x.strip()]

    def NormalizeCapacityText(self, text):
        text = re.sub(r"\s+", "", str(text).upper())
        text = text.replace("X", "*")
        return text

    def ExtractCapacityFromText(self, text):
        if not text:
            return ""

        source = str(text)
        patterns = [
            r'(\d+(?:\.\d+)?\s*(?:GB|TB)\s*[*xX]\s*\d+\s*개(?:\s*패키지)?)',
            r'(\d+(?:\.\d+)?\s*(?:GB|TB))',
        ]

        for pattern in patterns:
            match = re.search(pattern, source, flags=re.IGNORECASE)
            if match:
                return self.NormalizeCapacityText(match.group(1))

        return ""

    def ExtractRamKit(self, text):
        """램 구성: '192GB(48Gx4)', '32GB(16G×2)', '16GB*2개' → '48G*4', '16G*2'"""
        m = re.search(r'(\d+)\s*G(?:B)?\s*[xX×*]\s*(\d+)', str(text or ''))
        return f"{m.group(1)}G*{m.group(2)}" if m else ""

    def IsCapacityPart(self, part):
        return bool(self.ExtractCapacityFromText(part))


    def IsCpuOptionPart(self, part):
        return bool(self.ExtractCpuOption(part))

    def ExtractColorOption(self, text):
        if not text:
            return ""

        color_keywords = [
            "블랙", "화이트", "블루", "핑크", "그린", "레드", "옐로우", "오렌지",
            "퍼플", "실버", "그레이", "건메탈", "베이지", "아이보리", "브라운", "네이비",
        ]

        source = str(text)
        found = []
        for color in color_keywords:
            if color in source and color not in found:
                found.append(color)

        return " / ".join(found)

    def IsColorPart(self, part):
        return bool(self.ExtractColorOption(part))

    def RemoveParts(self, parts, predicate):
        remained = []
        for part in parts:
            if predicate(part):
                continue
            remained.append(part)
        return remained

    def GetCategoryColumns(self, category_name):
        upper_name = str(category_name).strip().upper()

        if upper_name == "CPU":
            return ["Name", "Option", "Price"]
        if upper_name == "RAM":
            return ["Name", "Capacity", "Price", "Kit"]
        if upper_name == "SSD":
            return ["Name", "Capacity", "Option", "Price"]
        if upper_name in {"CASE", "AIO COOLER", "AIR COOLER"}:
            return ["Name", "Option", "Price"]

        return ["Name", "Price"]

    def BuildStructuredRow(self, category_name, base_name, option_text, price):
        normalized_option = self.NormalizeOptionText(option_text)
        parts = self.SplitOptionParts(normalized_option)

        row = {
            "Name": base_name,
            "Capacity": "",
            "Option": "",
            "Color": "",
            "Price": price,
            "Kit": "",
        }

        if self.IsCpuCategory(category_name):
            row["Option"] = self.ExtractCpuOption(normalized_option)
            remained = self.RemoveParts(parts, self.IsCpuOptionPart)
            row["Name"] = self.BuildRowName(base_name, " / ".join(remained))
            return row

        if self.IsRamCategory(category_name):
            row["Capacity"] = self.ExtractCapacityFromText(f"{base_name} / {normalized_option}")
            row["Kit"] = self.ExtractRamKit(normalized_option) or self.ExtractRamKit(base_name)
            remained = self.RemoveParts(parts, self.IsCapacityPart)
            row["Name"] = self.BuildRowName(base_name, " / ".join(remained))
            return row

        if self.IsSsdCategory(category_name):
            row["Capacity"] = self.ExtractCapacityFromText(f"{base_name} / {normalized_option}")
            row["Option"] = self.ExtractCpuOption(normalized_option)
            remained = self.RemoveParts(
                parts,
                lambda x: self.IsCapacityPart(x) or self.IsCpuOptionPart(x),
            )
            row["Name"] = self.BuildRowName(base_name, " / ".join(remained))
            return row

        if self.IsColorCategory(category_name):
            row["Option"] = normalized_option.strip()
            row["Color"] = ""
            row["Name"] = base_name.strip()
            return row

        row["Name"] = self.BuildRowName(base_name, normalized_option)
        return row

    def BuildSeenKeyFromRowDict(self, row_dict):
        name = str(row_dict.get("Name", "")).strip()
        capacity = str(row_dict.get("Capacity", "")).strip()
        option = str(row_dict.get("Option", "")).strip()
        color = str(row_dict.get("Color", "")).strip()
        price = extract_digits(row_dict.get("Price", ""))
        return "|".join([name, capacity, option, color, price])

    def LegacyGetProductRows(self, browser):
        self.WaitListLoaded(browser)

        product_list_div = browser.find_element(
            By.XPATH,
            '//div[contains(@class, "main_prodlist")]'
        )

        products = product_list_div.find_elements(
            By.XPATH,
            './/ul[contains(@class, "product_list")]/li'
        )

        valid_products = []
        for product in products:
            product_id = (product.get_attribute("id") or "").strip()
            product_classes = (product.get_attribute("class") or "").split()

            if not product_id:
                continue
            if "prod_ad_item" in product_classes:
                continue
            if product_id.startswith("ad"):
                continue

            valid_products.append(product)

        return valid_products

    def LegacyExtractProductRows(self, browser, product, category_name):
        base_product_id = (product.get_attribute("id") or "").strip()

        product_name = self.GetTextByXpaths(
            product,
            [
                './div/div[2]/p/a',
                './/p/a',
                './/a',
            ],
            default="",
        ).strip()

        if not product_name:
            return base_product_id, []

        rows = []

        price_items = product.find_elements(By.XPATH, './div/div[3]/ul/li')
        for item in price_items:
            try:
                style = item.get_attribute("style") or ""
                if "display: none" in style:
                    browser.execute_script("arguments[0].style.display = 'block';", item)

                option_text = self.GetTextByXpaths(item, ['./div/p', './/div/p'], default="")
                price = self.GetPriceDigitsByXpaths(
                    item,
                    ['./p[2]/a/strong', './/p[2]//strong', './/strong'],
                )

                if not price:
                    continue

                row_data = self.BuildStructuredRow(category_name, product_name, option_text, price)
                rows.append(row_data)

            except Exception:
                continue

        if rows:
            return base_product_id, rows

        main_price = self.GetPriceDigitsByXpaths(
            product,
            [
                './/p[contains(@class, "price_sect")]//strong',
                './/div[contains(@class, "prod_pricelist")]//strong',
                './/strong[contains(@class, "num")]',
            ]
        )

        if main_price:
            row_data = self.BuildStructuredRow(category_name, product_name, "", main_price)
            rows.append(row_data)

        return base_product_id, rows

    def WriteStructuredRows(self, writer, category_name, row_data_list):
        columns = self.GetCategoryColumns(category_name)
        written_count = 0

        for row_data in row_data_list:
            dedupe_key = self.BuildSeenKeyFromRowDict(row_data)

            if dedupe_key in self.category_seen_keys[category_name]:
                continue

            self.category_seen_keys[category_name].add(dedupe_key)
            writer.writerow([row_data.get(col, "") for col in columns])
            written_count += 1

        return written_count






    def FilterCategories(self, target_categories):
        normalized_targets = []
        for value in target_categories or []:
            for part in str(value).split(","):
                name = part.strip()
                if name:
                    normalized_targets.append(name.upper())

        if not normalized_targets:
            return

        target_set = set(normalized_targets)
        self.crawlingCategory = [
            category for category in self.crawlingCategory
            if str(category.get(STR_NAME, "")).strip().upper() in target_set
        ]
        self.category_seen_keys = {
            category[STR_NAME]: self.category_seen_keys.get(category[STR_NAME], set())
            for category in self.crawlingCategory
        }




    def _State(self, browser):
        state = browser.execute_script(JS_STATE)
        if state.get('layout') == 'old':
            raise OldLayoutDetected('구 화면 감지: 신 화면이 필요합니다.')
        return state

    def IsNewLayout(self, browser):
        return self._State(browser)['layout']=='new'

    def WaitListLoaded(self, browser, timeout=WAIT_TIMEOUT):
        def probe(d):
            state=self._State(d)
            return state if state['layout'] else False
        state=WebDriverWait(browser,timeout).until(probe)
        if state['layout']=='old': return self.LegacyWaitListLoaded(browser,timeout)
        self._WaitStable(browser,timeout=timeout)

    def _WaitStable(self,browser,expected_size=None,different_from=None,timeout=WAIT_TIMEOUT):
        start=monotonic(); last=None; since=start; state={}
        while monotonic()-start<timeout:
            state=self._State(browser); signature=tuple(state['codes'])
            if signature!=last: last=signature; since=monotonic()
            valid=state['count']>0 and all(signature)
            if expected_size is not None: valid=valid and state['size']==expected_size
            if different_from is not None: valid=valid and signature!=different_from
            if valid and monotonic()-since>=1.5: return state
            sleep(0.25)
        raise TimeoutException(f"목록 대기 실패: 보기={state.get('size')}, 상품={state.get('count')}, 페이지={state.get('page')}")

    def GetCurrentListCount(self,browser):
        state=self._State(browser)
        return state['size'] if state['layout']=='new' else self.LegacyGetCurrentListCount(browser)

    def EnsurePageSizeTo90(self,browser):
        if not self.IsNewLayout(browser):
            self.LegacyEnsurePageSizeTo90(browser); self.active_page_size=self.LegacyGetCurrentListCount(browser); return
        state=self._State(browser)
        if state['size'] not in (30,60,90): raise TimeoutException('보기 개수 선택자를 찾지 못했습니다.')
        if state['size']!=PAGE_SIZE: self.SetPageSizeTo90(browser)
        state=self._WaitStable(browser)
        if state['size'] not in (30,60,90) or state['count']>state['size']: raise TimeoutException(f'보기 개수 판정 불가: {state}')
        self.active_page_size=state['size']
        print(f"[보기 확인] 설정={state['size']} / 일반상품={state['count']} / 페이지={state['page']}")

    def SetPageSizeTo90(self,browser):
        if not self.IsNewLayout(browser): return self.LegacySetPageSizeTo90(browser)
        original=self._State(browser)
        print(f"[보기 변경 전] 설정={original['size']} / 일반상품={original['count']}")
        Select(browser.find_element(By.CSS_SELECTOR,NEW_SIZE_CSS)).select_by_value(str(PAGE_SIZE))
        try:
            state=self._WaitStable(browser,expected_size=PAGE_SIZE,different_from=tuple(original['codes']))
            print(f"[보기 변경 후] 설정={state['size']} / 일반상품={state['count']}")
        except TimeoutException:
            state=self._State(browser)
            if state['size']==original['size'] and tuple(state['codes'])==tuple(original['codes']) and state['count']>0:
                print(f"[WARN] 90개 변경 미적용. 실제 {state['size']}개 보기 기준으로 진행합니다."); return
            total=self.GetCategoryTotalCount(browser,timeout=3)
            if state['size']==PAGE_SIZE and total is not None and total<=original['size'] and state['count']==total:
                self._WaitStable(browser,expected_size=PAGE_SIZE); return
            raise

    def GetCategoryTotalCount(self,browser,timeout=10):
        if not self.IsNewLayout(browser): return self.LegacyGetCategoryTotalCount(browser)
        deadline=monotonic()+timeout
        while True:
            tabs=self._State(browser)['tabs']; selected=[x for x in tabs if x['selected']=='true']
            for tab in selected or [x for x in tabs if '가격비교' in x['text']]:
                m=re.search(r'\(([\d,]+)\)',tab['text'])
                if m: return int(m.group(1).replace(',',''))
            if monotonic()>=deadline:
                print(f'[WARN] 총 상품 수 확인 불가: {tabs}. 페이지 버튼 기준 진행.'); return None
            sleep(0.25)

    def GetCurrentPageNo(self,browser):
        state=self._State(browser)
        return state['page'] if state['layout']=='new' else self.LegacyGetCurrentPageNo(browser)

    def GetFirstProductId(self,browser):
        state=self._State(browser)
        if state['layout']=='new': return state['codes'][0] if state['codes'] else ''
        return self.LegacyGetFirstProductId(browser)

    def MoveToPage(self,browser,target_page):
        if not self.IsNewLayout(browser): self.LegacyMoveToPage(browser,target_page); return True
        before=self._State(browser)
        if before['page']==target_page: return True
        for _ in range(MAX_PAGE_COUNT+2):
            state=self._State(browser)
            if state['page']==target_page:
                self._WaitStable(browser,different_from=tuple(before['codes'])); return True
            labels=[x['label'] or '' for x in state['buttons']]
            nums=[int(m.group(1)) for label in labels if (m:=re.fullmatch(r'페이지 (\d+)',label))]
            target=f'페이지 {target_page}'
            if target in labels:
                safe_click(browser,browser.find_element(By.CSS_SELECTOR,f'{NEW_PAGER_CSS} button[aria-label="{target}"]'))
                WebDriverWait(browser,WAIT_TIMEOUT).until(lambda d:self.GetCurrentPageNo(d)==target_page)
                self._WaitStable(browser,different_from=tuple(before['codes'])); return True
            if not nums: raise TimeoutException('페이지 번호 버튼이 없습니다.')
            direction='다음' if target_page>max(nums) else '이전'; label=f'{direction} 페이지 그룹'
            buttons=[x for x in state['buttons'] if x['label']==label]
            if direction=='다음' and target_page>max(nums) and state['page']==max(nums) and buttons and buttons[0]['disabled']: return False
            if not buttons or buttons[0]['disabled']: raise TimeoutException(f'페이지 {target_page} 그룹 이동 불가: {state["buttons"]}')
            safe_click(browser,browser.find_element(By.CSS_SELECTOR,f'{NEW_PAGER_CSS} button[aria-label="{label}"]'))
            WebDriverWait(browser,WAIT_TIMEOUT).until(lambda d:self._State(d)['buttons']!=state['buttons'] or self.GetCurrentPageNo(d)!=state['page'])
        raise TimeoutException(f'페이지 {target_page} 이동 한도 초과')

    def GetProductRows(self,browser):
        self.WaitListLoaded(browser)
        return browser.execute_script(JS_ITEMS) if self.IsNewLayout(browser) else self.LegacyGetProductRows(browser)

    def ParseNumericPrice(self,value):
        text=str(value or '').strip().replace('\u00a0',' ')
        match=re.fullmatch(r'([0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)\s*원?',text)
        if not match: return ''
        amount=int(match.group(1).replace(',',''))
        return str(amount) if amount>0 else ''

    def GetPriceDigitsByXpaths(self,root,xpaths):
        # 구 화면에도 가격 전체 형식 검증을 적용한다.
        return self.ParseNumericPrice(self.GetTextByXpaths(root,xpaths))

    def ExtractCpuOption(self,text):
        found=[]
        for word in ['정품 멀티팩','멀티팩 정품','멀티팩','병행수입','병행','정품','벌크','트레이','해외구매']:
            if word in str(text or '') and not any(word in old for old in found): found.append(word)
        return ' / '.join(found)

    def _StructuredNewRow(self,category_name,title,option,price):
        category=str(category_name).strip().upper()
        row=self.BuildStructuredRow(category_name,title,option,price)
        if category=='CPU': row['Name']=title; row['Option']=option or self.ExtractCpuOption(title)
        elif category=='SSD':
            row['Capacity']=self.ExtractCapacityFromText(option) or self.ExtractCapacityFromText(title)
            row['Option']=self.ExtractCpuOption(option) or self.ExtractCpuOption(title)
        elif category=='RAM':
            row['Capacity']=self.ExtractCapacityFromText(option) or self.ExtractCapacityFromText(title)
            row['Kit']=self.ExtractRamKit(option) or self.ExtractRamKit(title)
        return row

    def _PriceFailure(self,raw,found):
        if not found: return 'PRICE_ELEMENT_NOT_FOUND','가격 요소를 찾지 못함; 실제 가격 미정인지 추출 실패인지 확정할 수 없음'
        if not str(raw or '').strip(): return 'EMPTY_PRICE','가격 요소는 있으나 값이 비어 있음'
        if re.fullmatch(r'0+(?:\s*원)?',str(raw).strip()): return 'NON_POSITIVE_PRICE','0원은 유효한 판매 가격으로 저장하지 않음'
        return 'NON_NUMERIC_PRICE','읽은 값이 양의 정수 원화 가격 형식이 아님'

    def ExtractProductRows(self,browser,product,category_name):
        self._last_omissions=[]
        if not isinstance(product,dict):
            return self._ExtractLegacyWithReasons(browser,product,category_name)
        pid=product.get('code',''); title=product.get('title','').strip(); rows=[]
        base={'pid':pid,'name':title,'url':product.get('url',''),'evidence':product.get('evidence','')}
        if not title:
            self._last_omissions.append({**base,'option':'','raw':'','reason':'PRODUCT_NAME_NOT_FOUND','detail':'상품명을 찾지 못해 행을 구성할 수 없음'})
            return pid,rows
        candidates=product.get('rows') or [{**product.get('fallback',{}),'option':''}]
        for raw in candidates:
            option=re.sub(r'^\s*\d+위\s*','',raw.get('option','')).strip()
            value=raw.get('price',''); label=raw.get('label','')
            price=self.ParseNumericPrice(value)
            if not price:
                # 숫자 가격 링크의 접근성 라벨에만 제한적으로 대체 추출한다.
                m=re.search(r'(?:^|\s)([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*원\s*$',label)
                if m: price=self.ParseNumericPrice(m.group(1))
            if price:
                rows.append(self._StructuredNewRow(category_name,title,option,price)); continue
            original=str(value or label or '')
            found=raw.get('priceElementFound',bool(original))
            reason,detail=self._PriceFailure(original,found)
            self._last_omissions.append({**base,'option':option,'raw':original,'reason':reason,'detail':detail,'evidence':raw.get('evidence') or base['evidence']})
        return pid,rows

    def _ExtractLegacyWithReasons(self,browser,product,category_name):
        pid=(product.get_attribute('id') or '').strip()
        title=self.GetTextByXpaths(product,['./div/div[2]/p/a','.//p/a'])
        base={'pid':pid,'name':title,'url':'','evidence':product.text[:1500]}
        if not title:
            self._last_omissions.append({**base,'option':'','raw':'','reason':'PRODUCT_NAME_NOT_FOUND','detail':'상품명 미검출'}); return pid,[]
        rows=[]; items=product.find_elements(By.XPATH,'./div/div[3]/ul/li')
        candidates=[(item,['./p[2]/a/strong','.//p[2]//strong','.//strong']) for item in items]
        if not candidates:
            candidates=[(product,['.//p[contains(@class,"price_sect")]//strong','.//div[contains(@class,"prod_pricelist")]//strong','.//strong[contains(@class,"num")]'])]
        for item,xpaths in candidates:
            if 'display: none' in (item.get_attribute('style') or ''):
                browser.execute_script("arguments[0].style.display = 'block';",item)
            option=self.GetTextByXpaths(item,['./div/p','.//div/p']) if items else ''
            elements=[]
            for xpath in xpaths:
                elements=item.find_elements(By.XPATH,xpath)
                if elements: break
            raw=elements[0].text.strip() if elements else ''
            found=bool(elements)
            if not found:
                marker=re.search(r'가격\s*비교\s*예정|판매\s*준비\s*중|판매\s*중지|품절',item.text)
                if marker: raw=marker.group(0); found=True
            price=self.ParseNumericPrice(raw)
            if price: rows.append(self._StructuredNewRow(category_name,title,self.NormalizeOptionText(option),price))
            else:
                reason,detail=self._PriceFailure(raw,found)
                self._last_omissions.append({**base,'option':option,'raw':raw,'reason':reason,'detail':detail,'evidence':item.text[:1500]})
        return pid,rows

    def _OpenOmissionReport(self,name):
        folder=Path(OMISSION_PATH); folder.mkdir(parents=True,exist_ok=True)
        stamp=self.GetCurrentDate().strftime('%Y%m%d_%H%M%S_%f')
        self._omission_report=folder/f'{self.SanitizeFilename(name)}_missing_{stamp}.csv'
        self._omission_file=self._omission_report.open('w',newline='',encoding='utf-8-sig')
        self._omission_writer=csv.writer(self._omission_file)
        self._omission_writer.writerow(OMISSION_COLUMNS); self._omission_file.flush()
        self._omission_seen=set(); self._omission_count=0; self._omission_product_ids=set()
        print(f'[{name}] 누락 기록 파일: {self._omission_report}')

    def _RecordOmission(self,name,page,entry):
        key=tuple(str(entry.get(k,'')) for k in ['pid','name','option','raw','reason'])
        if key in self._omission_seen: return
        self._omission_seen.add(key); self._omission_count+=1
        self._omission_product_ids.add(entry.get('pid',''))
        self._omission_writer.writerow([self.GetCurrentDate().isoformat(),name,page,entry.get('pid',''),entry.get('name',''),entry.get('option',''),entry.get('raw',''),entry.get('reason',''),entry.get('detail',''),entry.get('evidence','')[:1500],entry.get('url','')])
        self._omission_file.flush()
        print(f"[{name}] 가격 행 제외: 상품={entry.get('pid')} / 옵션={entry.get('option') or '-'} / 사유={entry.get('reason')} / 원본={entry.get('raw') or '(미검출/빈 값)'}")

    def SaveDiagnostics(self,browser,name,stage,error):
        try:
            folder=Path(DIAGNOSTIC_PATH); folder.mkdir(parents=True,exist_ok=True)
            base=folder/f'{self.SanitizeFilename(name)}_{self.GetCurrentDate().strftime("%Y%m%d_%H%M%S_%f")}'
            report={'version':CORE_VERSION,'stage':stage,'error':repr(error),'traceback':traceback.format_exc()}
            if browser is not None:
                for field,getter in [('url',lambda:browser.current_url),('title',lambda:browser.title),('state',lambda:self._State(browser))]:
                    try: report[field]=getter()
                    except Exception as err: report[field]=repr(err)
                try: browser.save_screenshot(str(base)+'.png')
                except Exception as err: report['screenshot_error']=repr(err)
                try:
                    snippet=browser.execute_script(r"""
                       const selectors=['[data-testid=ProductTabBar]','select[aria-label="페이지당 아이템 개수"]','[data-testid=ProductListPagination]','[data-testid=ProductListView] > [data-testid=ProductListItem]','.list_num'];
                       return selectors.map(s=>Array.from(document.querySelectorAll(s)).slice(0,2).map(e=>e.outerHTML).join('\n')).join('\n');
                    """)
                    Path(str(base)+'.html').write_text(snippet,encoding='utf-8')
                except Exception as err: report['html_error']=repr(err)
            Path(str(base)+'.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
            print(f'[진단 저장] {base}.json (가능한 경우 PNG/부분 HTML도 저장)')
        except Exception as err: print(f'[진단 저장 실패] {err}')

    def PauseForDiagnosis(self):
        if PAUSE_ON_ERROR and sys.stdin and sys.stdin.isatty():
            try: input('[진단] Edge 화면을 확인하세요. Enter를 누르면 종료/재시도합니다...')
            except (EOFError,KeyboardInterrupt): pass

    def OpenCategoryWithRetry(self,browser,crawlingName,crawlingURL,retry_count=3,retry_delay=2):
        browser.get(crawlingURL)
        self.WaitListLoaded(browser)
        if not self.IsNewLayout(browser):
            raise TimeoutException('신 화면 구조를 확인하지 못했습니다.')
        print(f'[{crawlingName}] 구조: 신 화면')
        return browser

    def IsRecoverableDriverError(self,exc):
        if isinstance(exc,(OldLayoutDetected,InvalidSessionIdException,TimeoutException)): return True
        return any(x in str(exc).lower() for x in ['disconnected','session deleted','no such window','page crash','stale element','not connected to devtools'])

    def RecoverCategoryBrowser(self,browser,crawlingName,crawlingURL):
        if browser is not None:
            try: browser.quit()
            except Exception: pass
        self._active_browser = None
        old_count = 0
        error_count = 0
        while True:
            b = None
            try:
                b = self.CreateBrowserWithRetry(crawlingName)
                self._active_browser = b
                self.OpenCategoryWithRetry(b,crawlingName,crawlingURL)
                self.EnsurePageSizeTo90(b)
                if old_count:
                    print(f'[{crawlingName}] 신 화면 확보: 구 화면 {old_count}회 종료 후 수집 진행')
                return b
            except OldLayoutDetected as error:
                old_count += 1
                exhausted = NEW_LAYOUT_MAX_REOPEN > 0 and old_count >= NEW_LAYOUT_MAX_REOPEN
                print(f'[{crawlingName}] 구 화면 감지 ({old_count}회). 크롤러 Edge 종료.')
                if exhausted:
                    self.SaveDiagnostics(b,crawlingName,'신 화면 확보 제한 도달',error)
                if b is not None:
                    try: b.quit()
                    except Exception: pass
                self._active_browser = None
                if exhausted:
                    raise RuntimeError(f'신 화면 확보 실패: 구 화면 {old_count}회. 원본 CSV 보존.') from error
                print(f'[{crawlingName}] {NEW_LAYOUT_REOPEN_DELAY}초 후 새 Edge로 다시 접속합니다.')
                sleep(NEW_LAYOUT_REOPEN_DELAY)
            except Exception as error:
                error_count += 1
                self.SaveDiagnostics(b,crawlingName,f'시작 준비 오류 {error_count}',error)
                if not self.IsRecoverableDriverError(error) or error_count >= PAGE_RECOVERY_RETRY_COUNT:
                    self._active_browser = b
                    raise
                print(f'[{crawlingName}] 준비 오류 재시도 {error_count}/{PAGE_RECOVERY_RETRY_COUNT}: {type(error).__name__}')
                self.PauseForDiagnosis()
                if b is not None:
                    try: b.quit()
                    except Exception: pass
                self._active_browser = None
                sleep(2)

    def CrawlingCategory(self,categoryValue):
        name=categoryValue[STR_NAME]; url=categoryValue[STR_URL]
        print(f'Crawling Start : {name}')
        browser=None; output=None; partial=None
        self._active_browser=None; self._omission_file=None
        self.category_seen_keys[name]=set()
        ids=set(); written=0; skipped_products=0
        try:
            self._OpenOmissionReport(name)
            browser=self.RecoverCategoryBrowser(None,name,url)
            total=self.GetCategoryTotalCount(browser); size=self.active_page_size
            pages=min(ceil(total/size),MAX_PAGE_COUNT) if total is not None else MAX_PAGE_COUNT
            print(f'[{name}] 상품 수={total if total is not None else "미확인"} / 실제 보기={size} / 최대 {pages}페이지')
            safe=self.SanitizeFilename(name)
            partial=os.path.join(DATA_PATH,f'{safe}.{os.getpid()}.partial.csv')
            output=open(partial,'w',newline='',encoding='utf-8-sig')
            writer=csv.writer(output); writer.writerow(self.GetCategoryColumns(name)); end=False
            for page in range(1,pages+1):
                attempt = 0
                while True:
                    try:
                        if not self.MoveToPage(browser,page):
                            if total is not None: raise RuntimeError(f'예상 {pages}페이지인데 {page}페이지가 없습니다.')
                            end=True; break
                        if self.GetCurrentListCount(browser)!=size: raise TimeoutException('실행 중 보기 개수가 바뀌었습니다.')
                        products=self.GetProductRows(browser)
                        if not products: raise TimeoutException('일반 상품이 없습니다.')
                        print(f'[{name}] {page}/{pages} page / 일반상품 {len(products)}')
                        for product in products:
                            pid,rows=self.ExtractProductRows(browser,product,name)
                            if pid and pid in ids: continue
                            if not pid: raise RuntimeError('상품 번호 미검출: 목록 구조를 확인해야 합니다.')
                            for omitted in self._last_omissions: self._RecordOmission(name,page,omitted)
                            if not rows:
                                skipped_products+=1
                                if not self._last_omissions:
                                    self._RecordOmission(name,page,{'pid':pid,'name':product.get('title','') if isinstance(product,dict) else '', 'reason':'NO_VALID_PRICE_ROW','detail':'저장 가능한 가격 행 없음','raw':'','option':''})
                            else: written+=self.WriteStructuredRows(writer,name,rows)
                            ids.add(pid)
                        output.flush(); break
                    except OldLayoutDetected:
                        print(f'[{name}] 페이지 {page}에서 구 화면 감지. 새 Edge로 신 화면 확보 후 같은 페이지를 재개합니다.')
                        browser=self.RecoverCategoryBrowser(browser,name,url)
                        if self.active_page_size!=size: raise RuntimeError('복구 후 보기 개수가 바뀌었습니다. 원본 CSV 보존.')
                    except Exception as error:
                        self.SaveDiagnostics(browser,name,f'페이지 {page}',error)
                        if not self.IsRecoverableDriverError(error) or attempt>=PAGE_RECOVERY_RETRY_COUNT: raise
                        attempt += 1
                        print(f'[{name}] 페이지 {page} 복구 {attempt}/{PAGE_RECOVERY_RETRY_COUNT}')
                        browser=self.RecoverCategoryBrowser(browser,name,url)
                        if self.active_page_size!=size: raise RuntimeError('복구 후 보기 개수가 바뀌었습니다. 원본 CSV 보존.')
                if end: break
            if written==0: raise RuntimeError('유효한 숫자 가격이 한 건도 없습니다. 원본 CSV 보존; 누락 CSV 확인.')
            output.close(); output=None
            current=os.path.join(DATA_PATH,f'{safe}.csv')
            if os.path.exists(current):
                stamp=self.GetCurrentDate().strftime('%Y-%m-%d_%H-%M-%S_%f')
                backup=os.path.join(HISTORY_DATA_PATH,f'{safe}_{stamp}.csv'); shutil.copy2(current,backup)
                print(f'[{name}] 기존 CSV 백업 완료 : {backup}')
            os.replace(partial,current)
            if total is None and not end: print(f'[WARN] 총수 미확인 / {MAX_PAGE_COUNT}페이지 제한. 전체 수집 보장 불가.')
            elif total is not None and total>MAX_PAGE_COUNT*size: print(f'[WARN] 페이지 제한으로 뒤쪽 상품은 수집하지 않았습니다: 총 {total}, 확인 {len(ids)}')
            print(f'[{name}] 완료: 확인 상품 {len(ids)}, 저장 {written}행 / 전체 제외 상품 {skipped_products}개 / 누락 가격 행 {self._omission_count}개')
            if self._omission_count:
                print(f'[{name}] WARN: 가격 누락 포함. 사유와 원본 문구를 누락 CSV에서 확인하세요.')
            return True
        except Exception as error:
            print(f'Error - {name}\n{traceback.format_exc()}')
            self.SaveDiagnostics(self._active_browser or browser,name,'최종 실패',error)
            if partial: print(f'[부분 결과] {partial} (공식 CSV로 교체하지 않음)')
            print('[보호] 기존 카테고리 CSV는 변경하지 않았습니다.')
            self.PauseForDiagnosis(); return False
        finally:
            if output is not None: output.close()
            if self._omission_file is not None:
                self._omission_file.close()
                print(f'[{name}] 누락 CSV 보존: {self._omission_report} (중단 실행이면 중단 전 확인분만 포함)')
            active=self._active_browser or browser
            if active is not None:
                try: active.quit()
                except Exception: pass
            self._active_browser=None; print(f'Crawling Finish : {name}')

    def StartCrawling(self):
        ok=True
        for category in self.crawlingCategory: ok=bool(self.CrawlingCategory(category)) and ok
        return ok


def run_selected_categories(target_categories=None):
    crawler = DanawaCrawler()
    target_categories = list(target_categories or [])
    crawler.FilterCategories(target_categories)

    if target_categories and not crawler.crawlingCategory:
        print("[ERROR] 요청한 카테고리를 찾지 못했습니다.")
        return 1

    if crawler.crawlingCategory:
        selected = ", ".join(category[STR_NAME] for category in crawler.crawlingCategory)
        print(f"Selected Categories : {selected}")

    print(f"Core Version : {CORE_VERSION}")
    return 0 if crawler.StartCrawling() else 1


if __name__ == "__main__":
    sys.exit(run_selected_categories(sys.argv[1:]))
