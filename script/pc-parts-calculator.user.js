// ==UserScript==
// @name         완본체 부품 계산기
// @namespace    https://docs.google.com/spreadsheets/d/1BzS5KSx11k-oaLxc37x33lahjWviZfCqObnbBw54D0I
// @version      0.20.7
// @description  완본체 판매 페이지의 사양표를 OCR로 읽어 '완본체 부품리스트&계산기' 시트에서 부품 스펙과 다나와 최저가를 찾아 견적표로 만들어 줍니다.
// @license      MIT
// @match        *://*/*
// @noframes
// @require      https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      pc-cal.github.io
// @connect      docs.google.com
// @connect      googleusercontent.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

// ===== 핵심 로직: 데이터 읽기, 가격 연결, 검색 =====
const PCC = (() => {
  const SHEET_ID = '1BzS5KSx11k-oaLxc37x33lahjWviZfCqObnbBw54D0I';
  const SUMMARY_TAB = '확장 데이터';
  const FALLBACK_GIDS = {
    'CPU': '637254067', '메인보드': '120717471', 'RAM': '1508344536', '그래픽카드': '266339529',
    'SSD': '1124278766', '파워서플라이': '283513265', '케이스': '305915409', 'CPU쿨러': '383033569',
    '확장 데이터': '1036540381'
  };
  // 부품 탭별 풀네임 열 위치(0부터), 별명 열은 그 다음 칸
  const PARTS = [
    { cat: 'CPU', nameCol: 1 },
    { cat: '메인보드', nameCol: 3 },
    { cat: 'RAM', nameCol: 2 },
    { cat: '그래픽카드', nameCol: 3 },
    { cat: 'SSD', nameCol: 1 },
    { cat: '파워서플라이', nameCol: 2 },
    { cat: '케이스', nameCol: 1 },
    { cat: 'CPU쿨러', nameCol: 1 }
  ];

  function parseCsv(text) {
    const rows = []; let row = []; let field = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  const num = s => { const d = String(s || '').replace(/[^\d.-]/g, ''); return d === '' ? null : Number(d); };
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

  async function loadGids(fetchText) {
    try {
      const html = await fetchText(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/htmlview`);
      const map = {};
      for (const m of html.matchAll(/name:\s*"((?:[^"\\]|\\.)*)"[^}]*?gid:\s*"(\d+)"/g)) {
        map[JSON.parse('"' + m[1] + '"')] = m[2];
      }
      return Object.keys(map).length ? { ...FALLBACK_GIDS, ...map } : FALLBACK_GIDS;
    } catch (e) { return FALLBACK_GIDS; }
  }

  const exportUrl = gid => `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 요청 하나: 429(요청 과다)·일시 오류면 기다렸다 다시 시도
  async function fetchWithRetry(fetchText, url, onWait) {
    const waits = [3000, 8000, 20000];
    for (let i = 0; ; i++) {
      try { return await fetchText(url); }
      catch (e) {
        const retryable = /HTTP (429|5\d\d)|네트워크 오류|시간 초과/.test(e.message);
        if (!retryable || i >= waits.length) throw e;
        if (onWait) onWait(Math.round(waits[i] / 1000));
        await sleep(waits[i]);
      }
    }
  }

  // 원본에서 필요한 탭을 하나씩 순서대로 받음. 이미 받은 탭(prev)은 건너뜀
  async function fetchAll(fetchText, opts = {}) {
    const { prev = {}, onProgress, onWait } = opts;
    let gids = FALLBACK_GIDS;
    const names = [SUMMARY_TAB, ...PARTS.map(p => p.cat)];
    const raw = { ...prev };
    let done = names.filter(n => raw[n]).length;
    for (const n of names) {
      if (raw[n]) continue;
      if (onProgress) onProgress(done, names.length, n);
      try {
        raw[n] = await fetchWithRetry(fetchText, exportUrl(gids[n]), onWait);
      } catch (e) {
        // 탭 번호가 바뀐 경우: 탭 목록을 한 번 다시 읽고 재시도
        if (/HTTP (400|404)/.test(e.message) && gids === FALLBACK_GIDS) {
          gids = await loadGids(fetchText);
          raw[n] = await fetchWithRetry(fetchText, exportUrl(gids[n]), onWait);
        } else {
          const err = new Error(e.message); err.partial = raw; throw err;
        }
      }
      done++;
      await sleep(400);
    }
    return raw;
  }

  // 시트 규칙 표가 비어 있을 때 쓰는 기본값 (계산기 함수와 같은 규칙)
  const DEFAULT_RULES = {
    strip: {
      'RAM': '\\s+(서린|파인인포|코잇|대원씨티에스|아스크텍|올로코리아|제이씨현|디앤디컴|아인스시스템|컴이지|대양케이스)\\s*$',
      'CPU쿨러': '\\s(서린|3RSYS|데이븐|마이크로닉스|브라보텍|대원씨티에스|인텍앤컴퍼니|피씨디렉트|아이보라|STCOM|벌크|해외구매)$',
      'SSD': '\\s+\\d+(?:\\.\\d+)?\\s*(?:TB|GB)\\s*$'
    },
    // 판매 페이지의 모호한 이름 → 실제 제품명 (시트 규칙 표의 '별칭'으로 추가 가능)
    aliases: [['LEXAR PCIe Gen4 NVMe 1TB SSD', 'Lexar NM790 M.2 NVMe 1TB']]
  };

  function buildRules(sum) {
    const rules = {
      version: '', priceDate: '',
      strip: Object.fromEntries(Object.entries(DEFAULT_RULES.strip).map(([k, v]) => [k, new RegExp(v)])),
      aliases: DEFAULT_RULES.aliases.map(([a, b]) => [a.toLowerCase(), b])
    };
    rules.version = norm(sum[0] && sum[0][6]);
    rules.priceDate = norm(sum[1] && sum[1][6]);
    for (const r of sum) {
      const cat = norm(r[5]), key = norm(r[6]), val = String(r[7] || '').trim();
      if (!cat || !val) continue;
      if (key === '이름에서 지울 패턴') { try { rules.strip[cat] = new RegExp(val); } catch (e) {} }
      else if (key === '별칭') { const [from, to] = val.split(/\s*=>\s*/); if (from && to) rules.aliases.push([from.toLowerCase().replace(/\s+/g, ' ').trim(), to]); }
    }
    return rules;
  }

  const KO_EN = [['라이젠', 'ryzen'], ['라데온', 'radeon'], ['지포스', 'geforce'], ['쿨러마스터', 'coolermaster cooler master'], ['잘만', 'zalman'],
    ['씨게이트', 'seagate'], ['키오시아', 'kioxia'], ['삼성전자', 'samsung'], ['마이크로닉스', 'micronics'], ['시소닉', 'seasonic'], ['커세어', 'corsair'],
    ['기가바이트', 'gigabyte'], ['아수스', 'asus'], ['애즈락', 'asrock'], ['인텔', 'intel'], ['코어 울트라', 'core ultra'], ['코어i', 'core i'], ['딥쿨', 'deepcool'],
    ['리안리', 'lianli lian li'], ['앱코', 'abko'], ['다크플래쉬', 'darkflash'], ['에센코어', 'essencore'], ['웨스턴디지털', 'wd'], ['마이크론', 'micron'], ['크루셜', 'crucial'],
    ['하이닉스', 'hynix'], ['슈퍼플라워', 'superflower'], ['에너지옵티머스', 'energy optimus'], ['화이트', 'white'], ['블랙', 'black'], ['벤전스', 'vengeance'], ['렉사', 'lexar'], ['써멀라이트', 'thermalright'], ['에이서', 'acer'],
    ['프레데터', 'predator'], ['지스킬', 'g.skill'], ['팀그룹', 'teamgroup'], ['하이트', 'hyte'], ['리버스', 'reverse'], ['스노우', 'snow'], ['킹덤', 'kingdom'], ['갤럭시', 'galax'], ['조텍', 'zotac']];
  const toEnglish = s => { let o = s; for (const [k, e] of KO_EN) o = o.split(k).join(e); return o === s ? '' : o; };

  function buildDb(raw) {
    const sum = parseCsv(raw[SUMMARY_TAB]);
    const rules = buildRules(sum);
    // 최저가 표: price[분류][이름][옵션] = 가격
    const price = {};
    const kits = {};   // 램 구성: kits[이름][용량] = '48G*4' (다나와 옵션의 "(48Gx4)", 확장 데이터 RAM구성 묶음)
    for (const r of sum.slice(1)) {
      if (norm(r[0]) === 'RAM구성') { const n = norm(r[1]), o = norm(r[2]), k = norm(r[3]); if (n && o && k) (kits[n] ||= {})[o] = k; continue; }
      const cat = norm(r[0]), name = norm(r[1]), opt = norm(r[2]), p = num(r[3]);
      if (!cat || !name || p === null) continue;
      ((price[cat] ||= {})[name] ||= {})[opt] = p;
    }
    const strip = (cat, s) => rules.strip[cat] ? norm(String(s).replace(rules.strip[cat], '')) : norm(s);

    const items = [];
    for (const part of PARTS) {
      const rows = parseCsv(raw[part.cat]);
      const header = (rows[0] || []).map(norm);
      const col = h => header.findIndex(x => x === h);
      const cols = {
        link: header.findIndex(x => x.includes('다나와')),
        note: col('비고'), perf: col('성능'), rec: col('추천'),
        issue: col('이슈'), plus: header.findIndex(x => x.startsWith('가점')),
        minus: header.findIndex(x => x.startsWith('감점')), warranty: col('보증 기간')
      };
      const special = new Set([part.nameCol, part.nameCol + 1, ...Object.values(cols)].filter(i => i >= 0));
      const specCols = header.map((h, i) => i).filter(i => header[i] && !special.has(i));
      const carry = [];   // 제품명 왼쪽 열(소켓·칩셋·분류 등)은 그룹 첫 행에만 있어서 위 값을 이어받음
      for (const r of rows.slice(2)) {
        for (let ci = 0; ci < part.nameCol; ci++) { if (norm(r[ci])) carry[ci] = norm(r[ci]); else if (norm(r[part.nameCol])) r[ci] = carry[ci] || ''; }
        const name = norm(r[part.nameCol]);
        if (!name || name === header[part.nameCol]) continue;
        const get = i => (i >= 0 ? norm(r[i]) : '');
        const it = {
          cat: part.cat, name, alias: norm(r[part.nameCol + 1]),
          allSpecs: specCols.map(i => [header[i], norm(r[i])]),   // 빈칸 포함 (상세 화면·전체 스펙용)
          specs: specCols.map(i => [header[i], norm(r[i])]).filter(([, v]) => v),
          perf: get(cols.perf), rec: get(cols.rec), issue: get(cols.issue),
          plus: get(cols.plus), minus: get(cols.minus), note: get(cols.note),
          link: get(cols.link), warranty: get(cols.warranty)
        };
        if (part.cat === 'SSD') it.base = strip('SSD', name);
        if (part.cat === '메인보드') {   // 규격(ATX·M-ATX·ITX·E-ATX)을 스펙 항목으로 넣음 (칩셋 바로 뒤)
          const f = ['규격', mbForm(it)];
          for (const arr of [it.allSpecs, it.specs]) { const k = arr.findIndex(([h]) => h === '칩셋'); arr.splice(k >= 0 ? k + 1 : 0, 0, f); }
          // 레인 공유 문장을 읽어 분류 항목과 x8/x8 지원 여부를 레인 공유 여부 바로 뒤에 넣음
          const lane = (it.allSpecs.find(([h]) => h === '레인 공유 여부') || [])[1] || '';
          const lc = laneClass(lane, (it.allSpecs.find(([h]) => /^PCIe 슬롯$/i.test(h)) || [])[1] || '');
          const add = [['레인 공유 분류', lc.tags.join(', ')], ['x8/x8 지원', lc.x8x8 ? '지원' : '미지원']];
          for (const arr of [it.allSpecs, it.specs]) { const k = arr.findIndex(([h]) => h === '레인 공유 여부'); arr.splice(k >= 0 ? k + 1 : arr.length, 0, ...add); }
          it.laneLeft = lc.left;   // 분류하지 못한 문장 조각 (확인용)
          // 무선: 있음/없음으로 묶은 항목 + WIFI 규격·블루투스 버전 (이상·이하 비교용)
          const wl = (it.allSpecs.find(([h]) => /^WIFI/i.test(h)) || [])[1] || '';
          const wifi = (wl.match(/WIFI\s*(\d+E?)/i) || [])[1] || '', bt = (wl.match(/블루투스\s*(\d+(?:\.\d+)?)/) || [])[1] || '';
          const wadd = [['무선랜·블루투스', wifi || bt ? '있음' : '없음'], ['WIFI 규격', wifi ? 'WIFI ' + wifi.toUpperCase() : '없음'], ['블루투스 버전', bt || '없음']];
          for (const arr of [it.allSpecs, it.specs]) { const k = arr.findIndex(([h]) => /^WIFI/i.test(h)); arr.splice(k >= 0 ? k + 1 : arr.length, 0, ...wadd); }
        }
        it.prices = priceFor(it, price, rules, strip);
        if (part.cat === 'RAM') it.kits = kits[strip('RAM', name)] || null;
        it.search = (it.alias + ' ' + it.name).toLowerCase();
        it.search += ' ' + toEnglish(it.name.toLowerCase());   // 라이젠7 → ryzen7 처럼 영문 표기로도 찾기
        it.nameToks = it.name.toLowerCase().replace(/[()\[\]]/g, ' ').split(/\s+/).filter(t => t.length > 1 && t !== '패키지');   // 패키지는 판매 페이지에 잘 안 적혀서 일치율에서 뺌
        items.push(it);
      }
    }
    blackRamPass(items);
    deriveAll(items);   // 스펙 통합: 검색용 항목 추가
    // 데이터 패치노트 (A 버전 | B 날짜 | C 분류 | D 내용, 최신이 위). GitHub 데이터에만 있음
    const notes = raw['데이터 패치노트'] ? parseCsv(raw['데이터 패치노트']).slice(1).map(r => ({ ver: norm(r[0]), date: norm(r[1]), kind: norm(r[2]), text: norm(r[3]) })).filter(n => /^v\d{8}-\d+$/.test(n.ver)) : [];
    return { items, rules, price, notes };
  }

  // ----- 흑금치(방열판 없는 램) 동일스펙 최저가 -----
  // 그룹 = 세대·클럭·CL(없으면 JEDEC 기본값)·CUDIMM·패키지 + 다이(하이닉스/삼성/마이크론/랜덤) + AS(정상/짧음) + 용량
  // 정상 AS(라이프타임·5년) 제품 → 정상 그룹 최저가
  // 짧은 AS 제품 → 짧은 그룹 최저가. 단, 같은 다이·스펙의 정상 제품이 같거나 더 싸면 정상 제품으로 바꿔 계산하고 알려줌
  const JEDEC_CL = { 4800: '40', 5200: '42', 5600: '46', 6400: '52', 3200: '22', 2666: '19' };
  const ramSpecOf = name => {
    const g = (name.match(/DDR\d-(\d+)/) || []);
    if (!g[0]) return '';
    const cl = (name.match(/CL(\d+)/) || [])[1] || JEDEC_CL[g[1]] || '';
    return `${g[0]}_${cl}${/CUDIMM/i.test(name) ? '_CU' : ''}${/패키지/.test(name) ? '_PKG' : ''}`;
  };
  const ramDie = d => /하이닉스/.test(d) ? '하이닉스' : /^\s*삼성/.test(d) ? '삼성' : /^\s*마이크론/.test(d) ? '마이크론' : '랜덤';
  const asOk = w => /라이프타임|5년/.test(String(w || ''));
  const isBlackRam = it => it.cat === 'RAM' && String(spec(it, '방열판과 RGB 유무')).trim() === '없음';
  function blackRamPass(items) {
    const black = items.filter(isBlackRam);
    const groups = new Map();
    for (const it of black) {
      it.ramGroup = { spec: ramSpecOf(it.name), die: ramDie(spec(it, '다이')), ok: asOk(it.warranty) };
      const k = it.ramGroup.spec + '|' + it.ramGroup.die;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    const cheapest = (list, opt, ok) => {
      let best = null;
      for (const x of list) {
        if (x.ramGroup.ok !== ok) continue;
        const p = (x.prices.find(o => o.opt === opt) || {}).price;
        if (p != null && (!best || p < best.price)) best = { it: x, price: p };
      }
      return best;
    };
    for (const it of black) {
      if (!it.ramGroup.spec) continue;
      const list = groups.get(it.ramGroup.spec + '|' + it.ramGroup.die);
      const caps = new Set(it.prices.map(o => o.opt));
      list.forEach(x => x.prices.forEach(o => { if (o.price != null) caps.add(o.opt); }));   // 품절이어도 같은 그룹 가격으로 계산
      it.prices = [...caps].map(opt => {
        const o = it.prices.find(x => x.opt === opt) || { opt, price: null };
        delete o.sameSpec;
        const nrm = cheapest(list, opt, true), sht = cheapest(list, opt, false);
        let pick = null, sub = false;
        if (it.ramGroup.ok) pick = nrm;
        else if (nrm && (!sht || sht.price >= nrm.price)) { pick = nrm; sub = true; }
        else pick = sht;
        if (pick) { o.sameSpec = pick.price; o.sameFrom = { name: pick.it.name, link: pick.it.link, sub, shortAs: !pick.it.ramGroup.ok, warranty: pick.it.warranty }; }
        return o;
      }).sort((a, b) => (parseInt(a.opt) || 0) - (parseInt(b.opt) || 0));
    }
  }

  // 부품 하나의 가격 목록: [{ opt, price, sameSpec?, sameFrom? }]
  function priceFor(it, price, rules, strip) {
    const P = price[it.cat] || {};
    const list = obj => Object.entries(obj || {}).map(([opt, p]) => ({ opt, price: p }));
    switch (it.cat) {
      case 'CPU': case '메인보드': case '그래픽카드': case '파워서플라이':
        return list(P[it.name]);
      case 'SSD': {
        const base = strip('SSD', it.name);
        const cap = (it.specs.find(([h]) => h === '용량') || [])[1] || '';
        const all = P[base] || {};
        // 이 행은 특정 용량 제품이므로, 그 용량 가격만 씀 (품절이면 가격 없음)
        return cap ? [{ opt: cap, price: all[cap] !== undefined ? all[cap] : null }] : list(all);
      }
      case '케이스': return list(P[it.name]);
      case 'CPU쿨러': return list(P[strip('CPU쿨러', it.name)] || P[it.name]);
      case 'RAM': {
        const base = strip('RAM', it.name);
        const out = list(P[base]);
        const same = price['RAM동일스펙'] || {};
        const ddr = (it.name.match(/DDR\d-\d+/) || [])[0] ||
          (((it.name.match(/DDR\d/) || [])[0] && (it.name.match(/PC\d-(\d+)/) || [])[1]) ? (it.name.match(/DDR\d/)[0] + '-' + it.name.match(/PC\d-(\d+)/)[1]) : '');
        const cl = (it.name.match(/CL(\d+)/) || [])[1] || '';
        // 튜닝램 동일스펙: 세대·클럭·CL·용량(+패키지) 같은 다나와 매물 최저가 (흑금치는 buildDb 끝에서 따로 계산)
        const pkg = /패키지/.test(it.name) ? '_패키지' : '';
        return out.map(({ opt, price: pr }) => {
          const o = { opt, price: pr ?? null };
          const key = `${ddr}_${cl}_${opt}`;
          const hit = same[key + pkg];   // 패키지는 패키지끼리만 비교 (시트가 아직 예전 방식이면 동일스펙 없이 제품 가격)
          if (hit && hit[''] !== undefined) o.sameSpec = hit[''];
          return o;
        }).sort((a, b) => (parseInt(a.opt) || 0) - (parseInt(b.opt) || 0));
      }
    }
    return [];
  }

  function search(db, query, cat) {
    const toks = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!toks.length) return [];
    return db.items.filter(it => (!cat || it.cat === cat) && toks.every(t => it.search.includes(t)));
  }


  // ===== 여러 줄 부품 목록 매칭 =====
  const CAT_HINTS = [
    ['CPU쿨러', /(cpu\s*)?쿨러(?!\s*마스터)|cooler(?!\s*master)|수랭|공랭|aio/i],
    ['CPU', /^\s*(cpu|프로세서|씨피유)(?=[\s:：]|$)|라이젠|ryzen|코어\s*울트라|core\s*(ultra|i[3579])|i[3579]-\d{4,5}/i],
    ['메인보드', /메인\s*보드|마더\s*보드|m\/b|mainboard|motherboard|\b[abhxz]\d{3}[a-z]?m?\b/i],
    ['RAM', /^\s*(ram|램|메모리)(?=[\s:：]|$)|ddr[45]|\b008[45]-\d{4}/i],
    ['그래픽카드', /그래픽|vga|gpu|rtx|gtx|\brx\s?\d{4}|라데온|radeon|지포스|geforce|arc\s?[ab]\d{3}/i],
    ['SSD', /ssd|nvme|m\.2|\bsata\b/i],
    ['파워서플라이', /파워|psu|power|\d{3,4}\s?w\b|80\s?plus/i],
    ['케이스', /케이스|case|미들\s?타워|미니\s?타워|빅\s?타워/i]
  ];
  const NOISE = /(?<![가-힣A-Za-z])(국내\s*정품|정품|멀티팩|벌크|국내|정발|병행|박스|tray|bulk|box|신품|새제품|무상|as|기본|포함|장착|업그레이드)(?![가-힣A-Za-z])/gi;
  const LABEL = /^\s*((cpu\s*)?쿨러|cpu\s*cooler|cooler|cpu|프로세서|메인\s*보드|마더\s*보드|m\/b|mainboard|motherboard|ram|램|메모리|memory|그래픽\s*카드|vga|gpu|ssd|저장\s*장치|storage|하드|파워(\s*서플라이)?|power|psu|케이스|case|os|운영\s*체제)(?![a-z0-9가-힣])\s*(\[[^\]]*\])?\s*[:：\-=]?\s*/i;
  // OCR이 헷갈리는 비슷한 모양 글자를 같은 글자로 취급
  const SHAPE = { 'o': '0', 'd': '0', 'q': '0', 'i': '1', 'l': '1', '|': '1', 't': '1', '!': '1', 'b': '8', 'r': '8', 's': '5', 'g': '6', 'z': '2' };
  const shape = s => String(s).toLowerCase().replace(/[odqilt|!brsgz]/g, ch => SHAPE[ch]);
  const tokenize = s => {
    const base = String(s).toLowerCase().replace(/[()\[\]{}|,·•★☆▶►※]/g, ' ').split(/\s+/).filter(t => t && t.length > 0);
    const extra = [];
    for (const t of base) {
      if (t.includes('-')) for (const p of t.split('-')) if (p.length >= 3) extra.push(p);   // PC5-5600 → 5600
      // OCR이 영문 모델명 앞부분을 한글로 잘못 읽은 경우 (AI818 → 시818): 숫자 부분만 따로
      const hn = t.match(/^[가-힣]{1,2}(\d{3,5}[a-z]{0,3})$/);
      if (hn) extra.push(hn[1]);
      // RX9070XT, RTX5070Ti 처럼 붙어 쓴 모델명 → rx / 9070 / xt
      const m = t.match(/^([a-z]{2,4})(\d{3,5})([a-z]{1,5})?$/);
      if (m) { extra.push(m[1], m[2]); if (m[3]) extra.push(m[3]); }
    }
    return base.concat(extra);
  };

  const VENDORS = /(?<![가-힣A-Za-z])(피씨디렉트|제이씨현|대원씨티에스|이엠텍|인텍앤컴퍼니|아이보라|코잇|디앤디컴|에즈윈|웨이코스|STCOM|서린|파인인포|아스크텍|도우정보|명인일렉트로닉스)(?![가-힣A-Za-z])/gi;
  function parseLine(line) {
    const rawLine = norm(line);
    let cat = '';
    const lab = rawLine.match(LABEL);
    if (lab) {   // "파워 : …"처럼 앞에 부품 종류가 적혀 있으면 그걸 우선
      const l = lab[1].toLowerCase().replace(/\s+/g, '');
      cat = /쿨러|cooler/.test(l) ? 'CPU쿨러' : /^(cpu|프로세서)$/.test(l) ? 'CPU' : /보드|m\/b|mainboard|motherboard/.test(l) ? '메인보드' : /^(ram|램|메모리|memory)$/.test(l) ? 'RAM'
        : /그래픽|vga|gpu/.test(l) ? '그래픽카드' : /ssd|저장|하드|storage/.test(l) ? 'SSD' : /파워|psu|power/.test(l) ? '파워서플라이' : /케이스|case/.test(l) ? '케이스' : '';
    }
    if (!cat) for (const [c, re] of CAT_HINTS) { if (re.test(rawLine)) { cat = c; break; } }
    let kitM = rawLine.match(/(\d+)\s?GB?\s?[x×*]\s?(\d)(?!\d)/i);          // 32GB(16GBx2), 16GX2 → 16GB 2개
    if (!kitM) {   // OCR이 G를 6으로 읽은 경우: 64GB (326BX 2) → 32GB×2 (적힌 전체 용량과 맞을 때만)
      const k6 = rawLine.match(/(\d{1,3})\s?6\s?B\s?[x×*]\s?(\d)(?!\d)/i), tot = rawLine.match(/(\d+)\s?GB\b/i);
      if (k6 && [8, 16, 24, 32, 48, 64].includes(Number(k6[1])) && (!tot || Number(tot[1]) === Number(k6[1]) * Number(k6[2]))) kitM = k6;
    }
    const capM = kitM ? null : rawLine.match(/(\d+(?:\.\d+)?)\s?(TB|GB)\b/i);
    let cap = kitM ? kitM[1] + 'GB' : capM ? (capM[1] + capM[2].toUpperCase()) : '';
    if (!cap) {   // OCR로 16GB가 1668처럼 읽힌 경우 모양으로 찾기
      const caps = ['8GB', '16GB', '24GB', '32GB', '48GB', '64GB', '96GB', '128GB', '256GB', '500GB', '512GB', '1TB', '2TB', '4TB', '8TB'];
      const ts = tokenize(rawLine).map(shape);
      cap = caps.find(cp => ts.includes(shape(cp))) || '';
      if (!cap) { const tb = tokenize(rawLine).map(t => t.match(/^([1248])[7t1]{1,2}[8b]$/i)).find(Boolean); if (tb) cap = tb[1] + 'TB'; }   // 1TB → 1718 같은 오인식
    }
    const cntM = rawLine.match(/(?:^|[\s)\]]|gb)\s*[x×*]\s?(\d)(?![\d.])|(\d)\s?(?:개|ea|장)/i);
    const count = kitM ? Number(kitM[2]) : cntM ? Number(cntM[1] || cntM[2]) : 0;   // 킷 표기(16GBx2)가 있으면 그 개수 우선
    const color = /화이트|white|흰색|\bwh\b/i.test(rawLine) ? '화이트' : /블랙|black|검정|\bbk\b/i.test(rawLine) ? '블랙' : '';
    const text = rawLine.replace(LABEL, '').replace(NOISE, ' ')
      .replace(/\(?\s*\d+\s?GB?\s?[x×*]\s?\d\s*\)?/gi, ' ')            // (16GBx2), 16GX2
      .replace(/\(?\s*\d{1,3}\s?6\s?B\s?[x×*]\s?\d\s*\)?/gi, ' ')    // (326BX 2) = 32GB×2를 잘못 읽은 것
      .replace(/\*\s?\d+\s?개/g, ' ').replace(/[™®]/g, ' ')                  // *1개, ™
      .replace(VENDORS, ' ')                                                   // 유통사명(피씨디렉트 등)
      .replace(/\(?(화이트|블랙|white|black|흰색|검정)\)?/gi, ' ');      // 색상은 따로 읽음
    return { line: rawLine, text: norm(text), cat, cap, count, color };
  }

  const KEY_TOKENS = new Set(['xt', 'xtx', 'ti', 'super', 'gre', 'x3d', 'xe', 'pro', 'plus', 'max', 'evo', 'oc', 'v2', 'v3', 'ii', 'iii', 'ice']);
  const BRANDS = new Set(['amd', 'intel', 'asus', 'msi', 'gigabyte', 'asrock', 'biostar', 'nvidia', 'corsair', 'kioxia', 'samsung', '삼성', '삼성전자', 'seagate', 'wd', 'sk', 'hynix', 'skhynix',
    'zalman', '잘만', '3rsys', 'cooler', 'master', 'coolermaster', 'nzxt', 'deepcool', 'lian', 'li', 'lianli', 'darkflash', 'antec', 'abko', '앱코', 'micronics', '마이크로닉스',
    'seasonic', 'superflower', 'thermalright', 'arctic', 'noctua', 'pccooler', 'id-cooling', 'bravotec', 'daven', '1stplayer', 'zotac', 'palit', 'galax', 'inno3d', 'sapphire',
    'powercolor', 'xfx', 'colorful', 'emtek', '이엠텍', 'teamgroup', 'g.skill', 'gskill', 'klevv', 'essencore', 'crucial', 'micron', 'kingston', 'adata', 'hiksemi', 'lexar', 'patriot', 'coolleo',
    '컴이지', '타무즈', '쿨러마스터', '리안리', '다크플래쉬', '에센코어', '써멀라이트', '브라보텍', '데이븐', '오쓰', '씨게이트', '키오시아', 'sk하이닉스', '하이닉스', '에이서', '기가바이트',
    '아수스', '애즈락', '갤럭시', '조텍', '렉사', '커세어', '시소닉', '슈퍼플라워', '에너지옵티머스', 'apacer', 'agi', 'hyte', 'acer', 'msi', '엠에스아이']);
  // 여러 제품에 흔히 들어가는 말 (이것만 맞아서는 제품으로 인정하지 않음)
  const GENERIC = new Set(['ryzen', 'radeon', 'geforce', 'rtx', 'gtx', '라이젠', '라데온', '지포스', 'core', 'ultra', 'series', 'gaming', 'argb', 'rgb', 'white', 'black',
    '화이트', '블랙', 'm.2', 'nvme', 'ddr5', 'ddr4', 'wifi', 'atx', 'oc', 'pro', 'plus', 'mesh', '강화유리', 'edition', 'cooler', 'master', 'gold', '80plus',
    'new', 'ssd', 'pcie', 'gen4', 'gen5', 'sata', '1tb', '2tb', '4tb', '500gb', '512gb', '256gb', '8gb', '16gb', '32gb', '64gb', 'tb', 'gb']);
  // 짧은 단어(3글자 이하)는 단어 단위로만 맞은 것으로 봄 (ice가 nice에 걸리지 않게)
  const hasTok = (it, t) => (t.length <= 3 ? (it.words || (it.words = new Set(tokenize(it.search)))).has(t) : it.search.includes(t));
  // 두 단어가 글자 하나만 다른지(바뀜·빠짐·더해짐)
  function near1(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, d = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++d > 1) return false;
      if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
    }
    return d + (a.length - i) + (b.length - j) <= 1;
  }
  function scoreItem(it, toks, stoks) {
    if (!toks.length) return 0;
    if (!it.shape) { it.shape = shape(it.search); it.nameShapes = it.nameToks.map(shape); }
    let w = 0, hit = 0;
    const ns = it.nameShapes;
    toks.forEach((t, i) => {
      // XT, Ti, SUPER 같은 짧은 등급 표기는 제품을 가르는 핵심이라 무게를 크게 줌
      const tw = KEY_TOKENS.has(t) ? 9 : Math.min(t.length, 6) + (/\d/.test(t) ? 3 : 0); w += tw;
      if (hasTok(it, t)) hit += tw;
      else if ((/\d/.test(t) || t.length >= 5) && stoks[i].length >= 3 && it.shape.includes(stoks[i])) hit += tw * 0.85;   // 모양 보정은 숫자가 섞였거나 긴 단어만
      else if (t.length >= 6 && /\d/.test(t) && ns.some(n => n.length >= 5 && near1(stoks[i], n))) hit += tw * 0.75;   // 글자 하나 더/덜 읽힘 (RC1I400N → RC1400N)
    });
    const nt = it.nameToks;
    const cov = nt.length ? nt.filter((t, j) => toks.some((x, i) => x.includes(t) || t.includes(x) || (ns[j].length >= 3 && (stoks[i] === ns[j] || stoks[i].includes(ns[j]))))).length / nt.length : 0;
    return 0.6 * (hit / w) + 0.4 * cov;
  }

  function matchLine(db, line) {
    const p = parseLine(line);
    if (!p.text || p.text.length < 2) return null;
    const toks = tokenize(p.text), stoks = toks.map(shape);
    // [AMD], [ASUS], [COOLER MASTER] 처럼 제조사 이름만 있는 줄은 제품이 아님 (다음 줄과 합쳐서 판단)
    if (toks.every(t => BRANDS.has(t.replace(/[\[\]]/g, '')) || GENERIC.has(t.replace(/[\[\]]/g, '')) || /^[^a-z0-9가-힣]+$/.test(t))) {
      const genericOnly = toks.every(t => GENERIC.has(t.replace(/[\[\]]/g, '')) || /^[^a-z0-9가-힣]+$/.test(t));   // "PLUS (블랙)"처럼 제조사 없이 일반 단어만
      return { ...p, cands: [], weak: true, brandOnly: true, genericOnly, cat: p.cat };
    }
    const pool = p.cat ? db.items.filter(it => it.cat === p.cat) : db.items;
    let cands = pool.map(it => ({ it, s: scoreItem(it, toks, stoks) })).filter(x => x.s > 0.25);
    // SSD는 용량까지 맞는 행을 우선 (OCR로 1TB가 118처럼 읽혀도 모양으로 비교)
    cands.forEach(x => { if (x.it.cat !== 'SSD') return; const c = (x.it.specs.find(([h]) => h === '용량') || [])[1]; if (c && (c === p.cap || stoks.includes(shape(c)))) x.s += 0.15; });
    cands.forEach(x => { if (x.it.cat !== 'SSD' && x.it.prices.some(q => q.price !== null)) x.s += 0.02; });
    // 원문에 제조사 이름이 있는데 후보에 없으면 감점 (예: LEXAR 램 → FASTRO 램 방지)
    const lineBrands = toks.map(t => t.replace(/[\[\]]/g, '')).filter(t => BRANDS.has(t) && !GENERIC.has(t));
    if (lineBrands.length) cands.forEach(x => {
      const ok = lineBrands.some(b => x.it.search.includes(b) || (toEnglish(b) && toEnglish(b).split(' ').some(e => e && x.it.search.includes(e))));
      if (!ok) x.s -= 0.15;
    });
    // 원문에 '패키지'가 있으면 튜닝램 패키지 제품을 우선
    if (/패키지/.test(p.line)) cands.forEach(x => { if (x.it.cat === 'RAM') x.s += isPkg(x.it) ? 0.05 : -0.05; });
    // 이름에 색상이 붙는 제품(파워·메인보드·램 등): 원문 색상과 같은 쪽을 우선
    if (p.color) {
      const want = p.color === '화이트' ? /화이트|white/i : /블랙|black/i, other = p.color === '화이트' ? /블랙|black/i : /화이트|white/i;
      cands.forEach(x => { if (want.test(x.it.name)) x.s += 0.05; else if (other.test(x.it.name)) x.s -= 0.05; });
    }
    cands.sort((a, b) => b.s - a.s);
    // 제조사 없이 적힌 경우(예: "지포스 RTX 5060 8GB"): 점수가 거의 같은 후보 중 가장 싼 제품을 먼저
    if (!lineBrands.length && cands.length > 1) {
      const cheap = x => { const ps = (x.it.prices || []).filter(q => q.price != null).map(q => q.price); return ps.length ? Math.min(...ps) : Infinity; };
      // 이름 길이 차이로 점수가 조금씩 다르므로 넉넉히 비교하되, 원문에 없는 등급 표기(Ti, SUPER 등)가 붙은 제품은 뺌
      const extraKey = x => x.it.nameToks.some(t => KEY_TOKENS.has(t) && !toks.includes(t) && !['oc', 'pro', 'plus', 'max', 'evo', 'v2', 'v3', 'ii', 'iii', 'ice'].includes(t));
      const numToks = toks.filter(t => /\d/.test(t) && hasTok(cands[0].it, t));
      const tie = cands.filter(x => x.s >= cands[0].s - 0.1 && x.it.cat === cands[0].it.cat && !extraKey(x) && numToks.every(t => hasTok(x.it, t)));
      if (tie.length > 1) {
        const best = tie.reduce((a, b) => (cheap(b) < cheap(a) ? b : a));
        if (best !== cands[0] && cheap(best) < Infinity) { cands.splice(cands.indexOf(best), 1); cands.unshift(best); }
      }
    }
    cands = cands.slice(0, 8);
    // 사진 속 글자 조각 같은 쓰레기 줄 거르기: 점수가 충분하고, 3글자 이상 단어가 실제로 하나 이상 맞아야 함
    const strongHit = it => toks.some((t, i) => t.length >= 3 && !GENERIC.has(t) && !BRANDS.has(t) && /[a-z가-힣]|\d{3}/.test(t) && (hasTok(it, t) || ((/\d/.test(t) || t.length >= 5) && stoks[i].length >= 3 && it.shape && it.shape.includes(stoks[i]))));
    if (!cands.length || cands[0].s < 0.5 || !strongHit(cands[0].it)) return { ...p, cands: [], weak: true, cat: p.cat };
    return { ...p, cands, cat: p.cat || (cands[0] && cands[0].it.cat) || '' };
  }

  // 요약 줄(예: R7-9800X3D / RX9070 XT / 32GB / 1TB)은 건너뜀
  const isSummary = l => (l.match(/\s\/\s|\/\s|\s\//g) || []).length >= 2 && !LABEL.test(l);
  const top = m => (m && m.cands[0] ? m.cands[0].s : 0);

  function applyAliases(db, text) {
    let t = String(text || '');
    for (const [from, to] of (db.rules && db.rules.aliases) || []) {
      const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*'), 'gi');
      t = t.replace(re, to);
    }
    return t;
  }

  function matchText(db, text) {
    text = applyAliases(db, String(text || '').replace(/(\d{3,4})\s?(?:\\\/\\\/|\\\/|VV|V\/|W\\\/|VW|IW|V)(?![a-z0-9])/gi, '$1W').replace(/(?<=[a-z0-9]\s)(?:Il|lI|ll|1I|I1|Ii|iI)(?![a-z0-9])/gi, 'II'));   // OCR이 W를 \/ 나 VV로 읽은 경우
    // 사진 속 글자 조각(예: "2205 2", "IS", "ot")은 버림: 의미 있는 단어가 하나도 없으면 조각으로 봄
    const meaningful = l => /[a-z]{3,}|[가-힣]{2,}|[a-z]+\d+|\d+[a-z]+/i.test(l);
    // 빈 줄은 칸 경계(§)로 남겨서 다른 칸의 줄과 이어 붙지 않게 함
    const lines = String(text || '').split(/\r?\n|;/).map(l => l.trim()).map(l => (l === '' ? '§' : l))
      .filter(l => l === '§' || (l.length >= 2 && !isSummary(l) && (meaningful(l) || /^-{3,}$/.test(l))));
    // "메모리", "저장장치" 같은 칸 제목만 있는 줄은 다음 제품의 분류 힌트로 씀
    const HEAD = [['CPU쿨러', /^(cpu\s*)?쿨러$|^cooler$/i], ['CPU', /^(cpu|프로세서)$/i], ['메인보드', /^(메인\s*보드|마더\s*보드|m\/b)$/i], ['RAM', /^(ram|램|메모리)$/i],
      ['그래픽카드', /^(그래픽\s*카드|vga|gpu)$/i], ['SSD', /^(ssd|저장\s*장치|스토리지)$/i], ['파워서플라이', /^(파워(\s*서플라이)?|psu)$/i], ['케이스', /^(케이스|case)$/i]];
    const STOP = /^(서비스|기타|os|운영\s*체제|a\/s|조립비?|배송|사은품|-{3,})$/i;
    const isHead = l => !!headCat(l) || STOP.test(squash(l)) || SKIPHEAD.test(squash(l).replace(/\s*\[[^\]]*\]$/, ''));
    const squash = l => { const t = l.replace(/[:：\s]+$/, '').trim(); return /^[가-힣\s]+$/.test(t) ? t.replace(/\s+/g, '') : t; };   // "저 장 장치" → "저장장치"
    // "프로세서 [CPU]", "그래픽카드 [VGA]", "MAINBOARD" 같은 칸 제목: 단어가 모두 부품 종류 이름이면 제목으로 봄
    const HEADWORD = { 'cpu': 'CPU', '프로세서': 'CPU', '쿨러': 'CPU쿨러', 'cooler': 'CPU쿨러', '메인보드': '메인보드', 'm/b': '메인보드', 'mainboard': '메인보드', 'motherboard': '메인보드',
      '그래픽카드': '그래픽카드', 'vga': '그래픽카드', 'gpu': '그래픽카드', '메모리': 'RAM', 'ram': 'RAM', 'memory': 'RAM', '저장장치': 'SSD', 'ssd': 'SSD', 'storage': 'SSD',
      '케이스': '케이스', 'case': '케이스', '파워': '파워서플라이', 'power': '파워서플라이', 'psu': '파워서플라이' };
    const headCat = l => {
      const h = HEAD.find(([, re]) => re.test(squash(l))); if (h) return h[0];
      const ws = squash(l).toLowerCase().replace(/[\[\]()]/g, ' ').split(/\s+/).filter(Boolean);
      if (!ws.length || ws.length > 3) return '';
      const cats = ws.map(w => HEADWORD[w]); if (cats.some(x => !x)) return '';
      return cats.includes('CPU쿨러') ? 'CPU쿨러' : cats[cats.length - 1];
    };
    // 부품이 아닌 칸 제목: 그 아래 줄은 다음 제목까지 건너뜀
    const SKIPHEAD = /^(fan|팬|시스템\s*팬|o\/s|os|운영체제(\s*\[os\])?|service|서비스|a\/s|배송|기타|무선랜|사운드)$/i;
    const same = (a, b) => a && b && a.cands[0] && b.cands[0] && a.cands[0].it === b.cands[0].it;
    const out = [];
    let pending = '', section = 0, skipping = false;
    const SERVICE = /무상|a\/s|as\s*지원|출장|방문|배송|설치|직영|보증|업데이트|※|미장착|상품코드|운영체제|free\s*dos|윈도우\s*미탑재|순차\s*읽기|제품\s*사양|\d+\s*[x×]\s*\d+\s*[x×]\s*\d+/i;   // 서비스·안내 문구, 치수
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === '§') { pending = ''; skipping = false; continue; }
      const hc = headCat(lines[i]); if (hc) { pending = hc; skipping = false; continue; }
      if (SKIPHEAD.test(squash(lines[i]).replace(/\s*\[[^\]]*\]$/, ''))) { pending = ''; skipping = true; continue; }
      if (skipping) continue;
      if (/^-{3,}$/.test(lines[i])) { section++; pending = ''; skipping = false; continue; }   // 두 번째 읽기 결과 구분선
      if (/^\s*(fan|팬|o\/s|os|service|서비스|a\/s)\s*[:：]/i.test(lines[i])) continue;           // "FAN : …" 처럼 부품이 아닌 줄
      if (STOP.test(squash(lines[i])) || SERVICE.test(lines[i])) { pending = ''; continue; }
      const pendingWas = pending;
      let cur = pending ? `${pending} : ${lines[i]}` : lines[i];
      let m1 = matchLine(db, cur), joined = 0;
      // 제품명이 여러 줄로 나뉜 경우: 다음 줄을 붙였을 때 같은 제품이거나 더 잘 맞으면 이어 붙임 (최대 3줄 추가)
      while (i + 1 < lines.length && joined < 3 && lines[i + 1] !== '§' && !LABEL.test(lines[i + 1]) && !isHead(lines[i + 1])) {
        const nxt = lines[i + 1];
        const m2 = matchLine(db, nxt), mc = matchLine(db, cur + ' ' + nxt);
        if (!mc) break;
        const p2 = parseLine(nxt);
        const cat2 = p2.cat || (m2 && m2.cands.length && top(m2) >= 0.5 ? m2.cands[0].it.cat : '');
        const curCat = m1 && m1.cands.length ? m1.cands[0].it.cat : '';
        const otherCat = cat2 && curCat && cat2 !== curCat;               // 다음 줄이 다른 종류 부품이면 합치지 않음
        const better = top(mc) >= 0.5 && top(mc) > Math.max(top(m1), top(m2)) + 0.04;
        // 다음 줄이 혼자서 '확실한 다른 제품'인지: 점수가 높고 1·2위 후보 차이가 뚜렷해야 함
        const sure2 = m2 && m2.cands.length && top(m2) >= 0.8 && (!m2.cands[1] || top(m2) - m2.cands[1].s >= 0.03);
        const continues = same(mc, m1) && !otherCat && (!sure2 || same(m2, m1));
        // 용량·개수만 있는 줄(예: 32GB(16GBx2))은 앞 줄에 붙임
        const attrOnly = m1 && m1.cands.length && /^[\s\d.()\[\]x×*+\/,~-]*(?:\d\s?(?:GB|TB|개)[\s\d.()\[\]x×*+\/,~GBTgbt개-]*)$/i.test(nxt);
        // 앞 줄이 혼자서는 거의 안 맞고(사진 속 영문 등) 다음 줄과 합치면 맞는 경우
        const weakLead = ((!m1 || top(m1) < 0.45) && top(mc) >= 0.5 && !otherCat) || (m1 && m1.brandOnly && joined === 0);   // 제조사 이름 줄은 다음 줄과 항상 합침
        const fragment = m2 && m2.genericOnly && !LABEL.test(nxt) && (!p2.cat || !curCat || p2.cat === curCat);   // "PLUS (블랙)", "M.2 NVMe"처럼 일반 단어뿐인 줄은 앞 제품명의 일부
        if (m2 && m2.brandOnly && !m2.genericOnly && !(m1 && m1.brandOnly && !m1.genericOnly)) break;   // 제조사 이름 줄은 새 제품의 시작
        // 다음 줄이 같은 종류 제품의 세부 이름(예: "ICE")이라 합쳐도 점수가 거의 그대로면 이어 붙임
        const mcCat = mc.cands.length ? mc.cands[0].it.cat : '';
        const refine = curCat && mcCat === curCat && !otherCat && !sure2 && top(mc) >= top(m1) - 0.02 && !(m2 && m2.brandOnly);
        // 앞 줄만으로는 비슷한 후보가 여럿(예: 같은 시리즈의 650W·750W·850W)인데, 다음 줄을 붙이면 그중 하나로 좁혀지는 경우
        const narrow = m1 && m1.cands.length > 1 && mc.cands.length && !otherCat && !sure2 && !(m2 && m2.brandOnly && !m2.genericOnly)
          && m1.cands.some(x => x.it === mc.cands[0].it && x.s >= top(m1) - 0.03);
        // 앞 줄도 못 찾았고 다음 줄도 못 찾는 짧은 줄이면(예: "잘만 N3O 백사심" + "PLUS (블랙)") 한 줄로 묶어 '찾지 못함'에 보여줌
        const missTail = !(m1 && m1.cands.length) && !(m2 && m2.cands.length) && !(m2 && m2.brandOnly && !m2.genericOnly) && !p2.cat && tokenize(p2.text).length <= 3 && !(mc.cands.length);
        if (!(better || (continues && !otherCat) || attrOnly || weakLead || fragment || refine || narrow || missTail)) break;
        cur = cur + ' ' + nxt; m1 = mc; i++; joined++;
      }
      if (m1 && m1.cands.length) pending = '';   // 제품을 찾을 때까지 칸 제목 힌트 유지 (사진 속 글자 조각은 건너뜀)
      if (m1) { m1.orig = cur.replace(/^\S+\s:\s/, pendingWas ? '' : '$&'); m1.section = section; out.push(m1); }
    }
    return out;
  }


  // ===== OCR 단어 위치로 칸(열)을 나눠 줄을 다시 만들기 =====
  // words: [{ t, x0, y0, x1, y1, c }], width: 이미지 너비
  function wordsToText(words, width) {
    words = words.filter(w => w.t && w.t.trim());
    if (!words.length) return '';
    const hs = words.map(w => w.y1 - w.y0).sort((a, b) => a - b), medH = hs[Math.floor(hs.length / 2)] || 10;
    // 작은 안내 문구 제외. 신뢰도 낮은 단어는 바로 옆(같은 줄)에 확실한 단어가 있을 때만 남김 (굵은 한글 글꼴은 신뢰도가 낮게 나옴)
    words = words.filter(w => (w.y1 - w.y0) >= medH * 0.5);
    words = words.filter(w => w.c >= 25 || (w.c >= 5 && words.some(o => o !== w && o.c >= 60 && Math.abs((o.y0 + o.y1) - (w.y0 + w.y1)) < medH && Math.min(Math.abs(o.x0 - w.x1), Math.abs(w.x0 - o.x1)) < medH * 3)));
    // 1) 같은 높이의 단어를 한 줄로
    words.sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    const rows = [];
    for (const w of words) {
      const cy = (w.y0 + w.y1) / 2, r = rows[rows.length - 1];
      if (r && Math.abs(cy - r.cy) < medH * 0.6) { r.ws.push(w); r.cy = (r.cy * (r.ws.length - 1) + cy) / r.ws.length; } else rows.push({ cy, ws: [w] });
    }
    // 2) 한 줄 안에서 간격이 크게 벌어진 곳은 다른 칸으로 보고 나눔
    const gapMin = Math.max(medH * 1.1, width * 0.02);
    const segs = [];
    let maxSeg = 1, model = null;
    for (const r of rows) {
      r.ws.sort((a, b) => a.x0 - b.x0);
      const parts = [[r.ws[0]]];
      for (let i = 1; i < r.ws.length; i++) { if (r.ws[i].x0 - r.ws[i - 1].x1 > gapMin) parts.push([r.ws[i]]); else parts[parts.length - 1].push(r.ws[i]); }
      // 한글은 글자마다 단어로 나뉘어 나올 때가 많음: 간격이 좁으면 띄우지 않고 붙임 ("라 이 젠" → "라이젠")
      const HAN = /^[가-힣]+$/;
      const spaceBefore = (a, w) => {
        if (w.lid && w.lid === a.lid && w.sp != null) return w.sp;            // OCR 엔진이 알려준 띄어쓰기
        if (HAN.test(a.t) && HAN.test(w.t) && (a.t.length === 1 || w.t.length === 1) && w.x0 - a.x1 < medH * 0.5) return false;   // 한글 낱글자
        return true;
      };
      const joinWords = p => p.reduce((s, w, i) => s + (i && spaceBefore(p[i - 1], w) ? ' ' : '') + w.t, '');
      const ps = parts.map(p => ({ cy: r.cy, cx: (p[0].x0 + p[p.length - 1].x1) / 2, x0: p[0].x0, x1: Math.max(...p.map(w => w.x1)), t: joinWords(p) }));
      segs.push(...ps);
      if (ps.length > maxSeg) { maxSeg = ps.length; model = ps; }
    }
    // 칸이 하나뿐이면 원래 순서 그대로
    if (maxSeg === 1) return segs.map(s => s.t).join('\n');
    // "CPU | 제품명 | 수량" 같은 표 형식(왼쪽 칸이 부품 종류)은 줄 순서대로 이어 붙임
    const multi = rows.filter(r => segs.filter(s => s.cy === r.cy).length > 1);
    const labelLeft = multi.filter(r => { const first = segs.find(s => s.cy === r.cy); return first && LABEL.test(first.t + ' '); }).length;
    if (multi.length >= 2 && labelLeft >= multi.length * 0.5) return rows.map(r => segs.filter(s => s.cy === r.cy).map(s => s.t).join(' : ')).join('\n');
    // 3) 칸 나누기: 조각들의 가로 범위가 겹치는 것끼리 한 칸(띠)으로 묶음 (왼쪽 정렬·가운데 정렬 모두)
    let centers = null;
    const narrowSegs = segs.filter(s => s.x1 - s.x0 <= (width / maxSeg) * 1.15).sort((a, b) => a.x0 - b.x0);
    const bands = [];
    for (const s of narrowSegs) { const b = bands[bands.length - 1]; if (b && s.x0 <= b.x1 + medH * 0.5) b.x1 = Math.max(b.x1, s.x1); else bands.push({ x0: s.x0, x1: s.x1 }); }
    if (bands.length >= 2 && bands.length <= maxSeg + 1) {
      for (const s of segs) {
        let k = -1, best = 0;
        bands.forEach((b, j) => { const ov = Math.min(b.x1, s.x1) - Math.max(b.x0, s.x0); if (ov > best) { best = ov; k = j; } });
        if (k < 0) bands.forEach((b, j) => { if (k < 0 || Math.abs(s.cx - (b.x0 + b.x1) / 2) < Math.abs(s.cx - (bands[k].x0 + bands[k].x1) / 2)) k = j; });
        s.col = k;
      }
      centers = bands.map(b => (b.x0 + b.x1) / 2);
    } else {
      // 가장 많이 나뉜 줄의 칸 위치를 기준으로 모든 조각을 가까운 칸에 배정
      centers = model.map(s => s.cx);
      for (let it = 0; it < 3; it++) {   // 칸 중심을 조금씩 보정
        const sum = centers.map(() => 0), cnt = centers.map(() => 0);
        for (const s of segs) { let k = 0; centers.forEach((c, j) => { if (Math.abs(s.cx - c) < Math.abs(s.cx - centers[k])) k = j; }); s.col = k; sum[k] += s.cx; cnt[k]++; }
        centers.forEach((c, j) => { if (cnt[j]) centers[j] = sum[j] / cnt[j]; });
      }
    }
    const out = [];
    centers.map((c, j) => j).sort((a, b) => centers[a] - centers[b]).forEach(j => {
      // 같은 칸 안에서도 위아래 간격이 크게 벌어지면(사진이 끼어 있는 카드형) 다른 제품으로 보고 빈 줄을 넣음
      let prevCy = null;
      segs.filter(s => s.col === j).sort((a, b) => a.cy - b.cy).forEach(s => { if (prevCy !== null && s.cy - prevCy > medH * 3) out.push(''); out.push(s.t); prevCy = s.cy; });
      out.push('');
    });
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // 부품명처럼 보이는지 (영문 2자 이상이나 숫자 2자리 이상)
  const looksLikePart = l => !/^\s*\(.*\)\s*$/.test(l) && /[A-Za-z]{2,}|\d{2,}/.test(l) && tokenize(l).filter(t => t.length >= 2 && /[a-z0-9가-힣]/i.test(t)).length >= 2;


  // ===== 견적 점수 평균과 호환성 검사 =====
  // rows: [{ it, count }]  (it = buildDb의 부품, count = 램 개수)
  const spec = (it, h) => { const s = it && it.specs.find(([k]) => k === h); return s ? s[1] : ''; };
  const mm = s => { const m = String(s || '').match(/(\d+(?:\.\d+)?)\s*mm/i); return m ? Number(m[1]) : null; };
  const firstW = s => { const m = String(s || '').match(/(\d{2,4})\s*W/i); return m ? Number(m[1]) : null; };
  const scoreNum = s => { const v = parseFloat(String(s || '').replace(/[^\d.]/g, '')); return isNaN(v) ? null : v; };


  // ===== 파워 계산기 =====
  // 예상 최대 소비 전력(부하)을 부품별로 더하고, 마진(%)을 붙여 세 단계 용량을 냄
  //   사용 가능 +15% (부하율 약 87%) / 권장 +50% (약 67%) / 스윗스팟 +80% (약 55%, 효율이 가장 높은 50~60% 구간의 가운데)
  //   용량은 실제 파워 용량 단위로 올림. 권장과 스윗스팟이 같은 용량이면 합침
  // opt: { fans: 추가 팬 수(팬갈이면 총 장착 팬 − 케이스 기본 팬, 음수 가능), hdd: HDD 수, gpuMax: 그래픽카드 최대 제한 전력 기준 }
  const PSU_W = { fan: 8, pump: 10, hdd: 10, nvme: 10, sata: 5, ram: 5, ramRgb: 7, mbHigh: 45, mbLow: 30, etc: 15 };
  const PSU_TIERS = [['min', '사용 가능', 15], ['rec', '권장', 50], ['sweet', '스윗스팟', 80]];
  // 그래픽카드 칩셋 제조사(NVIDIA·AMD) 공식 권장 파워 (Required System Power). 긴 이름부터 맞춤
  //   RTX 50: 5090 1000W, 5080 850W, 5070 Ti 750W, 5070 650W, 5060 Ti 600W, 5060·5050 550W
  //   RX 9000: 9070 XT 750W, 9070 650W, 9060 XT 450W / 9070 GRE·9060은 공식 값을 못 찾아 같은 전력대 기준 추정(est)
  const GPU_PSU_REC = [['5090', 1000], ['5080', 850], ['5070 Ti', 750], ['5070', 650], ['5060 Ti', 600], ['5060', 550], ['5050', 550],
    ['RX 9070 XT', 750], ['RX 9070 GRE', 650, 'est'], ['RX 9070', 650], ['RX 9060 XT', 450], ['RX 9060', 450, 'est']];
  const gpuPsuRec = gpu => {
    if (!gpu) return null;
    const c = (spec(gpu, '칩셋') || gpu.name).toUpperCase().replace(/\s+/g, ' ');
    const hit = GPU_PSU_REC.find(([k]) => new RegExp('(^|[^0-9A-Z])' + k.toUpperCase().replace(/ /g, '\\s*') + '(?![0-9A-Z]|\\s*(TI|XT|GRE)\\b)').test(c));
    return hit ? { chip: hit[0], w: hit[1], est: !!hit[2], maker: /^RX/.test(hit[0]) ? 'AMD' : 'NVIDIA' } : null;
  };
  const PSU_SIZES = [450, 500, 550, 600, 650, 700, 750, 800, 850, 1000, 1200, 1300, 1500, 1600, 2000];
  const fanCount = s => { const t = String(s || ''); if (/^\s*(x|없음|-)?\s*$/i.test(t)) return 0; return [...t.matchAll(/\*\s*(\d+)/g)].reduce((a, m) => a + Number(m[1]), 0); };
  function psuCalc(rows, opt) {
    opt = opt || {};
    const one = cat => rows.find(r => r.it && r.it.cat === cat);
    const cpuR = one('CPU'), gpuR = one('그래픽카드'), mbR = one('메인보드'), coolR = one('CPU쿨러'), caseR = one('케이스'), ramR = one('RAM');
    const parts = [];   // [이름, W, 설명]
    if (cpuR) { const w = firstW(spec(cpuR.it, '소비 전력 / 권장 전원부')); if (w) parts.push(['CPU', w, '최대 소비 전력']); }
    if (gpuR) {
      const t = spec(gpuR.it, '소비 전력(최대 제한 전력)'), base = firstW(t), mx = Number((String(t).match(/\((\d+)\s*W\)/i) || [])[1]) || null;
      const useMax = !!(opt.gpuMax && mx), w = useMax ? mx : base;
      if (w) parts.push(['그래픽카드', w, useMax ? '최대 제한 전력' : '기본 전력']);
    }
    if (mbR) { const c = spec(mbR.it, '칩셋') || mbR.it.name; const hi = /\b[XZ]\d{3}/i.test(c); parts.push(['메인보드', hi ? PSU_W.mbHigh : PSU_W.mbLow, hi ? 'X·Z 칩셋' : 'B·A·H 칩셋']); }
    if (ramR) {
      const sticks = (ramR.count || 1) * (isPkg(ramR.it) ? sticksFor(ramR.it, ramR.opt) : 1);
      const rgb = /\/\s*있음/.test(spec(ramR.it, '방열판과 RGB 유무')), per = rgb ? PSU_W.ramRgb : PSU_W.ram;
      parts.push(['램', sticks * per, `${sticks}장 × ${per}W${rgb ? ' (RGB)' : ''}`]);
    }
    const ssds = rows.filter(r => r.it && r.it.cat === 'SSD');
    if (ssds.length) {
      let nv = 0, sa = 0; ssds.forEach(r => { const n = r.count || 1; if (/sata/i.test(r.it.name + ' ' + spec(r.it, '분류'))) sa += n; else nv += n; });
      parts.push(['SSD', nv * PSU_W.nvme + sa * PSU_W.sata, [nv ? `NVMe ${nv}개 × ${PSU_W.nvme}W` : '', sa ? `SATA ${sa}개 × ${PSU_W.sata}W` : ''].filter(Boolean).join(', ')]);
    }
    // 팬: 쿨러 팬 + 케이스 기본 팬 + 추가 팬. 팬 미포함 수랭은 라디 크기만큼 팬을 단 기준
    let coolFans = 0, pump = false, coolNote = '';
    if (coolR) {
      const it = coolR.it, water = /\//.test(spec(it, '수치')) || /수랭/.test(spec(it, '분류'));
      pump = water; coolFans = fanCount(spec(it, '팬 사양'));
      if (!coolFans && water) {
        const m = it.name.match(/(120|140|240|280|360|420|480)/);
        if (m) { const z = Number(m[1]); coolFans = { 120: 1, 140: 1, 240: 2, 280: 2, 360: 3, 420: 3, 480: 4 }[z]; coolNote = ', 팬 미포함 → 라디 크기만큼 단 기준'; }
      }
    }
    const caseFans = caseR ? fanCount(spec(caseR.it, '기본 제공 팬')) : 0;
    const extra = Math.round(Number(opt.fans) || 0), fans = Math.max(0, coolFans + caseFans + extra);
    if (fans) parts.push(['팬', fans * PSU_W.fan, `${fans}개 × ${PSU_W.fan}W (쿨러 ${coolFans}${coolNote} · 케이스 기본 ${caseFans}${extra ? ` · 추가 ${extra > 0 ? '+' : ''}${extra}` : ''})`]);
    if (pump) parts.push(['수랭 펌프', PSU_W.pump, '']);
    const hdd = Math.max(0, Math.round(Number(opt.hdd) || 0));
    if (hdd) parts.push(['HDD', hdd * PSU_W.hdd, `${hdd}개 × ${PSU_W.hdd}W`]);
    parts.push(['USB·기타', PSU_W.etc, '키보드·마우스 등']);
    const load = parts.reduce((a, p) => a + p[1], 0);
    const size = w => PSU_SIZES.find(x => x >= w) || Math.ceil(w / 100) * 100;
    const tiers = PSU_TIERS.map(([key, label, pct]) => ({ key, label, pct, need: Math.round(load * (1 + pct / 100)), w: size(load * (1 + pct / 100)) }));
    // 권장: 그래픽카드 칩셋 제조사 공식 권장 파워를 우선 (단, '사용 가능'보다 작으면 사용 가능 용량으로)
    const vr = gpuR ? gpuPsuRec(gpuR.it) : null;
    if (vr) {
      const w = Math.max(vr.w, tiers[0].w);
      Object.assign(tiers[1], { w, need: w, vendor: vr, raised: w > vr.w });
      if (tiers[2].w < w) tiers[2].w = tiers[2].need = w;
    }
    const merged = tiers[1].w === tiers[2].w;   // 권장 = 스윗스팟이면 한 줄로
    return { load, parts, tiers, merged, vendor: vr, ready: !!(cpuR || gpuR) };
  }
  // 파워 정격 출력: 시트 '정격 출력'(용량 구간 + 이름 숫자로 만든 값) → 이름의 '1000W' → 없음
  //   '용량' 칸은 '1000~1299W' 같은 구간이라 그대로 읽으면 1299W로 잘못 읽힘
  function psuWatt(it) {
    if (!it) return null;
    const n = (it.name.match(/\d{3,4}/g) || []).map(Number).find(x => x >= 300 && x <= 2500);   // 'SF-850F14XG'처럼 W가 없는 이름
    return firstW(spec(it, '정격 출력')) || firstW(it.name) || n || null;
  }
  // 담은 파워가 어느 단계인지: 'low'(부족) | 'min'(사용 가능) | 'rec'(권장) | 'sweet'(스윗스팟)
  function psuTier(calc, pw) {
    if (!pw || !calc) return null;
    const [mn, rc, sw] = calc.tiers;
    return pw >= sw.need ? 'sweet' : pw >= rc.need ? 'rec' : pw >= mn.need ? 'min' : 'low';
  }

  function averageScores(rows) {
    // 시트 계산기와 같이 케이스는 빼고(점수 없음) 나머지 부품의 평균
    const rs = rows.filter(r => r.it && r.it.cat !== '케이스');
    const avg = key => { const v = rs.map(r => scoreNum(r.it[key])).filter(x => x !== null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 100) / 100 : null; };
    return { perf: avg('perf'), rec: avg('rec'), n: rs.length };
  }

  // 그래픽카드 칩셋 순서: NVIDIA와 AMD를 따로 줄 세움 (섞지 않음). 새 칩셋이 나오면 여기에 추가
  const GPU_CHIP_ORDER = {
    NVIDIA: ['5050', '5060', '5060 Ti 8GB', '5060 Ti 16GB', '5070', '5070 Ti', '5080', '5090'],
    AMD: ['RX 9060', 'RX 9060 XT 8GB', 'RX 9060 XT 16GB', 'RX 9070 GRE', 'RX 9070', 'RX 9070 XT']
  };
  // "5060 Ti"처럼 VRAM 없이 적으면 그 칩셋 전체(8GB~16GB) 범위로 봄
  function gpuChipRank(v) {
    const s = String(v || '').trim().toLowerCase().replace(/^(rtx|geforce|지포스)\s*/, '').replace(/\s+/g, ' ');
    for (const [fam, ord] of Object.entries(GPU_CHIP_ORDER)) {
      const lo = ord.map(x => x.toLowerCase());
      const ex = lo.indexOf(s); if (ex >= 0) return { fam, lo: ex, hi: ex };
      const pre = lo.map((x, i) => x.startsWith(s + ' ') ? i : -1).filter(i => i >= 0);
      if (pre.length) return { fam, lo: Math.min(...pre), hi: Math.max(...pre) };
    }
    return null;
  }
  function cpuSocket(name) {
    const n = String(name);
    if (/그래니트|라파엘|피닉스|호크\s*포인트|그라도|라이젠\d-[56]세대/.test(n)) return 'AM5';
    if (/버미어|세잔|르누아르|피카소|마티스|라이젠\d-[34]세대/.test(n)) return 'AM4';
    if (/애로우\s*레이크|울트라\d?\s*시리즈\s*2/.test(n)) return '1851';
    if (/엘더\s*레이크|랩터\s*레이크|1[234]세대/.test(n)) return '1700';
    return '';
  }
  function mbSocket(it) { const s = spec(it, '소켓'); const m = s.match(/AM\d|1[78]\d\d/i); return m ? m[0].toUpperCase() : ''; }
  function mbDdr(it) {
    const s = mbSocket(it);
    if (s === 'AM4') return 'DDR4';
    if (s === 'AM5' || s === '1851') return 'DDR5';
    if (s === '1700') return /\bD4\b|DDR4/i.test(it.name) ? 'DDR4' : 'DDR5';
    return '';
  }
  // 메인보드 규격: 이름의 칩셋 표기(B850M → M-ATX, B850I / B650ITX → ITX)와 감점 요소의 규격 표기로 정함 (시트 전체 대조 완료)
  const FORM = ['ITX', 'M-ATX', 'ATX', 'E-ATX', 'SSI-CEB', 'SSI-EEB'];
  // 튜닝램 패키지: 시트 옵션이 세트 전체 용량(예: 32GB = 16GB×2)이고 가격도 세트 가격
  const isPkg = it => !!it && it.cat === 'RAM' && /패키지/.test(it.name);
  const PKG_STICKS = 2;   // 패키지 한 세트에 든 램 개수 (튜닝램은 대부분 2개 세트)
  // 판매 페이지의 "16GB×2"를 패키지 기준(32GB 1세트)으로 바꿈. 일반 램은 그대로
  function ramPack(it, cap, count) {
    count = count || 1;
    if (!isPkg(it)) return { cap, count };
    const gb = c => { const m = String(c || '').match(/(\d+)\s*GB/i); return m ? Number(m[1]) : 0; };
    const opts = new Set(it.prices.map(p => gb(p.opt)).filter(Boolean));
    const g = gb(cap);
    if (!g) return { cap, count: 1 };
    // 원문이 낱개 용량×개수면 전체 용량으로 (16GB×2 → 32GB, 16GB×4 → 64GB)
    // 낱개 용량×세트 개수로 나눔 (16GB×2 → 32GB 1세트, 16GB×4 → 32GB 2세트)
    if (count > 1 && count % PKG_STICKS === 0 && (opts.has(g * PKG_STICKS) || !opts.size)) return { cap: g * PKG_STICKS + 'GB', count: count / PKG_STICKS };
    let total = g * count;
    if (count === 1 && !opts.has(g) && opts.has(g * PKG_STICKS)) total = g * PKG_STICKS;   // "16GB"만 적혀 있고 패키지에 16GB가 없으면 16GB×2 세트로 봄
    return { cap: total + 'GB', count: 1 };
  }

  // ----- 레인 공유 분류 -----
  // 결과 태그: 무엇과 무엇이 공유하는지 드러나게 (M.2와 메인 슬롯 공유, SATA와 서브 슬롯 공유, 서브 슬롯과 USB4 공유 …)
  // 듀얼 그래픽카드(2개 슬롯) 사용 시 x8 x8은 공유로 보지 않고 x8/x8 지원으로만 표시
  const LANE_ORDER = ['M.2와 메인 슬롯 공유', '서브 슬롯과 메인 슬롯 공유', 'M.2와 서브 슬롯 공유', 'SATA와 서브 슬롯 공유', '서브 슬롯끼리 공유', '서브 슬롯과 USB4 공유', 'M.2와 USB4 공유', 'USB 포트끼리 대역폭 공유', '저장장치끼리 공유', '상시 x2로 작동'];
  const MAIN_REF = /1번\s*슬롯|PCIe\s*1번|x8\s*x4|(?:5\.0|4\.0|PCIe)\s*x16\s*슬롯|5\.0\s*x16슬롯/i;
  const SUB_REF = /\(@\d\)|x[124]\s*슬롯|PCIe\s*[2-5]\s*번|x16\s*[2-5]번|PCIe\s*\d\.0\s*슬롯|^\s*[2-5]번\s*슬롯/i;
  function laneClass(text, pcie) {
    const tags = new Set(), left = [];
    let x8x8 = /x8\s*x8/i.test(text) || /x16\(@8\)/i.test(pcie) || (String(pcie).match(/5\.0\s*x16(?!\s*\()/gi) || []).length >= 2;
    const t = String(text || '').trim();
    if (!t || /^(레인\s*공유\s*)?없음$/.test(t)) return { tags: ['없음'], x8x8, left };
    let prevPcie = false;
    for (let c of t.split(/\s*\+\s*|,\s*(?=M\.2|PCIe|SATA|USB|듀얼|MCIO|U\.2|x\d|\d번\s*슬롯\s*비활성|사용\s*시|\d개|바이오스|[2-5]\.0)/i)) {
      c = c.trim(); if (!c) continue;
      const hit = [];
      const trig = c.match(/^(.*)(?:사용\s*시|작동\s*시)(.*)$/);
      const src = trig ? trig[1] : '', tgt = trig ? trig[2] : c;
      const dual = /듀얼\s*그래픽|(?:2개|슬롯)\s*(?:슬롯\s*)?사용\s*시\s*x8\s*x8|x16으로\s*작동\s*시|2개\s*슬롯\s*사용\s*시/i.test(c) && !/M\.2|SATA/i.test(src);
      if (/바이오스/.test(c)) continue;   // "바이오스에서 변경 가능" 같은 설명
      if (dual) { x8x8 = x8x8 || /x8\s*x8/i.test(c); prevPcie = true; if (/상시/.test(c) && /x2|반토막/i.test(c)) tags.add('상시 x2로 작동'); continue; }
      if (/상시/.test(c) && /x2|반토막/i.test(c)) hit.push('상시 x2로 작동');
      const usb4 = /USB4|USB\s*40\s*Gbps|썬더볼트|thunderbolt/i.test(c);
      if (usb4 && /M\.2|x[24]\s*모드/i.test(c)) hit.push('M.2와 USB4 공유');
      else if (/USB/i.test(c) && /서로|끼리/.test(c) && !/M\.2|PCIe/i.test(c)) hit.push('USB 포트끼리 대역폭 공유');
      // PCIe 슬롯이 영향을 받는 경우 (대상 = "사용 시" 뒤, 없으면 문장 전체에서 M.2 부분을 뺀 나머지)
      const target = trig ? tgt : c.replace(/M\.2\s*\d번\s*슬롯(?:\([^)]*\))?(?:과|와)?/g, '');
      // 원인(사용 시 앞): M.2 / SATA / PCIe 슬롯. 앞이 비어 있으면 앞 문장의 M.2를 이어받은 것으로 봄
      const sM2 = !trig || /M\.2/i.test(src) || !/SATA|PCIe|x16|\(@|슬롯/i.test(src);
      const sSata = trig && /SATA/i.test(src) && !/M\.2/i.test(src);
      const sPcie = trig && /PCIe|x16|\(@/i.test(src.replace(/M\.2[^,]*?슬롯/g, ''));
      if (SUB_REF.test(target) && /PCIe|슬롯|x16|\(@/i.test(target) && !usb4) {
        if (sPcie && !/M\.2|SATA/i.test(src)) hit.push('서브 슬롯끼리 공유');
        else { if (sM2) hit.push('M.2와 서브 슬롯 공유'); if (sSata) hit.push('SATA와 서브 슬롯 공유'); }
      } else if (MAIN_REF.test(target) && !/상시/.test(target)) {
        if (sM2 || sSata) hit.push('M.2와 메인 슬롯 공유');
        if (sPcie) hit.push('서브 슬롯과 메인 슬롯 공유');
      } else if (usb4 && /PCIe|\(@/i.test(c)) hit.push('서브 슬롯과 USB4 공유');
      // 저장장치끼리 (M.2·SATA·U.2·MCIO)
      if (/SATA|U\.2|MCIO/i.test(c) && !/PCIe|x16|슬롯\s*x2/i.test(target.replace(/SATA\s*\d/g, ''))) hit.push('저장장치끼리 공유');
      else if (/M\.2\s*\d번\s*슬롯은\s*\d번/i.test(c) || (/^M\.2\s*\d번\s*(?:슬롯\s*)?비활성/i.test(c))) hit.push('저장장치끼리 공유');
      // "2번 슬롯 비활성화"처럼 앞 문장에 이어지는 조각
      if (!hit.length && prevPcie && /^\d번\s*슬롯\s*비활성/.test(c)) hit.push('M.2와 서브 슬롯 공유');
      if (!hit.length) left.push(c);
      hit.forEach(h => tags.add(h));
      prevPcie = /PCIe|x16|슬롯/i.test(c);
    }
    const out = LANE_ORDER.filter(x => tags.has(x));
    return { tags: out.length ? out : ['없음'], x8x8, left };
  }

  // ----- 칩셋 등급 (같은 소켓 계열 안에서만 비교) -----
  const CHIP_TIER = {
    AM4: ['A520', 'B550', 'X570'], AM5: [['A620', 'A620(A)'], ['B650'], ['B650E', 'B850'], ['X870'], ['X870E']],
    LGA1700: ['H610', 'B760', 'H770', 'Z790'], LGA1851: ['H810', 'B860', 'Z890']
  };
  function chipRank(chip) {
    const c = String(chip || '').toUpperCase().replace(/\s+/g, '').replace(/\(A\)$/, '');
    for (const [fam, tiers] of Object.entries(CHIP_TIER)) {
      const i = tiers.findIndex(t => (Array.isArray(t) ? t : [t]).some(x => x.toUpperCase().replace(/\(A\)$/, '') === c));
      if (i >= 0) return { fam, rank: i };
    }
    return null;
  }

  function mbForm(itOrName) {
    const it = typeof itOrName === 'object' ? itOrName : null, n = String(it ? it.name : itOrName);
    if (/E-?ATX/i.test(n) || (it && /E-?ATX/i.test(it.minus || ''))) return 'E-ATX';   // 시트 감점 요소에 E-ATX라고 적힌 보드
    const mn = it ? String(it.minus || '') : '';   // 감점 요소에 적힌 규격 (이름으로 알 수 없는 보드용)
    if (/(?<![a-z])(M-?ATX|mATX|마이크로\s*ATX)/i.test(mn)) return 'M-ATX';
    if (/(?<![a-z])(Mini-?ITX|ITX)(?![a-z])/i.test(mn)) return 'ITX';
    if (/\b[ABHQXZ]\d{3}E?-G\b/i.test(n)) return 'M-ATX';   // ASUS ROG STRIX B850-G 처럼 M 없이 G로 표기하는 M-ATX
    if (/ITX/i.test(n)) return 'ITX';
    if (/M-?ATX|mATX/i.test(n)) return 'M-ATX';
    const m = n.match(/\b[ABHQXZ]\d{3}([A-Z]*)(?:-([A-Z]+))?/i);
    if (m) {
      const suf = (m[1] || '').toUpperCase(), part = (m[2] || '').toUpperCase();
      if (/I$/.test(suf) || part === 'I') return 'ITX';
      if (suf.includes('M')) return 'M-ATX';
    }
    return 'ATX';
  }
  const isBtf = name => /BTF|프로젝트\s*제로|project\s*zero/i.test(name);
  // 전원부: "12+2페이즈, 총 600A Dr.MOS" / CPU "250W / 600A Dr.MOS"
  const ampOf = s => { const m = String(s || '').match(/(\d+)\s*A\b/); return m ? Number(m[1]) : null; };
  const vrmClass = s => (/SPS/i.test(s) ? 3 : /Dr\.?\s*MOS/i.test(s) ? 2 : /모스펫|mosfet/i.test(s) ? 1 : 0);
  const VRM_NAME = ['', '일반 모스펫', 'Dr.MOS', 'SPS'];
  // 수랭 라디에이터를 케이스 자리(전면/상단/하단/측면)에 달 수 있는지
  function radFits(posText, size) {
    const t = String(posText || '');
    if (!t || /^x$/i.test(t.trim()) || /불가|없음/.test(t) && !/\d{3}mm/.test(t)) return false;
    const max = Number((t.match(/(\d{3})\s*mm/) || [])[1] || 0);
    if (!max) return false;
    const fam = s => (s % 140 === 0 && s !== 840 ? 140 : 120);
    const banned = [...t.matchAll(/(\d{3})\s*mm\s*불가/g)].map(m => Number(m[1]));
    if (banned.includes(size) || banned.some(b => fam(b) === fam(size) && b <= size)) return false;
    if (fam(max) === fam(size)) return size <= max;
    // 다른 크기 계열: 420 자리 → 360까지, 480 자리 → 420까지(불가 표기 없으면), 360 자리 → 280, 280 자리 → 240, 240 자리 → 140
    const cross = { 420: 360, 480: 420, 360: 280, 280: 240, 240: 140, 140: 120 };
    return size <= (cross[max] || 0);
  }
  // 파워 CPU 보조전원 커넥터 목록: "8+(4+4) Y자 1개, 4+4 독립 1개" → ['8', '4+4', '4+4']
  function psuEps(text) {
    const out = [];
    for (const part of String(text || '').split(',')) {
      const m = part.match(/([\d+()]+)\s*(Y자|독립)\s*(\d+)\s*개/);
      if (!m) continue;
      const specTxt = m[1], n = Number(m[3]);
      let conns;
      if (m[2] === '독립') conns = [specTxt.replace(/[()]/g, '')];
      else if (specTxt === '4+4') conns = ['4+4', '4+4'];
      else conns = specTxt.split(/\+(?![^(]*\))/).map(s => s.replace(/[()]/g, ''));
      for (let i = 0; i < n; i++) out.push(...conns);
    }
    return out;
  }
  // 파워 PCIe 8핀 커넥터 개수: "독립 3개, Y자 1개" → 5개 (Y자 1개에 커넥터 2개)
  function psuPcie(text) {
    const t = String(text || ''); let n = 0, y = 0;
    for (const m of t.matchAll(/독립\s*(\d+)\s*개/g)) n += Number(m[1]);
    for (const m of t.matchAll(/Y자\s*(\d+)\s*개/g)) { n += Number(m[1]) * 2; y += Number(m[1]); }
    for (const m of t.matchAll(/8핀\s*(\d+)\s*개\s*\(그래픽카드측\)/g)) n += Number(m[1]);
    return { n, y, known: /\d/.test(t) };
  }

  // Y자 8핀 케이블을 써도 괜찮은 그래픽카드 최대 전력 (그래픽카드 8핀 개수별): 8핀 2개 카드는 약 220W, 3개 이상 카드는 약 360W까지
  const Y_CABLE_MAX_W = n8 => n8 <= 2 ? 220 : 360;
  function checkBuild(rows, opt) {
    const R = [];
    const add = (level, title, detail) => R.push({ level, title, detail: detail || '' });
    const one = cat => (rows.find(r => r.it && r.it.cat === cat) || {}).it;
    const cpu = one('CPU'), mb = one('메인보드'), gpu = one('그래픽카드'), psu = one('파워서플라이'), cs = one('케이스'), cool = one('CPU쿨러');
    const ramRow = rows.find(r => r.it && r.it.cat === 'RAM'), ram = ramRow && ramRow.it;
    const ssds = rows.filter(r => r.it && r.it.cat === 'SSD').map(r => r.it);

    // CPU ↔ 메인보드 소켓
    if (cpu && mb) {
      const a = cpuSocket(cpu.name), b = mbSocket(mb);
      if (a && b) a === b ? add('ok', `CPU 소켓 일치 (${a})`) : add('bad', 'CPU와 메인보드 소켓이 다름', `CPU ${a}, 메인보드 ${b} → 장착할 수 없습니다.`);
      // 전원부
      const need = ampOf(spec(cpu, '소비 전력 / 권장 전원부')), needCls = vrmClass(spec(cpu, '소비 전력 / 권장 전원부'));
      const have = ampOf(spec(mb, '전원부 성능')), haveCls = vrmClass(spec(mb, '전원부 성능'));
      if (need && have) {
        if (have < need * 0.7) add('bad', '메인보드 전원부가 많이 부족함', `CPU 권장 ${need}A, 메인보드 ${have}A → 성능 저하·발열 위험이 큽니다.`);
        else if (have < need) add('warn', '메인보드 전원부가 권장보다 약함', `CPU 권장 ${need}A, 메인보드 ${have}A → 고부하에서 클럭이 떨어질 수 있습니다.`);
        else if (needCls && haveCls && haveCls < needCls) add('warn', '메인보드 전원부 소자가 권장보다 낮음', `권장 ${VRM_NAME[needCls]}, 메인보드 ${VRM_NAME[haveCls]} (용량은 ${have}A로 충분)`);
        else add('ok', `메인보드 전원부 충분 (${have}A / 권장 ${need}A)`);
      }
    }
    // 내장 그래픽 없는 CPU
    if (cpu && !gpu) {
      const noIgpu = /\d{3,5}K?F\b/i.test(cpu.name) || (/라이젠\d-4세대/.test(cpu.name) && !/\d{4}G/i.test(cpu.name));
      if (noIgpu) add('bad', '그래픽카드가 필요함', '내장 그래픽이 없는 CPU라 그래픽카드 없이는 화면이 나오지 않습니다.');
    }
    // 램 ↔ 메인보드
    if (ram && mb) {
      const want = mbDdr(mb), gen = (spec(ram, '세대').match(/DDR\d/) || [])[0] || (ram.name.match(/DDR\d/) || [])[0] || '';
      if (want && gen) gen === want ? add('ok', `램 규격 일치 (${gen})`) : add('bad', '램 규격이 메인보드와 다름', `메인보드 ${want}, 램 ${gen} → 꽂을 수 없습니다.`);
      const slots = Number(spec(mb, '램 슬롯')) || 0, cnt = (ramRow.count || 1) * (isPkg(ram) ? sticksFor(ram, ramRow.opt) : 1);
      if (slots && cnt > slots) add('bad', '램 개수가 슬롯보다 많음', `메인보드 슬롯 ${slots}개, 램 ${cnt}개${isPkg(ram) ? ` (패키지 ${ramRow.count || 1}세트, 세트당 ${cnt / (ramRow.count || 1)}장)` : ''}`);
      const speed = Number((spec(ram, '클럭-CL').match(/^(\d{4,5})/) || [])[1] || (ram.name.match(/-(\d{4,5})/) || [])[1] || 0);
      const maxSp = Number(spec(mb, '램 속도')) || 0;
      if (speed && maxSp && speed > maxSp) add('warn', '램 속도가 메인보드 최대보다 빠름', `램 ${speed}, 메인보드 최대 ${maxSp} → ${maxSp} 이하로 동작합니다.`);
    }
    // 케이스 ↔ 메인보드 규격
    if (cs && mb) {
      const supTxt = spec(cs, '최대 지원 보드 규격'), form = mbForm(mb);
      const sup = FORM.filter(f => new RegExp('(^|[^-])' + f.replace('-', '\\-') + '(?![A-Z])', 'i').test(supTxt.replace(/\(BTF\)/gi, '')));
      const maxIdx = Math.max(-1, ...sup.map(f => FORM.indexOf(f)));
      if (maxIdx >= 0) FORM.indexOf(form) <= maxIdx ? add('ok', `메인보드 규격 장착 가능 (${form} → 케이스 최대 ${FORM[maxIdx]})`) : add('bad', '케이스가 메인보드 규격보다 작음', `메인보드 ${form}, 케이스 최대 ${supTxt}`);
      if (isBtf(mb.name)) /BTF/i.test(supTxt) ? add('ok', '후면 커넥터(BTF) 메인보드 지원 케이스') : add('bad', 'BTF 메인보드를 지원하지 않는 케이스', `메인보드가 후면 커넥터(BTF) 방식인데 케이스 지원 규격은 "${supTxt}"입니다.`);
    }
    // 케이스 ↔ 그래픽카드 길이
    if (cs && gpu) {
      const len = mm(spec(gpu, '가로 길이')), max = mm(spec(cs, '그래픽카드 최대 길이')) || mm(spec(cs, '그래픽카드'));
      const conds = String(spec(cs, '그래픽카드 길이 조건') || '').split(' / ').filter(Boolean);
      if (len && max) {
        if (len > max) add('bad', '그래픽카드가 케이스에 안 들어감', `그래픽카드 ${len}mm, 케이스 최대 ${max}mm`);
        else {
          // 주의사항의 조건부 길이 (예: 전면 라디에이터 장착 시 그래픽카드 최대 330mm)
          const over = conds.filter(c => { const n = Number((c.match(/최대\s*(\d+)\s*mm/) || [])[1] || 0); return n && len > n; });
          const shrink = conds.filter(c => /감소|-\s*쿨링팬/.test(c));
          if (over.length) add('warn', '조건에 따라 그래픽카드가 안 들어갈 수 있음', `그래픽카드 ${len}mm, 케이스 최대 ${max}mm. 단, ${over.join(' / ')}`);
          else if (max - len < 15) add('warn', '그래픽카드 길이 여유가 적음', `그래픽카드 ${len}mm, 케이스 최대 ${max}mm (여유 ${Math.round(max - len)}mm, 전면 라디·팬을 달면 부족할 수 있음)` + (shrink.length ? ` · ${shrink.join(' / ')}` : ''));
          else add('ok', `그래픽카드 길이 여유 (${len}mm / 최대 ${max}mm)` + (shrink.length ? ` · ${shrink.join(' / ')}` : ''));
        }
      }
    }
    // 케이스 ↔ 쿨러
    if (cool) {
      const type = spec(cool, '분류'), val = spec(cool, '수치');
      const water = /수랭/.test(type) && !/공랭/.test(type);
      if (cs && !water) {
        const h = mm(val), max = mm(spec(cs, '공랭 쿨러 최대 높이'));
        if (h && max) {
          if (h > max) add('bad', '공랭 쿨러가 케이스보다 높음', `쿨러 ${h}mm, 케이스 최대 ${max}mm → 옆판이 닫히지 않습니다.`);
          else if (max - h < 3) add('warn', '공랭 쿨러 높이 여유가 거의 없음', `쿨러 ${h}mm, 케이스 최대 ${max}mm`);
          else add('ok', `공랭 쿨러 높이 여유 (${h}mm / 최대 ${max}mm)`);
        }
      }
      if (cs && water) {
        const size = Number((type.match(/(\d{3})mm/) || [])[1] || 0);
        const radLen = Number((val.match(/^(\d+(?:\.\d+)?)mm/) || [])[1] || 0);
        const thick = (val.match(/\/\s*([\d.+]+)\s*mm/) || [])[1];
        const thickSum = mm(spec(cool, '라디+팬 두께')) || (thick ? thick.split('+').reduce((a, b) => a + Number(b), 0) : 0);   // 팬리스·팬 두께 미상은 일반 25T 팬 기준
        const fanless = /25T 팬 기준/.test(spec(cool, '라디+팬 두께'));
        if (size) {
          const pos = [['전면', '전면 라디'], ['상단', '상단 라디'], ['하단', '하단 라디'], ['측면', '측면 라디']].map(([n, h]) => [n, spec(cs, h)]).filter(([, t]) => t);
          const ok = pos.filter(([, t]) => radFits(t, size)).filter(([, t]) => {
            const mt = Number((t.match(/최대\s*두께\s*(\d+)/) || [])[1] || 0), ml = Number((t.match(/최대\s*길이\s*(\d+)/) || [])[1] || 0);
            return !(mt && thickSum && thickSum > mt) && !(ml && radLen && radLen > ml);
          });
          if (pos.length) ok.length ? add('ok', `${size}mm 수랭 장착 가능 (${ok.map(p => p[0]).join('·')})` + (fanless ? ` · 팬리스(또는 팬 두께 미상) 제품이라 일반 25T 팬을 단 기준(라디+팬 ${thickSum}mm)으로 계산` : ''))
            : add('bad', `${size}mm 수랭을 달 자리가 없음`, '케이스의 라디에이터 지원 크기·두께·길이를 확인하세요: ' + pos.map(([n, t]) => `${n} ${t}`).join(' / '));
          // 최대두께 대신 권장두께만 적힌 자리: 넘으면 확인 필요
          const rec = ok.filter(([, t]) => { const r = Number((t.match(/권장\s*두께\s*(\d+)/) || [])[1] || 0); return r && thickSum > r; });
          if (rec.length) add('warn', '라디에이터가 케이스 권장 두께보다 두꺼움', `라디+팬 ${thickSum}mm, ${rec.map(([n, t]) => `${n} ${t}`).join(' / ')} (최대두께 미확인)`);
          // 상단 라디 + 램 높이 제한 (예: 메모리 높이 52mm 이하)
          const rh = ram ? mm(spec(ram, '램 높이')) : 0;
          for (const [n, t] of ok) { const lim = Number((t.match(/메모리\s*높이\s*(\d+)\s*mm/) || [])[1] || 0); if (lim && rh && rh > lim) add('warn', `${n}에 라디를 달면 램과 간섭`, `램 높이 ${rh}mm, 케이스 ${n} 라디 장착 시 램 최대 ${lim}mm`); }
        }
      }
      // 쿨러 소켓 제한 (주의사항: AMD 소켓 미지원, 인텔 ○ 소켓 전용, 서버용 소켓만 지원 등)
      if (cpu) {
        const sk = cpuSocket(cpu.name), okSk = coolerSocketOk(cool, sk);
        if (okSk === false) add('bad', 'CPU 쿨러가 이 소켓을 지원하지 않음', `CPU ${sk} · 쿨러 주의사항: ${spec(cool, '주의사항')} → 주의사항을 꼭 확인하세요.`);
      }
      // 램 높이 ↔ 공랭 쿨러
      if (ram && !water) {
        const rh = mm(spec(ram, '램 높이')), lim = spec(cool, '램 높이');
        if (rh && /간섭\s*없음/.test(lim)) add('ok', '램과 쿨러 간섭 없음');
        else if (rh && mm(lim)) rh > mm(lim) ? add('warn', '램이 쿨러 팬에 걸릴 수 있음', `램 높이 ${rh}mm, 쿨러 팬 아래 최대 ${mm(lim)}mm → 팬을 위로 올려 달아야 하고, 그만큼 쿨러가 높아집니다.`)
          : add('ok', `램과 쿨러 간섭 없음 (램 ${rh}mm / 최대 ${mm(lim)}mm)`);
      }
    }
    // 파워 용량 (파워 계산기: 부품별 예상 소비 전력 + 마진 %)
    if (psu) {
      const pw = psuWatt(psu);
      const pc = psuCalc(rows, opt && opt.psu);
      if (pw && pc.ready) {
        const [mn, rc, sw] = pc.tiers, t = psuTier(pc, pw), rate = Math.round(pc.load / pw * 100);
        if (t === 'low') add('bad', '파워 용량 부족', `예상 최대 소비 ${pc.load}W → 최소 ${mn.w}W 이상 필요 (파워 ${pw}W)`);
        else if (t === 'min') add('warn', '파워 용량 여유가 적음', `예상 최대 소비 ${pc.load}W, 파워 ${pw}W (부하율 약 ${rate}%) → 사용은 가능하지만 권장 ${rc.w}W보다 작습니다.`);
        else add('ok', `파워 용량 ${t === 'sweet' ? '충분 · 스윗스팟' : '충분'} (예상 ${pc.load}W / ${pw}W, 부하율 약 ${rate}%)`);
      }
    }
    // 파워 케이블: 그래픽카드 전원
    if (psu && gpu) {
      const port = spec(gpu, '전원 포트'), gw = firstW(spec(gpu, '소비 전력(최대 제한 전력)')) || 0;
      const p8 = psuPcie(spec(psu, 'PCIe 8핀 케이블')), h = spec(psu, '12V-2x6 케이블');
      const need8 = Number((port.match(/8핀\s*(\d+)\s*개/) || [])[1] || 0);
      if (/12V-2x6|12VHPWR/i.test(port)) {
        const hw = Number((h.match(/(\d{3})\s*W/) || [])[1] || 0);
        if (hw && /\d+\s*개/.test(h)) hw >= gw ? add('ok', `그래픽카드 12V-2x6 케이블 연결 가능 (파워 ${hw}W 케이블)`) : add('warn', '12V-2x6 케이블 용량이 그래픽카드보다 낮음', `케이블 ${hw}W, 그래픽카드 ${gw}W`);
        else {
          const n8 = Math.max(2, Math.ceil(gw / 150));
          if (p8.known) p8.n >= n8 ? add('warn', '파워에 12V-2x6 케이블이 없음', `그래픽카드에 동봉된 변환 젠더(8핀 ${n8}개)로 연결해야 합니다. 파워 8핀 ${p8.n}개로 연결은 가능합니다.`)
            : add('bad', '그래픽카드 전원 연결 불가', `12V-2x6 케이블이 없고, 변환 젠더에 필요한 8핀 ${n8}개보다 파워 8핀이 적습니다(${p8.n}개).`);
        }
      } else if (need8 && p8.known) {
        if (p8.n < need8) add('bad', '그래픽카드 8핀 케이블 부족', `그래픽카드 8핀 ${need8}개 필요, 파워 ${p8.n}개`);
        else {
          const useY = need8 >= 2 && p8.n - p8.y < need8, yMax = Y_CABLE_MAX_W(need8);
          if (useY && gw > yMax) add('warn', 'Y자 8핀 케이블을 써야 함', `그래픽카드 8핀 ${need8}개를 독립 케이블로 모두 연결할 수 없어 Y자 케이블 사용 (${gw}W 카드는 독립 케이블 권장, 8핀 ${need8}개 카드는 약 ${yMax}W까지 Y자 사용 가능)`);
          else if (useY) add('note', `그래픽카드 8핀 ${need8}개 연결 가능 (Y자 케이블 사용)`, `독립 케이블로 모두 연결할 수 없어 Y자 케이블로 8핀 2개를 함께 연결합니다. ${gw ? gw + 'W 카드라 ' : ''}사용은 가능하지만, 독립 케이블이 충분한 파워가 안전 마진이 더 높습니다.`);
          else add('ok', `그래픽카드 8핀 ${need8}개 연결 가능 (파워 ${p8.n}개)`);
        }
      }
    }
    // 파워 케이블: CPU 보조전원
    if (psu && mb) {
      const need = String(spec(mb, '보조전원')).split('+').map(s => s.trim()).filter(s => /^[48]$/.test(s));
      const have = psuEps(spec(psu, 'CPU 보조전원'));
      if (need.length && have.length) {
        const pool = [...have]; const miss = [];
        for (const n of need.sort((a, b) => b - a)) {
          const i = n === '8' ? pool.findIndex(c => c === '8' || c === '4+4') : pool.findIndex(c => c === '4' || c === '4+4');
          if (i >= 0) pool.splice(i, 1); else miss.push(n);
        }
        const needTxt = need.join('+'), haveTxt = spec(psu, 'CPU 보조전원');
        if (!miss.length) add('ok', `CPU 보조전원 ${needTxt}핀 연결 가능`);
        else if (miss.length < need.length && need[0] === '8' && !(miss.length === need.length)) {
          // 첫 8핀만 꽂히면 부팅은 됨 (추가 4핀·8핀은 고부하용)
          const missTxt = miss.map(m => m + '핀').join(', ');
          add('warn', `CPU 보조전원 ${needTxt}핀 중 ${missTxt}을 못 꽂음`, `파워: ${haveTxt}. 8핀 하나만 꽂아도 대부분 동작하지만, 고성능 CPU는 모두 연결하는 걸 권장합니다.`);
        }
        else add('bad', 'CPU 보조전원 케이블 부족', `메인보드 ${needTxt}핀, 파워: ${haveTxt}`);
      }
    }
    // SSD 자리
    if (mb && ssds.length) {
      const m2 = ssds.filter(s => /M\.2|NVMe/i.test(s.name)).length, sata = ssds.length - m2;
      const m2Slots = [...String(spec(mb, 'M.2')).matchAll(/(\d+)\s*개/g)].reduce((a, m) => a + Number(m[1]), 0);
      const sataPorts = Number(spec(mb, 'SATA')) || 0;
      if (m2 && m2Slots) m2 <= m2Slots ? add('ok', `M.2 SSD ${m2}개 장착 가능 (슬롯 ${m2Slots}개)`) : add('bad', 'M.2 슬롯 부족', `M.2 SSD ${m2}개, 메인보드 슬롯 ${m2Slots}개`);
      if (sata && sataPorts && sata > sataPorts) add('bad', 'SATA 포트 부족', `SATA SSD ${sata}개, 메인보드 ${sataPorts}개`);
    }
    // 케이스 전면 USB-C ↔ 메인보드 헤더
    if (cs && mb) {
      const front = spec(cs, '전면 USB'), head = spec(mb, '전면 USB 헤더');
      if (/Type-C/i.test(front) && head) /Type-C/i.test(head) ? add('ok', '케이스 전면 C타입 포트 사용 가능') : add('warn', '케이스 전면 C타입 포트를 못 씀', '메인보드에 전면 C타입 헤더가 없습니다.');
    }
    const order = { bad: 0, warn: 1, ok: 2 };
    return R.sort((a, b) => order[a.level] - order[b.level]);
  }


  // ===== 부품 검색창에서 묻기: "B850M MAX GAMING 레인 공유", "7800X3D랑 B850M 박격포 호환" =====
  // [질문에 들어간 말, 시트 열 이름]
  const ASK_SPEC = [
    [/레인\s*공유/, /레인 공유/], [/보조\s*전원(?!\s*포트)/, /보조전원|CPU 보조전원/], [/전원부/, /전원부/],
    [/m\.?2/i, /^M\.2/], [/sata/i, /^SATA/], [/램\s*슬롯|메모리\s*슬롯/, /램 슬롯/], [/램\s*속도|메모리\s*속도|최대\s*속도/, /램 속도/],
    [/램\s*용량|메모리\s*용량|최대\s*용량/, /램 용량/], [/pci-?e\s*슬롯|확장\s*슬롯|pcie/i, /PCIe 슬롯|PCIE 슬롯/i], [/(?<![a-z])usb(?![a-z])|헤더/i, /USB|^A$|^C$/],
    [/와이파이|wi-?fi|블루투스/i, /WIFI/i], [/유선\s*랜|랜\s*속도|\blan\b/i, /유선랜/], [/사운드|오디오/, /사운드/], [/방열판/, /방열판/],
    [/그래픽\s*카드\s*길이|vga\s*길이/i, /^그래픽카드$|가로 길이/], [/파워\s*길이/, /^파워서플라이$/], [/길이/, /길이/], [/두께/, /두께/],
    [/쿨러\s*높이/, /공랭 쿨러|수치/], [/램\s*높이/, /램 높이/], [/높이/, /높이|수치/], [/소비\s*전력|전력|tdp/i, /소비 전력/],
    [/전원\s*포트|커넥터|8핀|12v/i, /전원 포트|8핀|12V-2x6|SATA 전원|MOLEX/], [/클럭/, /클럭/], [/캐시/, /캐시/], [/코어|스레드/, /코어/],
    [/(?<![가-힣])다이(?![가-힣])/, /^다이$/], [/보증|(?<![a-z])a\/?s(?![a-z])/i, /보증|AS 기간/], [/컨트롤러/, /컨트롤러/], [/낸드/, /낸드/], [/디램|dram/i, /디램/],
    [/읽기|쓰기|속도/, /읽기|쓰기/], [/tbw|내구/i, /TBW/], [/slc/i, /SLC/], [/모듈러/, /모듈러/], [/콘덴서|커패시터/, /콘덴서/],
    [/oem/i, /OEM/], [/인증|80\s*plus|사이버네틱스|cybenetics/i, /80PLUS|Cybenetics/], [/케이블/, /케이블|커넥터/], [/라디|수랭/, /라디/],
    [/(?<![가-힣])팬(?:\s*구성|\s*개수)?(?![가-힣])/, /팬/], [/사이즈|크기/, /사이즈|가로 길이|세로 길이|^규격$/], [/보드\s*규격|지원\s*규격|(?<![가-힣])규격(?![가-힣])|폼\s*팩터|form\s*factor/i, /보드 규격|^규격$/], [/확장|베이|하드/, /^확장$/],
    [/호스/, /호스/], [/주의/, /주의사항/], [/소켓/, /소켓/], [/칩셋/, /칩셋/], [/(?<![가-힣\d-])세대(?![가-힣])/, /^세대$/], [/(?<![가-힣a-z-])타입(?![가-힣])/i, /^타입$/]
  ];
  const ASK_EXTRA = [[/이슈|문제/, 'issue', '이슈'], [/장점|가점/, 'plus', '가점 요소'], [/단점|감점/, 'minus', '감점 요소'],
    [/점수|평가/, 'score', '점수'], [/가격|최저가|얼마/, 'price', '최저가']];
  const ASK_FILLER = /알려\s*줘|알려\s*주세요|뭐야|뭔가요|어때|어떄|어떤가요|인가요|있어|있나요|여부|정보|스펙|사양|몇\s*개|몇|\?|？/g;
  const COMPAT_Q = /호환|맞아|맞나|맞는지|들어가|장착\s*(가능|돼|되)|같이\s*써|쓸\s*수/;

  function stripParticles(s) {
    return s.split(/\s+/).map(t => t.replace(/(이랑|랑|하고|의|은|는|이|가|을|를|와|과|에|도)$/, m => (t.length - m.length >= 2 ? '' : m))).join(' ');
  }
  function findPart(db, text, cat) {
    const q = stripParticles(text).replace(/\s+/g, ' ').trim();
    if (q.replace(/[^a-z0-9가-힣]/gi, '').length < 2) return null;
    let hits = search(db, q, cat);
    if (hits.length) {
      const ql = q.toLowerCase();
      hits = hits.map(it => ({ it, s: (it.name.toLowerCase().includes(ql) ? 0 : 1) * 1000 + it.name.length })).sort((a, b) => a.s - b.s).map(x => x.it);
      return { it: hits[0], others: hits.slice(1, 4) };
    }
    const m = matchLine(db, cat ? `${cat} : ${q}` : q);
    return m && m.cands.length ? { it: m.cands[0].it, others: m.cands.slice(1, 4).map(x => x.it), guess: true } : null;
  }

  function askSpec(db, query, cat) {
    let q = ' ' + String(query || '') + ' ';
    // 호환 질문: 부품 두 개 이상
    if (COMPAT_Q.test(q)) {
      const body = q.replace(COMPAT_Q, ' ').replace(/(되나요|돼|되|해|할까|하나요|한가요|은지|는지|인지)\s*$/g, ' ').replace(ASK_FILLER, ' ');
      const segs = body.split(/(?:이랑|랑|하고|와|과)(?=\s)|[,/+&]|\s그리고\s|\s및\s/).map(s => s.trim()).filter(s => s.replace(/[^a-z0-9가-힣]/gi, '').length >= 2);
      if (segs.length >= 2) {
        const parts = segs.map(s => findPart(db, s)).filter(Boolean);
        if (parts.length >= 2) return { kind: 'compat', parts, checks: checkBuild(parts.map(p => ({ it: p.it, count: 1 }))) };
      }
    }
    let pats = [], extras = [];
    for (const [re, hp] of ASK_SPEC) { const m = q.match(re); if (m) { pats.push({ hp, word: m[0] }); q = q.replace(re, ' '); } }
    for (const [re, key, label] of ASK_EXTRA) if (re.test(q)) { extras.push([key, label]); q = q.replace(re, ' '); }
    if (!pats.length && !extras.length) return null;
    let rest = q.replace(ASK_FILLER, ' ').replace(/\s+/g, ' ').trim();
    let found = findPart(db, rest, cat);
    if (!found) return { kind: 'spec', rest, part: null };
    // 질문 말이 사실 제품 이름의 일부였던 경우(예: "B850M MAX GAMING WIFI"의 WIFI)는 이름으로 되돌림
    const inName = w => found.it.name.toLowerCase().includes(w.toLowerCase().trim());
    if (pats.some(p => inName(p.word))) {
      const back = pats.filter(p => inName(p.word));
      pats = pats.filter(p => !inName(p.word));
      if (!pats.length && !extras.length) return null;
      rest = (rest + ' ' + back.map(p => p.word).join(' ')).trim();
      found = findPart(db, rest, cat) || found;
    }
    const it = found.it, fields = [];
    for (const [h, v] of it.specs) if (pats.some(p => p.hp.test(h))) fields.push([h, v]);
    for (const [key, label] of extras) {
      if (key === 'score') { if (it.perf || it.rec) fields.push([label, `성능 ${it.perf || '-'} / 추천 ${it.rec || '-'}`]); }
      else if (key === 'price') fields.push([label, it.prices.length ? it.prices.map(p => (p.opt ? p.opt + ' ' : '') + (p.price == null ? '판매 정보 없음' : p.price.toLocaleString('ko-KR') + '원')).join(', ') : '판매 정보 없음']);
      else fields.push([label, it[key] || '없음']);
    }
    return { kind: 'spec', rest, part: found, fields };
  }


  // 패키지 1세트의 램 개수: 보통 2개, 세트가 128GB를 넘으면 4개 (192GB = 48GB×4)
  const pkgSticks = gb => (gb > 128 ? 4 : PKG_STICKS);
  // 그 용량의 램 장수: 다나와 구성(48G*4)이 있으면 그것, 없으면 패키지는 위 규칙, 일반 램은 1장
  function sticksFor(it, cap) {
    const gb = Number((String(cap || '').match(/(\d+)\s*GB/i) || [])[1] || 0);
    const k = it && it.kits && it.kits[cap]; const m = k && String(k).match(/(\d+)\s*G\w*\s*[*xX×]\s*(\d+)/);
    if (m && Number(m[2]) > 0) return Number(m[2]);
    return isPkg(it) ? pkgSticks(gb) : 1;
  }
  // ===== 스펙 통합: 시트 원문에서 검색용 항목을 만들어 원래 항목 바로 뒤에 넣음 =====
  // 비교 방식: rank = 순서 목록으로 이상·이하, max = "20+10" 중 큰 값, tags = 쉼표로 나뉜 값 하나하나, num = 첫 숫자
  const FIELD_META = {
    '모스펫 종류': { type: 'rank', order: ['일반', 'Dr.MOS', 'SPS'] },
    '전원부 방열판 등급': { type: 'rank', order: ['없음', '좌측', '좌측+상단', '좌측+상단 히트파이프 연결', '좌측+상단 쿨링팬', '좌측+상단 쿨링팬, 히트파이프'] },
    '사운드 등급': { type: 'rank', order: ['ALC897급', 'ALC1220·ALC4080급', 'ALC1220·ALC4080급+앰프', 'ALC1220·ALC4080급+DAC'] },
    '디버그 표시': { type: 'rank', order: ['없음', '디버그 LED', 'POST CODE'] },
    '부가기능 태그': { type: 'tags' },
    '전면 C타입 헤더 속도': { type: 'max' }, '후면 C타입 최고 속도': { type: 'max' }, '랜 속도': { type: 'max' }, '전면 C타입 속도': { type: 'max' },
    '썬더볼트': { type: 'rank', order: ['없음', 'Thunderbolt 4', 'Thunderbolt 5'] },
    '레거시 PCI': { type: 'rank', order: ['없음', '있음'] },
    '다이 제조사': { type: 'tags' }, '다이 근거': { type: 'rank', order: ['수율로 추정', '공식 확정'] },
    '다이 종류': { type: 'tags' }, '수율': { type: 'rank', order: ['일반', '선별', '고수율', '고수율 선별'] },
    '보증 기간': { type: 'rank', order: ['6개월', '1년', '제조일로부터 1년6개월', '2년', '3년', '5년', '7년', '10년', '리미티드 라이프타임'], alias: { '라이프타임': '리미티드 라이프타임' } },
    '이슈 태그': { type: 'tags' }, '유통 용량': { type: 'tags' },
    '쿨링 등급': { type: 'rank', order: ['최하급기', '하급기', '중하급기', '중급기', '중상급기', '상급기', '최상급기'] },
    '베이퍼챔버 여부': { type: 'rank', order: ['없음', '혼재', '있음'] },
    '인터페이스': { type: 'rank', order: ['PCIe 3.0', 'PCIe 4.0', 'PCIe 5.0'] },
    '용량 급': { type: 'rank', order: ['128GB급', '250GB급', '500GB급', '1TB급', '2TB급', '4TB급', '8TB급'] },
    '컨트롤러 제조사': { type: 'tags' }, '낸드 제조사': { type: 'tags' },
    '80PLUS 등급': { type: 'rank', order: ['미인증', '스탠다드', '브론즈', '실버', '골드', '플래티넘', '티타늄'] },
    'CPU 보조전원 구성': { type: 'rank', order: ['8', '8+4', '8+8'] },
    '모듈러 방식': { type: 'rank', order: ['논모듈러', '세미모듈러', '풀모듈러'] },
    '사이베네틱스 효율': { type: 'rank', order: ['브론즈', '실버', '골드', '플래티넘', '티타늄', '다이아몬드'] },
    '사이베네틱스 소음': { type: 'rank', order: ['스탠다드', '스탠다드+', '스탠다드++', 'A-', 'A', 'A+', 'A++'] },
    '보드 규격 등급': { type: 'rank', order: FORM }, '규격': { type: 'rank', order: FORM },
    '메인 슬롯': { type: 'rank', order: ['3.0 x16', '4.0 x16', '5.0 x16'] },
    '기타 크기 팬': { type: 'tags' }, '레인 공유 분류': { type: 'tags' },
    'BTF 지원': { type: 'tags' }, '파워 규격': { type: 'tags' },
    '전면 라디 최대두께': { type: 'num', unknownPass: /미확인/ }, '상단 라디 최대두께': { type: 'num', unknownPass: /미확인/ },
    '하단 라디 최대두께': { type: 'num', unknownPass: /미확인/ }, '측면 라디 최대두께': { type: 'num', unknownPass: /미확인/ }
  };
  // 순서 목록에서 값의 위치 (값 뒤에 붙은 설명은 무시: "상급 (rev 1.0은 …)" → 상급)
  function rankOf(h, v) {
    const m = FIELD_META[h]; if (!m || m.type !== 'rank') return -1;
    let s = String(v || '').trim();
    if (m.alias) for (const [a, b] of Object.entries(m.alias)) if (s === a || s.startsWith(a + ' ')) s = b;
    let best = -1, len = 0;
    m.order.forEach((o, i) => { if ((s === o || s.startsWith(o + ' ') || s.startsWith(o + '(')) && o.length >= len) { best = i; len = o.length; } });
    return best;
  }
  function putAfter(it, after, pairs) {
    pairs = pairs.filter(Boolean);
    for (const arr of [it.allSpecs, it.specs]) {
      const add = arr === it.specs ? pairs.filter(([, v]) => v !== '' && v != null) : pairs;
      let k = typeof after === 'string' ? arr.findIndex(([h]) => h === after) : -1;
      if (typeof after !== 'string') k = arr.findIndex(([h]) => after.test(h));
      arr.splice(k >= 0 ? k + 1 : arr.length, 0, ...add.map(([h, v]) => [h, v == null ? '' : String(v)]));
    }
  }
  const sv = (it, h) => { const s = (it.allSpecs || it.specs).find(([k]) => (typeof h === 'string' ? k === h : h.test(k))); return s ? String(s[1] || '').trim() : ''; };
  const sumCnt = (s, re) => [...String(s).matchAll(re)].reduce((a, m) => a + Number(m[1]), 0);
  const unk = s => /^(불명|\?|)$/.test(String(s || '').trim());
  const maxPlus = arr => arr.length ? arr.sort((a, b) => b - a).map(x => +(+x).toFixed(1)).join('+') : '';

  // ----- CPU -----
  function deriveCpu(it) {
    const sock = cpuSocket(it.name);
    putAfter(it, '제조사', [['소켓', sock ? (/^AM/.test(sock) ? sock : 'LGA' + sock) : '']]);
    const ct = sv(it, '코어/스레드');
    if (ct) {
      const pe = ct.match(/P\s*(\d+)\s*\+\s*E\s*(\d+)/i), c1 = ct.match(/(\d+)\s*코어/), th = ct.match(/(\d+)\s*스레드/);
      const cores = pe ? Number(pe[1]) + Number(pe[2]) : c1 ? Number(c1[1]) : 0;
      putAfter(it, '코어/스레드', [['코어 수', cores ? cores + '코어' : ''], ['스레드 수', th ? th[1] + '스레드' : '']]);
    }
    const pw = sv(it, /^소비\s*전력\s*\/\s*권장\s*전원부/);
    if (pw) {
      const [a, b] = pw.split(/\s*\/\s*/);
      putAfter(it, /^소비\s*전력\s*\/\s*권장\s*전원부/, [['소비 전력', (String(a).match(/(\d+)\s*W/i) || [])[1] ? (String(a).match(/(\d+)\s*W/i))[1] + 'W' : ''], ['권장 전원부', b && /\d+\s*A/.test(b) ? b.trim() : '']]);
    }
    const l3 = sv(it, 'L3 캐시');
    if (l3) putAfter(it, 'L3 캐시', [['CCD당 L3 캐시', l3]]);   // 96+32MB는 CCD별 값 (합치지 않음)
  }

  // ----- 메인보드 -----
  function deriveMainboard(it) {
    const m2 = sv(it, 'M.2');
    if (m2) putAfter(it, 'M.2', [['M.2 전체 슬롯 수', sumCnt(m2, /(\d+)\s*개/g) + '개'], ['M.2 5.0 슬롯 수', sumCnt(m2, /5\.0\s*(\d+)\s*개/g) + '개']]);
    const ra = sv(it, 'A'), rc = sv(it, 'C');
    if (ra !== '' || rc !== '') putAfter(it, 'C', [['후면 A타입 수', ra !== '' ? Number(ra) + '개' : ''], ['후면 C타입 수', rc !== '' ? Number(rc) + '개' : '']]);
    // 팬/RGB 헤더
    const fr = sv(it, /팬\/RGB/);
    if (fr) {
      let fan = 0, argb = 0, rgb = 0, own = 0;
      for (const p of fr.split(/\s*,\s*/)) {
        const n = Number((p.match(/(\d+)\s*개/) || [])[1] || 0);
        if (/NZXT|수랭\s*전용|전용/.test(p)) own += n;
        else if (/팬\s*헤더/.test(p)) fan += n;
        else if (/ARGB/i.test(p)) argb += n;
        else if (/RGB/i.test(p)) rgb += n;
      }
      putAfter(it, /팬\/RGB/, [['팬헤더 수', fan + '개'], ['ARGB 헤더 수', argb + '개'], ['12V RGB 헤더 수', rgb + '개'], ['전용 커넥터 수', own + '개']]);
    }
    // 전원부: 총 전류, 모스펫 종류
    const vr = sv(it, '전원부 성능');
    if (vr) {
      const a = (vr.match(/(\d+)\s*A\b/) || [])[1];
      const kind = /SPS/i.test(vr) ? 'SPS' : /Dr\.?\s*MOS/i.test(vr) ? 'Dr.MOS' : /모스펫/.test(vr) ? '일반' : '';
      putAfter(it, '전원부 성능', [['전원부 총 전류', a ? a + 'A' : ''], ['모스펫 종류', kind]]);
    }
    // 전원부 방열판 등급: 없음 < 좌측(한쪽만) < 좌측+상단(두 면 이상) < 히트파이프 < 쿨링팬 < 쿨링팬+히트파이프 ((A)/(S) 표기는 쓰지 않음)
    const hs = sv(it, '방열판');
    if (hs) {
      let g;
      if (/^없음/.test(hs)) g = '없음';
      else if (/쿨링팬/.test(hs) && /히트파이프/.test(hs)) g = '좌측+상단 쿨링팬, 히트파이프';
      else if (/쿨링팬/.test(hs)) g = '좌측+상단 쿨링팬';
      else if (/히트파이프/.test(hs)) g = '좌측+상단 히트파이프 연결';
      else if (/\+/.test(hs.replace(/\s*\([AS]\)/gi, ''))) g = '좌측+상단';
      else g = '좌측';   // 좌측·상단 한쪽만
      putAfter(it, '방열판', [['전원부 방열판 등급', g]]);
    }
    // M.2 방열판: 슬롯 수, 양면 슬롯 수, 무나사 슬롯 수
    const m2h = sv(it, 'M.2 방열판 여부');
    if (m2h) {
      const sl = m2Heatsinks(m2h);
      if (sl) { const v = Object.values(sl); putAfter(it, 'M.2 방열판 여부', [['M.2 방열판 슬롯 수', v.length + '개'], ['양면 방열판 슬롯 수', v.filter(x => x.dbl).length + '개'], ['무나사 방열판 슬롯 수', v.filter(x => x.free).length + '개']]); }
    }
    const clip = sv(it, /M\.2 이지/);
    if (clip && !unk(clip)) putAfter(it, /M\.2 이지/, [['이지 클립 슬롯 수', (/없음/.test(clip) ? 0 : (clip.replace(/번.*$/, '').match(/\d+/g) || []).length) + '개']]);
    // PCIe 슬롯
    const pc = sv(it, /^PCIe 슬롯$/i);
    if (pc) {
      const slots = [];
      for (const m of pc.matchAll(/([345]\.0)\s*[xX](\d+)\s*(?:\(?@(\d+)\)?)?(?:\s*(\d+)\s*개)?/g)) for (let i = 0; i < (Number(m[4]) || 1); i++) slots.push({ gen: Number(m[1]), phys: Number(m[2]), el: Number(m[3] || m[2]) });
      const legacy = (pc.match(/레거시\s*PCI/g) || []).length;
      const x16 = slots.filter(s => s.phys === 16);
      const main = x16.sort((a, b) => b.el - a.el || b.gen - a.gen)[0];
      const open = [...pc.matchAll(/\(([^)]*뚫려[^)]*)\)/g)].filter(m => !/간섭/.test(m[1])).length;
      putAfter(it, /^PCIe 슬롯$/i, [['메인 슬롯', main ? `${main.gen.toFixed(1)} x${main.el}` : ''], ['x16 형태 슬롯 수', x16.length + '개'], ['전체 슬롯 수', slots.length + legacy + '개'],
        ['레거시 PCI', legacy ? '있음' : '없음'], ['우측 뚫림 슬롯 수', open + '개']]);
    }
    // 전면 USB 헤더
    const fu = sv(it, '전면 USB 헤더');
    if (fu) putAfter(it, '전면 USB 헤더', frontUsb(fu, '헤더'));
    // 후면 USB
    const ru = sv(it, '후면 USB 포트');
    if (ru) {
      const r = ru.replace(/Typc/gi, 'Type');
      const tb = (r.match(/Thunderbolt\s*(\d)/i) || [])[1];
      const cs = [...r.matchAll(/(\d+)\s*Gbps\s*Type-C/gi)].map(m => Number(m[1])); if (tb) cs.push(40);
      putAfter(it, '후면 USB 포트', [['썬더볼트', tb ? 'Thunderbolt ' + tb : '없음'], ['후면 C타입 최고 속도', cs.length ? Math.max(...cs) + 'Gbps' : '없음'],
        ['후면 A타입 3.x 수', sumCnt(r, /Gbps\s*Type-A\s*(\d+)\s*개/gi) + '개'], ['후면 2.0 수', sumCnt(r, /(?<![\d.])2\.0\s*(\d+)\s*개/g) + '개']]);
    }
    // 유선랜: 내부망용 제외
    const lan = sv(it, '유선랜 속도');
    if (lan) {
      const parts = lan.split(/,\s*(?=[\d내])/).filter(p => !/내부망/.test(p));
      const sp = parts.map(p => Number((p.match(/([\d.]+)\s*Gbps/) || [])[1])).filter(Boolean);
      putAfter(it, '유선랜 속도', [['랜 속도', sp.length ? maxPlus(sp) + 'Gbps' : ''], ['랜 포트 수', sp.length + '개']]);
    }
    // 사운드 등급
    const snd = sv(it, '사운드칩셋');
    if (snd && !unk(snd)) {
      let cur = snd, note = '';
      const rev = snd.match(/rev\s*([\d.]+)\s*:\s*([^,]+),\s*rev\s*([\d.]+)\s*이후\s*:\s*(.+)$/i);
      if (rev) { cur = rev[4]; note = ` (rev ${rev[1]}은 ${rev[2].replace(/리얼텍\s*/, '').trim()} — 중고 거래 시 유의)`; }
      const hi = /ALC\s*(1220|4080|4082|4050)|S1220|S1200A|ALCS1200/i.test(cur), lo = /ALC\s*(897|887|892|1200(?!A))/i.test(cur) && !hi;
      const dac = /DAC/i.test(cur), amp = /앰프/.test(cur);
      const H = 'ALC1220·ALC4080급';
      let g = hi ? H : lo ? 'ALC897급' : (dac ? H : '');
      if (g === H && dac) g = H + '+DAC'; else if (g === H && amp) g = H + '+앰프';
      if (g && dac && !hi && !lo) note = ' (DAC 단독, 별도 코덱 없음)' + note;
      if (g) putAfter(it, '사운드칩셋', [['사운드 등급', g + note]]);
    }
    // 부가기능: 태그 정리 + 디버그 표시
    const ex = sv(it, '부가기능');
    if (ex) {
      const tags = new Set();
      for (let t of ex.split(/\s*,\s*/)) {
        t = t.trim(); if (!t || t === '없음') continue;
        if (/커스텀\s*가능(한)?\s*리셋/.test(t)) { tags.add('리셋 버튼'); tags.add('커스텀 버튼'); continue; }
        if (/커스텀\s*(가능\s*)?버튼/.test(t)) { tags.add('커스텀 버튼'); continue; }
        if (/전면\s*C포트.*W\s*출력/.test(t)) { tags.add('전면 C포트 고속충전'); continue; }
        if (/백플레이트/.test(t)) { tags.add('백플레이트'); continue; }
        if (/램\s*쿨러|램쿨러/.test(t)) { tags.add('램 쿨러'); continue; }
        tags.add(t);
      }
      const dbg = /POST\s*CODE/i.test(ex) ? 'POST CODE' : /디버그\s*LED/i.test(ex) ? '디버그 LED' : '없음';
      putAfter(it, '부가기능', [['부가기능 태그', [...tags].join(', ') || '없음'], ['디버그 표시', dbg]]);
    }
  }
  // M.2 방열판 문장 → {슬롯번호: {dbl, free}} (해석 못 하면 null)
  function m2Heatsinks(s) {
    s = String(s).trim();
    if (/^없음$/.test(s)) return {};
    const slots = {}; let pend = [], i = 0;
    while (i < s.length) {
      const m = s.slice(i).match(/^\d+/);
      if (m) {
        i += m[0].length; let dbl = false;
        if (s.slice(i, i + 4) === '(양면)') { dbl = true; i += 4; }
        pend.push([Number(m[0]), dbl]);
        const g = s.slice(i).match(/^\s*번/);
        if (g) {
          i += g[0].length; let j = i, depth = 0;
          while (j < s.length) { const ch = s[j]; if (ch === '(') depth++; else if (ch === ')') depth = Math.max(0, depth - 1); else if (ch === ',' && !depth && /^,\s*\d/.test(s.slice(j))) break; j++; }
          const tail = s.slice(i, j); i = j;
          pend.forEach(([n, d]) => { slots[n] = { dbl: d || /양면/.test(tail), free: /무나사/.test(tail) }; });
          pend = [];
        }
        continue;
      }
      i++;
    }
    return pend.length || !Object.keys(slots).length ? null : slots;
  }
  // 전면 USB(메인보드 헤더·케이스 포트) 공통
  function frontUsb(s, kind) {
    const cs = [...s.matchAll(/(\d+)\s*Gbps\s*Type-C\s*(\d+)\s*개/gi)].flatMap(m => Array(Number(m[2])).fill(Number(m[1])));
    const n = kind === '헤더' ? '헤더 ' : '';
    return [[`전면 C타입 ${kind === '헤더' ? '헤더 ' : ''}속도`, cs.length ? maxPlus(cs) + 'Gbps' : (/미지원/.test(s) ? '' : '없음')], [`전면 C타입 ${n}수`, cs.length + '개'],
      [`전면 A타입 ${n}수`, sumCnt(s, /Gbps\s*Type-A\s*(\d+)\s*개/gi) + '개'],
      [`전면 2.0 ${n}수`, sumCnt(s, /(?<![\d.])(?:2\.0|1\.[01])\s*(\d+)\s*개/g) + '개' + (/(?<![\d.])1\.[01]\s*\d+\s*개/.test(s) ? ' (USB 1.x 포함, 속도 느림)' : '')]];
  }

  // ----- 램 -----
  function deriveRam(it) {
    const ccl = sv(it, '클럭-CL') || '';
    const nm = it.name.match(/DDR\d-(\d+)M?\s*.*?CL(\d+)/);
    const m = ccl.match(/(\d+)\s*CL(\d+)/) || (nm && [null, nm[1], nm[2]]);
    if (m) putAfter(it, '클럭-CL', [['클럭', m[1]], ['CL', m[2]], ['클럭÷CL', `${Math.round(Number(m[1]) / Number(m[2]))} (기준: 6000 CL30 = 200)`]]);
    const d = sv(it, '다이');
    if (d) {
      const maker = /^랜덤/.test(d) ? '랜덤' : /삼성/.test(d) && /마이크론/.test(d) ? '삼성전자, 마이크론' : /하이닉스/.test(d) ? 'SK하이닉스' : /삼성/.test(d) ? '삼성전자' : /마이크론/.test(d) ? '마이크론' : '';
      const basis = !maker || maker === '랜덤' ? '' : (maker === 'SK하이닉스' && !/확정|[AM]\s*다이/.test(d)) ? '수율로 추정' : '공식 확정';
      const kind = (d.match(/([AM])\s*다이/) || [])[1];
      const yld = /고수율/.test(d) && /선별/.test(d) ? '고수율 선별' : /고수율/.test(d) ? '고수율' : /선별/.test(d) ? '선별' : '일반';
      putAfter(it, '다이', [['다이 제조사', maker], ['다이 근거', basis], ['다이 종류', kind ? kind + '다이' : '미표기'], ['수율', yld]]);
    }
    const hr = sv(it, '방열판과 RGB 유무');
    if (hr) { const [a, b] = hr.split('/'); putAfter(it, '방열판과 RGB 유무', [['방열판', /있음/.test(a) ? '있음' : '없음'], ['RGB', /있음/.test(b || '') ? '있음' : '없음']]); }
    if (it.warranty) putAfter(it, '램 높이', [['보증 기간', it.warranty]]);
    // 이슈 태그 (용량이 적힌 이슈는 "(32GB 모델만)"으로)
    {
      const tags = it.issue && it.issue !== '없음' ? it.issue.split(/\s*,\s*/).filter(Boolean).map(t => { const c = t.match(/^(\d+\s*GB)\s*모델\s*(.+)$/i); return c ? `${c[2]} (${c[1].replace(/\s/g, '')} 모델만)` : t; }) : [];
      putAfter(it, /^(보증 기간|램 높이)$/, [['이슈 태그', tags.join(', ') || '없음']]);
    }
    // 유통 용량 (가격이 있는 용량, 제품 1개 기준)
    const caps = (it.prices || []).filter(p => p.price != null).map(p => p.opt).filter(Boolean);
    putAfter(it, '클럭÷CL', [['유통 용량', caps.join(', ') || '없음']]);
  }
  // 용량을 고른 경우 그 용량 기준으로 바뀌는 값 (다이 종류 M다이, 용량이 적힌 이슈)
  function ramCapView(it, cap) {
    const out = {};
    const gb = Number((String(cap).match(/(\d+)\s*GB/i) || [])[1] || 0);
    if (!gb) return out;
    const stick = isPkg(it) ? gb / sticksFor(it, cap) : gb;
    const note = (it.note || '') + ' ' + (it.plus || '');
    const noted = [...note.matchAll(/(\d+)\s*GB\s*모델은?\s*M\s*다이/gi)].some(m => Number(m[1]) === gb);
    const black = String(sv(it, '방열판과 RGB 유무')).trim() === '없음';
    const hynix = /하이닉스/.test(sv(it, '다이'));
    if (noted || (!black && hynix && stick % 24 === 0)) out['다이 종류'] = 'M다이';
    const iss = sv(it, '이슈 태그');
    if (iss) out['이슈 태그'] = iss.split(/\s*,\s*/).filter(t => { const c = t.match(/\((\d+)GB 모델만\)/); return !c || Number(c[1]) === gb; }).join(', ') || '없음';
    return out;
  }

  // ----- 그래픽카드 -----
  function deriveGpu(it) {
    const th = sv(it, '두께'); const slot = (th.match(/([\d.]+)\s*슬롯/) || [])[1];
    if (th) putAfter(it, '두께', [['슬롯 수', slot ? slot + '슬롯' : '']]);
    const pw = sv(it, '전원 포트');
    if (pw) putAfter(it, '전원 포트', [['커넥터 종류', /12V-2x6/i.test(pw) ? '12V-2x6' : /8핀/.test(pw) ? '8핀' : ''], ['8핀 개수', sumCnt(pw, /8핀\s*(\d+)\s*개/g) + '개']]);
    const vr = sv(it, '전원부'); const a = (vr.match(/총\s*(\d+)\s*A/) || [])[1];
    if (vr) putAfter(it, '전원부', [['전원부 총 전류', a ? a + 'A' : '']]);
    const pc = sv(it, /^소비 전력/);
    if (pc) {
      const b = (pc.match(/^(\d+)\s*W/) || [])[1], mx = (pc.match(/\((\d+)\s*W\)/) || [])[1], pl = (pc.match(/\+\s*(\d+)\s*%/) || [])[1];
      putAfter(it, /^소비 전력/, [['기본 전력', b ? b + 'W' : ''], ['최대 제한 전력', mx ? mx + 'W' : ''], ['파워 리밋', pl ? '+' + pl + '%' : '']]);
    }
    const bc = sv(it, '부스트 클럭'); const oc = (bc.match(/\(\+?(\d+)\s*MHz\)/i) || [])[1];
    if (bc) putAfter(it, '부스트 클럭', [['팩토리 오버', oc != null ? '+' + oc + 'MHz' : '']]);
    const fan = sv(it, '쿨링팬');
    if (fan) {
      const water = /수랭/.test(fan);
      const sizes = [...fan.matchAll(/(\d+)\s*mm\s*(\d+)\s*개/g)];
      let n = sizes.length ? sizes.reduce((s, m) => s + Number(m[2]), 0) : Number((fan.match(/(\d+)\s*개/) || [])[1] || 0);
      let rear = /후면\s*\d+\s*개/.test(fan) ? '있음' : '없음';
      if (/후면\s*별도/.test(fan)) { rear = '별도 장착 가능'; const last = sizes[sizes.length - 1]; if (last) n -= Number(last[2]); }
      const big = sizes.length ? Math.max(...sizes.map(m => Number(m[1]))) : 0;
      putAfter(it, '쿨링팬', [['팬 개수', n + '개'], ['후면 팬', rear], ['팬 크기', big ? big + 'mm' : '불명'], ['쿨링 방식', water ? '수랭' : '공랭']]);
    }
    const hp = sv(it, '히트파이프');
    if (hp) putAfter(it, '히트파이프', [['히트파이프 개수', /^X$/i.test(hp) ? '0개' : (sumCnt(hp, /(\d+)\s*개/g) ? sumCnt(hp, /(\d+)\s*개/g) + '개' : '')]]);
    const vc = sv(it, '베이퍼챔버');
    if (vc) putAfter(it, '베이퍼챔버', [['베이퍼챔버 여부', /^O$/i.test(vc) ? '있음' : /△/.test(vc) ? '혼재' : /^X$/i.test(vc) ? '없음' : '']]);
    const tier = sv(it, /상·중·하급기/);
    if (tier) putAfter(it, /상·중·하급기/, [['쿨링 등급', /의미없음/.test(tier) ? '' : tier.replace(/\(.*\)/, '').trim()]]);
    const vram = (it.name.match(/(\d+)\s*GB?\b/i) || [])[1];
    putAfter(it, '칩셋', [['VRAM 용량', vram ? vram + 'GB' : '']]);
  }

  // ----- SSD -----
  const NAND_FAB = /^(삼성|SK하이닉스|마이크론|Western Digital|WD|Sandisk|샌디스크|키오시아|솔리다임|인텔|YMTC)/i;
  function ssdCapClass(v) {
    const m = String(v).match(/([\d.]+)\s*(TB|GB)/i); if (!m) return null;
    const g = Number(m[1]) * (/TB/i.test(m[2]) ? 1000 : 1);
    for (const [lo, hi, c, tb] of [[100, 150, '128GB급', 0.125], [200, 300, '250GB급', 0.25], [400, 600, '500GB급', 0.5], [900, 1100, '1TB급', 1], [1800, 2100, '2TB급', 2], [3500, 4200, '4TB급', 4], [7000, 8500, '8TB급', 8]])
      if (g >= lo && g <= hi) return { c, tb };
    return { c: '', tb: g / 1000 };
  }
  function deriveSsd(it) {
    const cls = sv(it, '분류');
    if (cls) putAfter(it, '분류', [['인터페이스', (cls.match(/PCIe\s*[\d.]+/i) || [''])[0].replace(/\s+/, ' ')], ['낸드 종류', (cls.match(/TLC|QLC|MLC/i) || [''])[0].toUpperCase()], ['디램', /탑재/.test(cls) ? '탑재' : /리스/.test(cls) ? '리스' : '']]);
    const cc = ssdCapClass(sv(it, '용량'));
    putAfter(it, '용량', [['용량 급', cc ? cc.c : '']]);
    const ctl = sv(it, '컨트롤러');
    if (ctl && !unk(ctl)) {
      const mk = new Set(ctl.split(/\s*,\s*/).map(p => (p.match(/^(삼성전자|삼성|SK\s*하이닉스|마이크론|파이슨|실리콘모션|막시오|이노그릿|리얼텍|WD|테나페|마벨|불명)/) || [])[1]).filter(Boolean).map(x => x.replace(/^삼성전자$/, '삼성').replace(/\s/g, '')));
      putAfter(it, '컨트롤러', [['컨트롤러 제조사', [...mk].join(', ')]]);
    }
    const nand = sv(it, '낸드 정보');
    if (nand && !unk(nand)) {
      const makers = ['마이크론', '키오시아', '도시바', 'SK하이닉스', '삼성전자', 'YMTC', '인텔', '스펙텍'].filter(m => nand.replace(/SK\s+하이닉스/g, 'SK하이닉스').includes(m));
      const mixed = makers.length > 1 || /혼용|,/.test(nand.replace(/\([^)]*\)/g, '')) ? '혼용' : '단일';
      const fab = NAND_FAB.test(it.name.replace(/^인텔\s+/, '인텔 '));
      putAfter(it, '낸드 정보', [['낸드 제조사', makers.join(', ')], ['낸드 혼용', mixed], ['낸드 안내', fab ? '' : '확인된 낸드이며 제조사가 언제든 바꿀 수 있음']]);
    }
    const dr = sv(it, '디램 스펙');
    if (dr) {
      const kind = /HMB/i.test(dr) ? 'HMB' : (dr.match(/LPDDR\d+X?|DDR\d+L?/i) || ['불명'])[0].toUpperCase();
      const mm = dr.match(/(\d+(?:\.\d+)?)\s*(GB|MB)(?!\*)/i);
      let per = '';
      if (kind !== 'HMB' && mm && cc && cc.tb) { const g = Number(mm[1]) / (/GB/i.test(mm[2]) ? 1 : 1024); per = `${+(g / cc.tb).toFixed(2)}GB/TB (기준: TB당 1GB)`; }
      putAfter(it, '디램 스펙', [['디램 종류', kind], ['TB당 디램', per]]);
    }
    const tbw = sv(it, 'TBW'); const t = (tbw.match(/^([\d.]+)\s*TB/) || [])[1];
    if (tbw) putAfter(it, 'TBW', [['TB당 TBW', t && cc && cc.tb ? String(Math.round(Number(t) / cc.tb)) : '']]);
    if (it.warranty) putAfter(it, 'TBW', [['보증 기간', it.warranty]]);
  }

  // ----- 파워서플라이 -----
  function derivePsu(it) {
    const grp = sv(it, '용량');
    const lo = Number((grp.match(/(\d{3,4})/) || [])[1] || 0), hiM = grp.match(/~\s*(\d{3,4})/);
    const hi = hiM ? Number(hiM[1]) : /이상/.test(grp) ? 99999 : lo + 99;
    const w = (it.name.match(/\d{3,4}/g) || []).map(Number).find(n => n >= lo && n <= hi);
    putAfter(it, '용량', [['정격 출력', w ? w + 'W' : '']]);
    const p80 = sv(it, '80PLUS 인증');
    if (p80) putAfter(it, '80PLUS 인증', [['80PLUS 등급', p80.replace(/\s/g, '')]]);
    const oem = sv(it, 'OEM 제조사');
    if (oem) putAfter(it, 'OEM 제조사', [['자체제작', /자체제작/.test(oem) ? '예' : '아니오']]);
    const mod = sv(it, '모듈러 여부');
    if (mod) putAfter(it, '모듈러 여부', [['모듈러 방식', /^O$/i.test(mod) ? '풀모듈러' : /△/.test(mod) ? '세미모듈러' : /^X$/i.test(mod) ? '논모듈러' : '']]);
    const as = sv(it, 'AS 기간');
    if (as) { const y = as.match(/^(\d+)\s*년/), mo = as.match(/^(\d+)\s*개월/); putAfter(it, 'AS 기간', [['무상 AS', y ? y[1] + '년' : mo ? (Number(mo[1]) / 12).toFixed(1) + '년' : '']]); }
    const cap = sv(it, '콘덴서');
    if (cap && !unk(cap)) {
      const seg = n => (cap.match(new RegExp(n + '차\\s*:\\s*([^]*?)(?=\\d차\\s*:|$)')) || [])[1] || '';
      const org = s => ['일본', '대만', '중국', '홍콩', '한국'].filter(o => s.includes(o)).join('+');
      const s1 = seg(1), s2 = seg(2), tmp = (s1.match(/(\d+)\s*℃/) || [])[1];
      putAfter(it, '콘덴서', [['1차 콘덴서 원산지', org(s1)], ['1차 콘덴서 온도', tmp ? tmp + '℃' : ''], ['2차 콘덴서 원산지', org(s2)]]);
    }
    const eps = sv(it, 'CPU 보조전원');
    if (eps) {
      let n8 = 0, n4 = 0; const kinds = new Set();
      for (const m of eps.matchAll(/(8\+\(4\+4\)|8\+4|4\+4|8)\s*(?:핀\s*)?(Y자|독립)\s*(\d+)\s*개/g)) {
        const [t, k, c] = [m[1], m[2], Number(m[3])]; kinds.add(k);
        const per = t === '8+(4+4)' ? [2, 0] : t === '8+4' ? [1, 1] : t === '4+4' ? (k === 'Y자' ? [2, 0] : [1, 0]) : [1, 0];
        n8 += per[0] * c; n4 += per[1] * c;
      }
      const conf = n8 >= 2 ? '8+8' : n8 === 1 && n4 ? '8+4' : n8 === 1 ? '8' : '';
      putAfter(it, 'CPU 보조전원', [['CPU 보조전원 구성', conf + (n8 > 2 ? ` (8핀 ${n8}개)` : '')], ['보조전원 케이블', [...kinds].sort().join('+')]]);
    }
    const p8 = sv(it, 'PCIe 8핀 케이블');
    if (p8) {
      // 12V-2x6(파워측)-8핀 2개(그래픽카드측) 케이블은 독립 케이블 2개로 셈 (300W까지 출력 가능)
      const adp = sumCnt(p8, /8핀\s*(\d+)\s*개\s*\(그래픽카드측\)/g);
      const ind = sumCnt(p8.replace(/\([^)]*\)/g, ''), /독립\s*(\d+)\s*개/g) + adp, y = sumCnt(p8.replace(/\([^)]*\)/g, ''), /Y자\s*(\d+)\s*개/g);
      putAfter(it, 'PCIe 8핀 케이블', [['PCIe 8핀 커넥터 수', ind + y * 2 + '개'], ['PCIe 케이블 가닥 수', ind + y + '개']]);   // 가닥 = 독립 + Y자 (Y자 2개 = 2가닥)
    }
    const h6 = sv(it, '12V-2x6 케이블');
    if (h6) { const c = /없음|별매/.test(h6) ? 0 : Number((h6.match(/(\d+)\s*개/) || [])[1] || 0), wt = (h6.match(/(\d+)\s*W/) || [])[1]; putAfter(it, '12V-2x6 케이블', [['12V-2x6 개수', c + '개'], ['12V-2x6 최대 W', c ? (wt ? wt + 'W' : '불명') : '']]); }
    const sata = sv(it, 'SATA 전원 커넥터'), molex = sv(it, 'MOLEX 커넥터');
    if (sata) putAfter(it, 'SATA 전원 커넥터', [['SATA 커넥터 수', ((sata.match(/^(\d+)/) || [])[1] || 0) + '개']]);
    if (molex) putAfter(it, 'MOLEX 커넥터', [['MOLEX 커넥터 수', ((molex.match(/^(\d+)/) || [])[1] || 0) + '개']]);
    const cy = sv(it, 'Cybenetics 인증');
    if (cy && cy !== '없음') {
      const pick = (s, re) => { const all = [...s.matchAll(re)]; const v230 = all.find(m => /230/.test(m[1])); return (v230 || all[0] || [])[2] || ''; };
      const ef = (cy.match(/효율\s*:\s*([^,]+)/) || [])[1] || '', no = (cy.match(/소음\s*:\s*(.+)$/) || [])[1] || '';
      putAfter(it, 'Cybenetics 인증', [['사이베네틱스 효율', pick(ef, /(\d+V)\s*([가-힣]+)/g)], ['사이베네틱스 소음', pick(no, /(\d+V)\s*([A-Z가-힣]+[+\-]*)/g)]]);
    }
  }

  // ----- 케이스 -----
  const RAD120 = [120, 240, 360, 480], RAD140 = [140, 280, 420, 560];
  function deriveCase(it) {
    const sz = sv(it, '사이즈'); const d = sz.match(/(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);
    putAfter(it, '사이즈', [['가로', d ? d[1] + 'mm' : ''], ['깊이', d ? d[2] + 'mm' : ''], ['높이', d ? d[3] + 'mm' : ''], ['부피', d ? (d[1] * d[2] * d[3] / 1e6).toFixed(1) + 'L' : '']]);
    const bd = sv(it, '최대 지원 보드 규격');
    if (bd) {
      const plain = bd.replace(/\(BTF\)/gi, ''); const sup = FORM.filter(f => new RegExp('(^|[^-])' + f.replace('-', '\\-') + '(?![A-Z])', 'i').test(plain));
      const btf = [...bd.matchAll(/([A-Z-]+)\(BTF\)/gi)].map(m => m[1] + ' BTF');
      putAfter(it, '최대 지원 보드 규격', [['보드 규격 등급', sup.length ? FORM[Math.max(...sup.map(f => FORM.indexOf(f)))] : ''], ['BTF 지원', btf.join(', ') || '미지원']]);
    }
    const df = sv(it, '기본 제공 팬');
    if (df) {
      const fans = [...df.matchAll(/(\d+)\s*mm(R?)\s*\*\s*(\d*)/g)];
      const n = fans.reduce((s, m) => s + Number(m[3] || 1), 0), r = fans.filter(m => m[2]).reduce((s, m) => s + Number(m[3] || 1), 0);
      putAfter(it, '기본 제공 팬', [['기본 팬 개수', /^X$/i.test(df) ? '0개' : n + '개'], ['리버스팬 개수', r + '개'], ['기본 팬 크기', fans.length ? Math.max(...fans.map(m => Number(m[1]))) + 'mm' : ''], ['팬 MOLEX 연결', /MOLEX/i.test(df) ? '예' : '아니오']]);
    }
    // 위치마다 '200mm*2, 140mm*3, 120mm*4'는 크기 중 하나를 고르는 값 → 크기끼리 더하지 않고 크기별로 위치를 더함
    let tot = 0, tot140 = 0; const other = {};
    for (const p of ['전면', '상단', '후면', '하단', '측면']) {
      const t = sv(it, p + '팬'); if (!t) continue;
      const per = {};
      for (const m of t.matchAll(/(\d+)\s*mm\s*\*\s*(\d+)/g)) per[m[1]] = Math.max(per[m[1]] || 0, Number(m[2]));
      const n120 = per[120] || 0, n140 = per[140] || 0; tot += n120; tot140 += n140;
      for (const [sz, n] of Object.entries(per)) if (sz !== '120' && sz !== '140') other[sz] = (other[sz] || 0) + n;
      putAfter(it, p + '팬', [[p + ' 120mm 팬', n120 + '개'], [p + ' 140mm 팬', n140 + '개']]);
    }
    const oth = Object.entries(other).sort((a, b) => b[0] - a[0]).map(([sz, n]) => `${sz}mm ${n}개`).join(', ');
    putAfter(it, '측면 140mm 팬', [['120mm 팬 장착 수', tot + '개'], ['140mm 팬 장착 수', tot140 + '개'], ['기타 크기 팬', oth || '없음']]);
    for (const p of ['전면', '상단', '하단', '측면']) {
      const t = sv(it, p + ' 라디'); if (!t) continue;
      const none = /^X$/i.test(t.trim());
      const f120 = none ? 0 : Math.max(0, ...RAD120.filter(s => radFits(t, s)));
      const f140 = none ? 0 : Math.max(0, ...RAD140.filter(s => radFits(t, s)));
      const th = (t.match(/최대\s*두께\s*([\d+]+)\s*mm/) || [])[1], rec = (t.match(/권장\s*두께\s*(\d+)\s*mm/) || [])[1];
      const len = (t.match(/최대\s*길이\s*(\d+)\s*mm/) || [])[1];
      putAfter(it, p + ' 라디', [[p + ' 라디 120계열', f120 ? f120 + 'mm' : '없음'], [p + ' 라디 140계열', f140 ? f140 + 'mm' : '없음'],
        [p + ' 라디 최대두께', th ? th.split('+').reduce((a, b) => a + Number(b), 0) + 'mm' : rec ? `${rec}mm 권장 (최대두께 미확인)` : ''], [p + ' 라디 최대길이', len ? len + 'mm' : '']]);
    }
    const gp = sv(it, '그래픽카드');
    if (gp) {
      const lens = [...gp.replace(/최대\s*두께\s*\d+\s*mm/, '').matchAll(/(\d+)/g)].map(m => Number(m[1]));
      const th = (gp.match(/최대\s*두께\s*(\d+)/) || [])[1];
      const cond = sv(it, '주의사항').split(/\s*,\s*/).filter(s => /그래픽카드/.test(s) && /최대|감소|-/.test(s) && !/세로|수직|지지대|최대\s*두께/.test(s));
      if (/~/.test(gp) && !cond.length) cond.unshift('전면 쿨링팬 장착 시 쿨링팬 두께만큼 감소');
      putAfter(it, '그래픽카드', [['그래픽카드 최대 길이', lens.length ? Math.max(...lens) + 'mm' : ''], ['그래픽카드 최대두께', th ? th + 'mm' : ''], ['그래픽카드 길이 조건', [...new Set(cond)].join(' / ')]]);
    }
    const ps = sv(it, '파워서플라이');
    if (ps) {
      const ff = []; let rest = ps;
      for (const [f, re] of [['SFX-L', /SFX-L/i], ['SFX', /SFX/i], ['FLEX ATX', /FLEX\s*ATX/i], ['ATX', /ATX/i]]) if (re.test(rest)) { ff.push(f); rest = rest.replace(new RegExp(re.source, 'gi'), ''); }
      const len = (ps.match(/(\d+)\s*mm/) || [])[1];
      putAfter(it, '파워서플라이', [['파워 규격', ff.length ? ff.join(', ') : 'ATX'], ['파워 최대 길이', len ? len + 'mm' : '불명']]);
    }
    const fu = sv(it, '전면 USB');
    if (fu) putAfter(it, '전면 USB', frontUsb(fu, '포트'));
    const bay = sv(it, '확장');
    if (bay && !/불명|없음/.test(bay)) {
      let s25 = 0, s35 = 0;
      const or = bay.match(/2\.5"\s*(\d+)\s*개\s*혹은\s*3\.5"\s*(\d+)\s*개/);
      if (or) { s25 += Number(or[1]); s35 += Number(or[2]); }
      const rest = or ? bay.replace(or[0], '') : bay;
      s25 += sumCnt(rest, /2\.5"\s*(\d+)\s*개/g); s35 += sumCnt(rest, /3\.5"\s*(\d+)\s*개/g);
      const both = sumCnt(rest, /겸용\s*(\d+)\s*개/g); s25 += both; s35 += both;
      const multi = sumCnt(rest, /멀티\s*(\d+)\s*개/g);
      let mNote = '';
      if (multi) {
        const nt = sv(it, '주의사항');
        const mm = nt.match(/멀티[^,]*?2\.5"\s*(?:최대\s*)?(\d+)\s*개[^,]*?3\.5"\s*(?:최대\s*)?(\d+)\s*개/);
        if (mm) { s25 += multi * Number(mm[1]); s35 += multi * Number(mm[2]); } else mNote = ' (멀티 브라켓 별도, 상세페이지 확인)';
      }
      putAfter(it, '확장', [['2.5" 최대', s25 + '개' + mNote], ['3.5" 최대', s35 + '개' + mNote]]);
    }
    const ex = sv(it, '부가기능');
    if (ex) {
      const tags = new Set();
      for (const t of ex.split(/\s*,\s*/)) {
        if (!t || t === '없음') continue;
        if (/ARGB\s*\+\s*팬허브/.test(t)) { tags.add('ARGB허브'); tags.add('팬허브'); continue; }
        if (/그래픽카드\s*지지대/.test(t)) { tags.add('그래픽카드 지지대'); continue; }
        if (/수직/.test(t) || /라이저/.test(t)) { tags.add('PCIe 수직 장착'); continue; }
        tags.add(t.replace(/\s*\d+\s*개$/, ''));
      }
      putAfter(it, '부가기능', [['부가기능 태그', [...tags].join(', ') || '없음']]);
    }
  }

  // ----- CPU쿨러 -----
  function deriveCooler(it) {
    const cls = sv(it, '분류'), water = /수랭/.test(cls);
    const rs = Number((cls.match(/(\d{3})\s*mm/) || [])[1] || 0);
    putAfter(it, '분류', [['쿨러 종류', water ? '수랭' : /공랭/.test(cls) ? '공랭' : ''], ['타워', /듀얼/.test(cls) ? '듀얼타워' : /싱글/.test(cls) ? '싱글타워' : ''], ['라디 크기', rs ? rs + 'mm' : ''], ['라디 계열', rs ? (RAD140.includes(rs) ? '140mm 계열' : '120mm 계열') : '']]);
    const pr = sv(it, '펌프 RPM');
    if (pr) putAfter(it, '펌프 RPM', water ? [['펌프 최대 RPM', (pr.match(/(\d+)\s*RPM/i) || [])[1] ? (pr.match(/(\d+)\s*RPM/i))[1] + 'RPM' : '']] : [['히트파이프 개수', sumCnt(pr, /mm\s*(\d+)\s*개/g) ? sumCnt(pr, /mm\s*(\d+)\s*개/g) + '개' : '']]);
    const fs = sv(it, '팬 사양');
    if (fs && fs !== '없음') {
      const fans = [...fs.matchAll(/(?<![\d.])(\d+(?:\.\d+)?|\?)\s*(R?)mm(R?)(?!H)(?:\s*\*\s*(\d+))?/g)];
      const n = fans.reduce((s, m) => s + Number(m[4] || 1), 0), r = fans.filter(m => m[2] || m[3]).reduce((s, m) => s + Number(m[4] || 1), 0);
      const sizes = fans.map(m => Number(m[1])).filter(Boolean);
      putAfter(it, '팬 사양', [['팬 개수', n + '개'], ['팬 크기', sizes.length ? Math.max(...sizes) + 'mm' : '불명'], ['리버스팬 개수', r + '개']]);
    }
    const v = sv(it, '수치');
    if (v && !unk(v)) {
      if (!water) putAfter(it, '수치', [['쿨러 높이', (v.match(/(\d+(?:\.\d+)?)\s*mm/) || [])[1] ? (v.match(/(\d+(?:\.\d+)?)\s*mm/))[1] + 'mm' : '']]);
      else {
        const m = v.match(/^([\d.?]+)\s*mm\s*\/\s*([\d.?]+)\s*\+\s*([\d.?@]+)\s*mm/);
        if (m) {
          // 팬리스(@)·팬 두께 미상(?)은 일반 25T(25mm) 팬을 단 것으로 계산
          const fanless = m[3] === '@', fanUnk = m[3] === '?', rt = Number(m[2]), ft = fanless || fanUnk ? 25 : Number(m[3]);
          const note = fanless ? ' (팬 미포함, 일반 25T 팬 기준으로 계산)' : fanUnk ? ' (팬 두께 미상, 일반 25T 팬 기준으로 계산)' : '';
          putAfter(it, '수치', [['라디 길이', isNaN(Number(m[1])) ? '' : m[1] + 'mm'], ['라디 두께', isNaN(rt) ? '' : rt + 'mm'], ['팬 두께', fanless ? '팬 미포함' : fanUnk ? '불명' : isNaN(ft) ? '' : ft + 'mm'],
            ['라디+팬 두께', isNaN(rt) || isNaN(ft) ? '' : (rt + ft) + 'mm' + note]]);
        }
      }
    }
    const rh = sv(it, '램 높이');
    if (rh) putAfter(it, '램 높이', [['램 최대 높이', /간섭\s*없음/.test(rh) ? '제한 없음' : (rh.match(/([\d.]+)\s*mm/) || [])[1] ? (rh.match(/([\d.]+)\s*mm/))[1] + 'mm' : '']]);
    const ex = sv(it, '부가기능');
    if (ex) {
      const tags = new Set();
      for (const t of ex.split(/\s*,\s*/)) {
        if (!t || t === '없음') continue;
        if (/LCD|OLED|디스플레이/.test(t)) { tags.add('화면'); tags.add(/OLED/.test(t) ? 'OLED 화면' : /LCD/.test(t) ? 'LCD 화면' : '디지털 디스플레이'); continue; }
        if (/ARGB\s*\+\s*팬허브/.test(t)) { tags.add('ARGB허브'); tags.add('팬허브'); continue; }
        tags.add(t);
      }
      putAfter(it, '부가기능', [['부가기능 태그', [...tags].join(', ') || '없음']]);
    }
  }
  // 쿨러 주의사항의 소켓 제한 → 지원 여부 판단 (true 지원 / false 미지원 / null 모름)
  function coolerSocketOk(cool, socket) {
    const t = sv(cool, '주의사항') + ' ' + (cool.issue || '');
    if (!socket || !t.trim()) return null;
    const amd = /^AM\d/.test(socket), intel = /^\d{4}$/.test(socket);
    if (/서버용\s*소켓만|워크스테이션\s*전용/.test(t)) return false;
    if (/AMD\s*(TR\d|SP\d)[^,]*전용/.test(t)) return false;
    if (amd && /AMD\s*소켓\s*미지원|인텔[^,]*전용/.test(t)) return false;
    if (intel && /인텔\s*소켓\s*미지원|AMD[^,]*전용/.test(t)) return false;
    const only = t.match(/인텔\s*(\d{4})\s*소켓\s*전용/);
    if (only && intel && only[1] !== socket) return false;
    return null;
  }
  function deriveAll(items) {
    const fn = { 'CPU': deriveCpu, '메인보드': deriveMainboard, 'RAM': deriveRam, '그래픽카드': deriveGpu, 'SSD': deriveSsd, '파워서플라이': derivePsu, '케이스': deriveCase, 'CPU쿨러': deriveCooler };
    for (const it of items) { try { fn[it.cat] && fn[it.cat](it); } catch (e) { it.deriveError = String(e); } }
  }

  return { SHEET_ID, SUMMARY_TAB, PARTS, GPU_CHIP_ORDER, gpuChipRank, pkgSticks, sticksFor, FIELD_META, rankOf, ramCapView, coolerSocketOk, m2Heatsinks, laneClass, chipRank, LANE_ORDER, askSpec, averageScores, checkBuild, psuCalc, psuTier, psuWatt, gpuPsuRec, PSU_W, mbForm, isPkg, ramPack, PKG_STICKS, cpuSocket, radFits, psuEps, psuPcie, fetchAll, buildDb, search, parseCsv, num, matchText, matchLine, parseLine, looksLikePart, wordsToText };
})();

// ===== 화면 =====
(function () {
  'use strict';
  const CACHE_KEY = 'pcc_cache_v1', PARTIAL_KEY = 'pcc_partial_v1', BUILD_KEY = 'pcc_build_v1';
  const FAB_KEY = 'pcc_show_fab', KEY_KEY = 'pcc_shortcut';
  const CACHE_HOURS = 6;
  const CATS = ['전체', 'CPU', '메인보드', 'RAM', '그래픽카드', 'SSD', '파워서플라이', '케이스', 'CPU쿨러'];
  const CAT_ORDER = CATS.slice(1);

  const fetchText = url => new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url, timeout: 30000,
      onload: r => (r.status >= 200 && r.status < 300) ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status)),
      onerror: () => reject(new Error('네트워크 오류')),
      ontimeout: () => reject(new Error('시간 초과'))
    });
  });

  let db = null;
  const state = { mode: 'build', cat: '전체', query: '', selected: null, loading: false, error: '', progress: '' };
  // 견적: rows = [{ key, cat, opt, count, ramMode, line, cands:[key...] }], misses = [line...]
  let build = GM_getValue(BUILD_KEY, null) || { text: '', rows: [], misses: [], sale: '', discount: '' };
  const saveBuild = () => GM_setValue(BUILD_KEY, build);
  const keyOf = it => it.cat + '|' + it.name;
  let byKey = new Map();

  // 데이터 받기: ① GitHub에 올라간 파일(빠름, 버전이 바뀔 때만 받음) → ② 실패하면 구글 시트에서 직접(느림)
  const DATA_BASE = 'https://pc-cal.github.io/PC-PARTS-DATA/';
  const CHECK_MIN = 10;   // 버전 확인 간격(분): 이 시간 안에 다시 열면 확인 없이 바로 씀
  async function fromGitHub(cache, force) {
    const v = JSON.parse(await fetchText(DATA_BASE + 'version.json?t=' + Date.now()));
    if (!v || !v.version) throw new Error('버전 정보 없음');
    const tag = v.hash || v.version;   // 데이터 내용이 바뀌면 hash가 바뀜 (버전을 안 올린 수정도 반영)
    if (!force && cache && cache.src === 'gh' && cache.ver === tag) return { same: true, ver: tag };
    state.progress = '새 데이터 받는 중…'; render();
    const d = JSON.parse(await fetchText(DATA_BASE + 'data.json?v=' + encodeURIComponent(tag)));
    if (!d || !d.tabs || !d.tabs[PCC.SUMMARY_TAB]) throw new Error('데이터 파일 형식 오류');
    return { ts: Date.now(), raw: d.tabs, ver: tag, src: 'gh', checked: Date.now() };
  }
  async function fromGoogle() {
    const partial = GM_getValue(PARTIAL_KEY, null);
    const prev = partial && (Date.now() - partial.ts) < 3600 * 1000 ? partial.raw : {};
    const raw = await PCC.fetchAll(fetchText, {
      prev,
      onProgress: (done, total, name) => { state.progress = `구글 시트에서 받는 중… (${done}/${total}) ${name}`; render(); },
      onWait: sec => { state.progress = `구글이 요청을 잠시 제한해서 ${sec}초 후 다시 시도합니다…`; render(); }
    });
    GM_setValue(PARTIAL_KEY, null);
    return { ts: Date.now(), raw, src: 'google', checked: Date.now() };
  }
  async function loadData(force) {
    state.error = ''; state.progress = '';
    let cache = GM_getValue(CACHE_KEY, null);
    // 저장된 데이터가 있으면 먼저 그것으로 화면을 띄우고, 뒤에서 새 버전만 확인
    if (cache && cache.raw && !db) { try { setDb(PCC.buildDb(cache.raw), cache.ts); } catch (e) { cache = null; } }
    if (!force && cache && db && cache.checked && Date.now() - cache.checked < CHECK_MIN * 60000) { render(); return; }
    state.loading = !db; render();
    try {
      let next = null;
      try {
        const r = await fromGitHub(cache, force);
        if (r.same) { cache.checked = Date.now(); GM_setValue(CACHE_KEY, cache); }
        else next = r;
      } catch (ghErr) {
        // GitHub를 못 쓰면: 저장된 데이터가 6시간 안쪽이면 그대로, 아니면 구글 시트에서 직접
        const fresh = cache && (Date.now() - cache.ts) < CACHE_HOURS * 3600 * 1000;
        if (force || !fresh) next = await fromGoogle();
      }
      if (next) { cache = next; GM_setValue(CACHE_KEY, cache); setDb(PCC.buildDb(cache.raw), cache.ts); }
    } catch (e) {
      if (e.partial) GM_setValue(PARTIAL_KEY, { ts: Date.now(), raw: e.partial });
      state.error = /429/.test(e.message)
        ? '구글이 요청을 일시적으로 제한하고 있습니다. 몇 분 뒤에 "새로고침"을 눌러 주세요. 받은 부분은 저장해 두었다가 이어서 받습니다.'
        : '데이터를 불러오지 못했습니다: ' + e.message;
      if (db) state.error += ' (저장된 이전 데이터를 표시합니다)';
    }
    state.loading = false; state.progress = ''; render();
  }
  function setDb(d, ts) { db = d; db.loadedAt = ts; byKey = new Map(db.items.map(it => [keyOf(it), it])); if (!panel.hidden) setTimeout(() => showNotes(true), 0); }

  // ----- 데이터 패치노트 -----
  // 처음 열 때 마지막으로 본 버전 이후 기록만 한 번 띄우고, 다음 판올림 전까지는 다시 안 띄움. '패치노트' 버튼으로 전체 보기
  const NOTES_SEEN_KEY = 'pcc_notes_seen_v1';
  const verKey = v => { const m = String(v).match(/v(\d{8})-(\d+)/); return m ? Number(m[1]) * 1000 + Number(m[2]) : 0; };
  function showNotes(onlyNew) {
    if (!db) return;
    const notes = (db.notes || []).filter(n => n.text);   // 내용이 빈 줄은 건너뜀
    if (onlyNew) {
      if (!notes.length || root.querySelector('.notes-modal')) return;
      const latest = Math.max(...notes.map(n => verKey(n.ver)));
      const seen = verKey(GM_getValue(NOTES_SEEN_KEY, ''));
      if (latest <= seen) return;
      // 처음 쓰는 사람은 가장 최근 버전만, 그 뒤로는 마지막으로 본 버전 이후 전부
      const show = seen ? notes.filter(n => verKey(n.ver) > seen) : notes.filter(n => verKey(n.ver) === latest);
      GM_setValue(NOTES_SEEN_KEY, notes.find(n => verKey(n.ver) === latest).ver);
      openNotesModal(show, '데이터가 업데이트되었습니다');
    } else {
      openNotesModal(notes, '패치노트');   // 데이터 탭(기본, 맨 앞) + 스크립트 탭
    }
  }
  // 데이터 패치노트 탭 (시트) 링크
  const NOTES_SHEET_URL = 'https://docs.google.com/spreadsheets/d/' + PCC.SHEET_ID + '/edit#gid=1908038046';
  // 스크립트 패치노트: 1.0 배포부터 기록 (판올림할 때 맨 위에 ['버전', '추가|수정|삭제', '내용'] 추가)
  const SCRIPT_NOTES = [
  ].map(([ver, kind, text]) => ({ ver: 'v' + ver, date: '', kind, text }));
  // 설정 (Tampermonkey 메뉴 없이도 쓸 수 있게 패널 안에서): 화면 버튼, 버튼 위치, 단축키
  function openSettings() {
    const old = root.querySelector('.notes-modal'); if (old) old.remove();
    const close = () => m.remove();
    const fabChk = el('input', { type: 'checkbox' }); fabChk.checked = !!GM_getValue(FAB_KEY, fabDefault());
    if (!canHideFab()) { fabChk.checked = true; fabChk.disabled = true; }
    fabChk.addEventListener('change', () => { GM_setValue(FAB_KEY, fabChk.checked); applyFab(); showToast(fabChk.checked ? '화면 버튼을 켰습니다.' : `화면 버튼을 숨겼습니다. ${comboText(getShortcut())}${HAS_MENU ? ' 또는 Tampermonkey 메뉴' : ''}로 열 수 있습니다.`, 2500); });
    const keyText = el('b', { text: comboText(getShortcut()) });
    const row = (label, ...kids) => el('div', { class: 'set-row' }, el('div', { class: 'set-l', text: label }), el('div', { class: 'set-v' }, ...kids));
    const m = el('div', { class: 'notes-modal', onclick: e => { if (e.target === m) close(); } },
      el('div', { class: 'notes-box' },
        el('div', { class: 'notes-hd' }, el('b', { text: '설정' }), el('button', { class: 'x', text: '×', title: '닫기', onclick: close })),
        el('div', { class: 'notes-list' },
          row('화면 버튼', el('label', { class: 'set-chk' }, fabChk, ' 화면에 "완본체 계산기" 버튼 보이기'),
            el('div', { class: 'hint', text: canHideFab() ? '숨기면 단축키나 Tampermonkey 메뉴로만 열 수 있습니다.' : '휴대폰이나 AdGuard처럼 메뉴가 없는 환경에서는 패널을 열 방법이 없어지므로 숨길 수 없습니다.' })),
          row('버튼 위치', el('button', { class: 'btn ghost sm', text: '처음 위치로', onclick: () => { GM_setValue(FABPOS_KEY, null); placeFab(); showToast('화면 버튼을 오른쪽 아래로 옮겼습니다.', 1500); } }),
            el('div', { class: 'hint', text: '버튼은 끌어서 옮길 수 있고, 옮긴 위치를 기억합니다.' })),
          isTouch ? null : row('단축키', el('span', {}, '지금: ', keyText, ' '),
            el('button', { class: 'btn ghost sm', text: '바꾸기', onclick: () => { capturing = true; showToast('원하는 단축키를 누르세요. 지금: ' + comboText(getShortcut()) + ' (취소: Esc)'); const t = setInterval(() => { if (!capturing) { clearInterval(t); keyText.textContent = comboText(getShortcut()); } }, 300); } }),
            el('div', { class: 'hint', text: '아무 페이지에서나 이 단축키로 패널을 열고 닫습니다. 다른 기능과 겹치면 바꿔 주세요. (웨일은 Alt+Shift+P가 겹칩니다)' })),
          row('데이터', el('button', { class: 'btn ghost sm', text: '새로고침', onclick: () => { close(); if (!state.loading) loadData(true); } }),
            el('div', { class: 'hint', text: '최신 부품 데이터와 가격을 다시 받습니다.' }))),
        el('div', { class: 'btnrow', style: 'justify-content:flex-end' }, el('button', { class: 'btn sm', text: '확인', onclick: close }))));
    panel.append(m);
  }

  // 패치노트 팝업: [데이터] [스크립트] 탭, 데이터가 항상 맨 앞·기본
  function openNotesModal(dataList, title) {
    const old = root.querySelector('.notes-modal'); if (old) old.remove();
    const listView = (list, empty) => {
      if (!list.length) return el('div', { class: 'notes-empty', text: empty });
      const groups = [];
      for (const n of list) { let g = groups.find(x => x.ver === n.ver); if (!g) groups.push(g = { ver: n.ver, date: n.date, rows: [] }); g.rows.push(n); }
      return groups.map(g => el('div', { class: 'notes-ver' },
        el('div', { class: 'notes-vt' }, el('b', { text: g.ver }), el('span', { class: 'muted', text: ' ' + g.date })),
        g.rows.map(r => el('div', { class: 'notes-row' }, r.kind ? el('span', { class: 'notes-kind k-' + r.kind, text: r.kind }) : null, el('span', { text: r.text })))));
    };
    const tabs = [
      ['데이터', () => listView(dataList, db && db.notes ? '데이터 패치노트가 없습니다.' : '데이터 패치노트는 GitHub 데이터에서만 볼 수 있습니다. 새로고침 후 다시 열어 주세요.')],
      ['스크립트', () => listView(SCRIPT_NOTES, '스크립트 패치노트는 1.0 배포부터 기록합니다.')]];
    const body = el('div', { class: 'notes-list' });
    const link = el('a', { class: 'notes-link', href: NOTES_SHEET_URL, target: '_blank', rel: 'noopener', text: '시트에서 전체 보기 ↗' });
    const tabBtns = tabs.map(([name, view], i) => el('button', { class: 'notes-tab', text: name, onclick: () => show(i) }));
    const show = i => {
      tabBtns.forEach((b, j) => b.classList.toggle('on', i === j));
      const v = tabs[i][1](); body.replaceChildren(...(Array.isArray(v) ? v : [v])); body.scrollTop = 0;
      link.style.visibility = i === 0 ? 'visible' : 'hidden';   // 시트 링크는 데이터 탭에서만
    };
    const close = () => m.remove();
    const m = el('div', { class: 'notes-modal', onclick: e => { if (e.target === m) close(); } },
      el('div', { class: 'notes-box' },
        el('div', { class: 'notes-hd' }, el('b', { text: title }), el('button', { class: 'x', text: '×', title: '닫기', onclick: close })),
        el('div', { class: 'notes-tabs' }, tabBtns),
        body,
        el('div', { class: 'btnrow', style: 'justify-content:space-between;align-items:center' }, link,
          el('button', { class: 'btn sm', text: '확인', onclick: close }))));
    panel.append(m);
    show(0);
  }

  // ----- 화면 틀 -----
  const host = document.createElement('div');
  host.id = 'pcc-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: 'Pretendard','Malgun Gothic','Apple SD Gothic Neo',sans-serif; }
    .fab { position: fixed; right: 20px; bottom: 20px; touch-action: none; z-index: 2147483646; height: 44px; padding: 0 16px; border-radius: 999px;
      border: none; background: #375623; color: #fff; font-size: 13px; font-weight: 700; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.25); white-space: nowrap; }
    .panel { position: fixed; top: 0; right: 0; z-index: 2147483647; width: 560px; max-width: 100vw; height: 100vh; background: #fff;
      color: #1f2328; box-shadow: -4px 0 18px rgba(0,0,0,.18); display: flex; flex-direction: column; font-size: 13px; }
    .panel[hidden], .fab[hidden] { display: none; }
    header { background: #375623; color: #fff; padding: 10px 12px 0; }
    header .row { display: flex; align-items: center; gap: 8px; }
    header h1 { font-size: 15px; margin: 0; flex: 1; }
    header .meta { font-size: 11px; opacity: .85; margin-top: 4px; line-height: 1.5; }
    header .meta .mrow { display: flex; flex-wrap: wrap; column-gap: 0; } header .meta .mi { white-space: nowrap; } header .meta .mi + .mi::before { content: '·'; margin: 0 6px; }
    header button { background: rgba(255,255,255,.15); color: #fff; border: 1px solid rgba(255,255,255,.35); border-radius: 6px;
      padding: 3px 8px; font-size: 12px; cursor: pointer; }
    header button[data-act=close] { background: #cf222e; border-color: #cf222e; font-weight: 700; } header button[data-act=close]:hover { background: #a40e26; }
    .tabs { display: flex; gap: 2px; margin-top: 8px; }
    .tabs button { flex: 1; border: none; border-radius: 8px 8px 0 0; background: rgba(255,255,255,.12); color: #fff; padding: 7px 4px; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .tabs button.on { background: #fff; color: #375623; font-weight: 700; }
    @media (max-width: 440px) { .tabs button { font-size: 12px; padding: 7px 2px; } }
    .controls { padding: 10px 12px; border-bottom: 1px solid #e5e7eb; display: flex; flex-direction: column; gap: 8px; }
    input, textarea, select { font-size: 13px; border: 1px solid #c9ced6; border-radius: 6px; padding: 6px 8px; background: #fff; color: #1f2328; }
    .controls input { width: 100%; padding: 8px 10px; }
    textarea { width: 100%; min-height: 96px; resize: vertical; line-height: 1.45; }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .chip { border: 1px solid #c9ced6; background: #fff; border-radius: 999px; padding: 3px 9px; font-size: 12px; cursor: pointer; color: #1f2328; }
    .chip.on { background: #375623; border-color: #375623; color: #fff; }
    .btn { border: 1px solid #375623; background: #375623; color: #fff; border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
    .btn.ghost { background: #fff; color: #375623; }
    .btn.sm { padding: 3px 8px; font-size: 12px; }
    .btnrow { display: flex; gap: 6px; }
    .body { flex: 1; overflow-y: auto; }
    .msg { padding: 14px 12px; color: #57606a; line-height: 1.5; white-space: pre-line; }
    .hint { font-size: 12px; color: #6e7781; line-height: 1.45; }
    .err { color: #b42318; }
    .item { padding: 9px 12px; border-bottom: 1px solid #f0f1f3; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
    .item:hover { background: #f4f8f1; }
    .cat { font-size: 11px; color: #375623; background: #e2efda; border-radius: 4px; padding: 1px 5px; white-space: nowrap; }
    .item .nm { flex: 1; }
    .pr { white-space: nowrap; font-weight: 600; }
    .muted { color: #8b949e; font-weight: 400; }
    .detail { padding: 12px; }
    .back { background: none; border: none; color: #375623; cursor: pointer; padding: 0; font-size: 13px; margin-bottom: 8px; }
    .detail h2 { font-size: 15px; margin: 6px 0 10px; line-height: 1.4; }
    .sec { margin: 14px 0 6px; font-weight: 700; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    td, th { font-size: 13px; border-bottom: 1px solid #eef0f2; padding: 6px 4px; text-align: left; vertical-align: top; line-height: 1.45; }
    th { color: #57606a; font-weight: 500; width: 38%; }
    .num { text-align: right; white-space: nowrap; }
    .scores { display: flex; gap: 8px; }
    .score { flex: 1; background: #f6f8fa; border-radius: 8px; padding: 8px; text-align: center; }
    .score b { display: block; font-size: 18px; margin-top: 2px; }
    .detail table.prices td.num { font-size: 18px; font-weight: 700; vertical-align: middle; }   /* 상세 화면 최저가: 점수와 같은 크기 */
    .detail table.prices td, .detail table.prices th { vertical-align: middle; }
    .detail table.prices .tag { font-size: 11px; font-weight: 400; }
    .samefrom { font-size: 11px; color: #4b5563; text-decoration: none; flex-basis: 100%; }
    a.samefrom:hover { text-decoration: underline; }
    .samefrom.sub { color: #b45309; font-weight: 600; }
    .detail table.prices .samefrom { font-weight: 400; }
    .note { background: #fff8e6; border: 1px solid #f2d48a; border-radius: 6px; padding: 8px; line-height: 1.5; white-space: pre-wrap; }
    a.link { display: inline-block; margin-top: 12px; color: #fff; background: #375623; padding: 6px 12px; border-radius: 6px; text-decoration: none; }
    .tag { font-size: 11px; color: #8b5e00; background: #fff1cc; border-radius: 4px; padding: 0 4px; margin-left: 4px; }
    .part { padding: 10px 12px; border-bottom: 1px solid #eef0f2; }
    .part .top { display: flex; gap: 6px; align-items: center; }
    .part select.cand { flex: 1; min-width: 0; }
    .part .sub { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
    .part .sub .pr { margin-left: auto; font-size: 14px; }
    .part .sub .scorebox { margin-left: auto; display: inline-flex; gap: 4px; }
    .part .sub .scorebox + .pr { margin-left: 8px; }
    .sc { font-size: 11px; padding: 1px 6px; border-radius: 10px; background: #eef0f2; color: #57606a; white-space: nowrap; font-weight: 600; }
    .sc.hi { background: #dafbe1; color: #1a7f37; } .sc.mid { background: #fff8c5; color: #7d5600; } .sc.lo { background: #ffebe9; color: #cf222e; }
    .sum label.asm { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; } .sum label.asm input { width: auto; margin: 0; }
    .sum .line.sub { margin-top: -2px; }
    .sopts { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
    .sopts select, .sopts input.maxprice { font-size: 12px; padding: 4px 6px; border: 1px solid #d0d7de; border-radius: 6px; }
    .sopts select { width: auto; } .sopts input.maxprice { width: 96px; flex: none; }
    .sopts label { display: inline-flex; gap: 4px; align-items: center; white-space: nowrap; } .sopts input[type=checkbox] { width: auto; margin: 0; flex: none; }
    .item.rank .rk { flex: none; width: 22px; text-align: right; color: #8b949e; font-size: 12px; font-weight: 700; }
    .item .scorebox { display: inline-flex; gap: 3px; flex: none; }
    .seg { display: inline-flex; border: 1px solid #d0d7de; border-radius: 6px; overflow: hidden; }
    .seg button { border: none; background: #fff; padding: 4px 10px; font-size: 12px; cursor: pointer; color: #57606a; font-family: inherit; }
    .seg button.on { background: #375623; color: #fff; }
    .scard { margin: 8px 12px; padding: 10px 12px; background: #f6f8fa; border-left: 4px solid #375623; border-radius: 6px; }
    .scard .shead { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; } .scard .snm { font-weight: 700; flex: 1; min-width: 0; }
    .sgrid { display: grid; grid-template-columns: max-content 1fr; gap: 3px 10px; font-size: 12px; }
    .sgrid .sk { color: #57606a; font-weight: 600; white-space: nowrap; } .sgrid .sv { line-height: 1.45; word-break: keep-all; }
    .filters { margin-top: 6px; }
    .filters .frow { display: grid; grid-template-columns: minmax(0, 1.25fr) 88px minmax(0, 1fr) 22px; gap: 4px; align-items: center; margin-bottom: 4px; }
    .filters select, .filters input { font-size: 12px; padding: 4px 6px; border: 1px solid #d0d7de; border-radius: 6px; min-width: 0; width: 100%; height: 28px; box-sizing: border-box; }
    .filters select { text-overflow: ellipsis; white-space: nowrap; overflow: hidden; }
    .filters .vwrap { position: relative; min-width: 0; display: flex; } .filters .vwrap input { flex: 1; width: 100%; text-overflow: ellipsis; }
    .filters .vopt .ck { display: inline-block; width: 16px; color: #375623; }
    @media (max-width: 520px) { .filters .frow { grid-template-columns: minmax(0, 1fr) 88px 22px; } .filters .frow select:first-child { grid-column: 1 / 3; grid-row: 1; }
      .filters .frow > .x { grid-column: 3; grid-row: 1; } .filters .frow .vwrap { grid-column: 1; grid-row: 2; } .filters .frow select:nth-child(2) { grid-column: 2; grid-row: 2; } }
    .filters .vpop { display: none; position: absolute; top: 100%; right: 0; min-width: 100%; width: max-content; max-width: 320px; z-index: 30; max-height: 220px; overflow-y: auto; background: #fff; border: 1px solid #d0d7de; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,.12); margin-top: 2px; }
    .filters .vpop.on { display: block; }
    .filters .vopt { padding: 5px 8px; font-size: 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .filters .vopt:hover, .filters .vopt.hi { background: #eef6ea; } .filters .vopt.cur { font-weight: 700; color: #375623; }
    .filters .faddrow { display: flex; gap: 4px; align-items: center; margin-top: 2px; }
    .filters .fadd { flex: 1; height: 28px; box-sizing: border-box; border: 1px dashed #8fb07a; border-radius: 6px; background: none; color: #375623; font-size: 12px; cursor: pointer; }
    .filters .fadd:hover { background: #eef6ea; }
    .filters .finfo { flex: none; width: 28px; height: 28px; border: none; background: none; color: #57606a; font-size: 15px; cursor: pointer; padding: 0; }
    .filters .fhint { font-size: 11px; color: #8b949e; line-height: 1.4; margin: 2px 0 4px 2px; }
    .fhelp .notes-kind { flex: none; min-width: 72px; text-align: center; box-sizing: border-box; }
    .filters .frowhint { margin: -2px 0 6px 4px; }
    .filters .x { border: none; background: none; color: #8b949e; cursor: pointer; font-size: 16px; padding: 0; width: 22px; height: 28px; }
    .panel.wide { width: min(980px, 100vw); }
    .saved { padding: 10px 12px; border-bottom: 1px solid #eef0f2; } .saved .srow { display: flex; gap: 8px; align-items: center; font-weight: 700; }
    .saved .sub2 { font-size: 12px; color: #57606a; margin-top: 3px; line-height: 1.45; }
    .good { color: #1a7f37; } .bad { color: #cf222e; } .warnc { color: #9a6700; } .muted { color: #8b949e; }
    .cmpwrap { overflow-x: auto; padding: 8px 12px 16px; }
    table.cmp { border-collapse: collapse; width: 100%; font-size: 12px; table-layout: fixed; }
    table.cmp th, table.cmp td { border: 1px solid #e5e7eb; padding: 6px 8px; vertical-align: top; text-align: left; }
    table.cmp tr:first-child th { background: #e2efda; font-size: 13px; } table.cmp th:first-child { width: 84px; background: #f6f8fa; }
    table.cmp td.diff .cn { font-weight: 700; } table.cmp .cs { color: #57606a; margin-top: 2px; } table.cmp .cp + .cp { margin-top: 6px; }
    table.cmp tr.sumr td { font-weight: 600; } table.cmp td.best { background: #dafbe1; color: #1a7f37; }
    table.cmp tr.drow td { font-weight: 600; } table.cmp th .x { border: none; background: none; color: #8c959f; cursor: pointer; padding: 0 2px; } .cmpwrap + .cmpwrap { margin-top: 14px; }
    .answer { padding: 12px; background: #f6f8fa; border-bottom: 1px solid #e5e7eb; }
    .answer .ans-part { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; } .answer .ans-part .info { font-size: 13px; font-weight: 700; text-align: left; }
    .answer table { width: 100%; border-collapse: collapse; font-size: 12px; } .answer th { text-align: left; color: #57606a; font-weight: 600; padding: 3px 8px 3px 0; width: 34%; vertical-align: top; }
    .answer td { padding: 3px 0; line-height: 1.45; }
    .compat .ci { display: flex; gap: 8px; align-items: flex-start; padding: 5px 0; }
    .compat .ic { flex: none; width: 18px; height: 18px; border-radius: 50%; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; color: #fff; margin-top: 1px; }
    .compat .bad .ic { background: #cf222e; } .compat .warn .ic { background: #bf8700; } .compat .ok .ic { background: #1a7f37; } .compat .note .ic { background: #0969da; }
    .compat .ct { font-weight: 600; } .compat .bad .ct { color: #cf222e; } .compat .warn .ct { color: #9a6700; }
    .compat .cd { font-size: 12px; color: #57606a; line-height: 1.45; }
    .compat details { margin-top: 4px; } .compat summary { cursor: pointer; font-size: 12px; color: #57606a; }
    .sum .avg { font-weight: 700; }
    .sum.pline1 { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; border-top: 1px solid #e5e7eb; padding: 8px 12px; } .sum.pline1:hover { background: #eef6ea; } .pline1 .plink { color: #0969da; font-size: 12px; flex: none; }
    .sum.power { display: block; border-top: 1px solid #e5e7eb; }
    .power details summary { cursor: pointer; font-size: 13px; } .power .pload { font-size: 18px; color: #24292f; }
    .power .pline { display: grid; grid-template-columns: 72px 1fr auto; gap: 6px; font-size: 12px; padding: 2px 0 2px 14px; } .power .pline b { text-align: right; }
    .power .ptiles { display: grid; gap: 6px; margin: 8px 0 6px; }
    .power .ptile { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 6px 8px; text-align: center; }
    .power .ptile.main { border: 2px solid #375623; } .power .pl { font-size: 12px; color: #57606a; } .power .pv { font-size: 20px; font-weight: 700; color: #375623; } .power .pd { font-size: 11px; color: #8b949e; }
    .power .pnow { font-size: 13px; font-weight: 600; margin: 2px 0 6px; }
    .power .popts { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; font-size: 12px; margin-bottom: 4px; }
    .power .popts input[type=number] { width: 48px; height: 26px; padding: 2px 4px; border: 1px solid #d0d7de; border-radius: 6px; text-align: right; } .power .popts label { display: inline-flex; align-items: center; gap: 4px; }
    .sum.scores { display: block; border-top: none; padding-bottom: 8px; } .scores .sgrid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .scores .stile { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 10px; text-align: center; }
    .scores .sl { font-size: 12px; color: #57606a; } .scores .sv b { font-size: 26px; color: #375623; line-height: 1.2; } .scores .sv span { font-size: 13px; color: #8b949e; }
    .part .src { font-size: 11px; color: #8b949e; margin-top: 4px; display: flex; gap: 2px; align-items: center; min-width: 0; }
    .edtext { cursor: text; border-bottom: 1px dashed #c4c9cf; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .edtext:hover { background: #f3f6fa; color: #1f2328; }
    .edtext.grow { flex: 1; }
    .edhint { flex: none; color: #b0b7bf; }
    .textinput { flex: 1; min-width: 0; font-size: 12px; padding: 2px 6px; }
    .x { border: none; background: none; color: #8b949e; font-size: 16px; cursor: pointer; padding: 0 2px; }
    .info { border: none; background: none; color: #375623; cursor: pointer; font-size: 12px; padding: 0 2px; text-decoration: underline; font-family: inherit; }
    .miss { padding: 8px 12px; border-bottom: 1px solid #eef0f2; color: #8b5e00; background: #fffbf0; display: flex; gap: 6px; align-items: center; }
    .miss span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sum { padding: 12px; background: #f6f8fa; border-top: 1px solid #e5e7eb; }
    .sum .line { display: flex; justify-content: space-between; align-items: center; padding: 3px 0; gap: 8px; }
    .sum .line input { width: 130px; text-align: right; }
    .sum .big { font-size: 16px; font-weight: 700; }
    .good { color: #1a7f37; } .bad { color: #cf222e; }
    .editable { cursor: pointer; border-bottom: 1px dashed #c9ced6; }
    .priceinput { width: 110px; text-align: right; margin-left: auto; }
    .alts { margin-top: 6px; background: #fff8e6; border: 1px solid #f2d48a; border-radius: 6px; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
    .alt { display: flex; justify-content: space-between; gap: 8px; text-align: left; border: 1px solid #e5d3a1; background: #fff; border-radius: 5px; padding: 5px 8px; cursor: pointer; font-size: 12px; color: #1f2328; }
    .alt:hover { background: #fffbf0; } .alt span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ocrbar { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .ocrstat { font-size: 12px; color: #375623; }
    .notes-modal { position: absolute; inset: 0; z-index: 50; background: rgba(15,18,22,.45); display: flex; align-items: center; justify-content: center; padding: 16px; }
    .notes-box { background: #fff; border-radius: 10px; width: 100%; max-width: 520px; max-height: 80%; display: flex; flex-direction: column; box-shadow: 0 8px 28px rgba(0,0,0,.25); padding: 12px 14px; }
    .notes-hd { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; } .notes-hd .x { border: none; background: none; font-size: 18px; cursor: pointer; color: #8b949e; }
    .set-row { display: grid; grid-template-columns: 72px 1fr; gap: 8px; padding: 10px 0; border-bottom: 1px solid #eef0f2; } .set-l { font-weight: 700; padding-top: 3px; } .set-v { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; } .set-chk { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
    .notes-tabs { display: flex; gap: 4px; margin-bottom: 8px; border-bottom: 1px solid #eef0f2; }
    .notes-tab { border: none; background: none; padding: 5px 12px; font-size: 13px; color: #57606a; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .notes-tab.on { color: #375623; font-weight: 700; border-bottom-color: #375623; }
    .notes-empty { color: #8b949e; font-size: 12.5px; padding: 16px 0; text-align: center; }
    .notes-list { overflow-y: auto; flex: 1; font-size: 12.5px; line-height: 1.5; }
    .notes-ver { padding: 6px 0; border-top: 1px solid #eaeef2; } .notes-ver:first-child { border-top: none; }
    .notes-row { display: flex; gap: 6px; align-items: flex-start; margin-top: 3px; }
    .notes-link { font-size: 12px; color: #0969da; text-decoration: none; } .notes-link:hover { text-decoration: underline; }
    .notes-kind { flex: none; font-size: 11px; padding: 0 6px; border-radius: 9px; background: #eaeef2; color: #57606a; line-height: 18px; }
    .notes-kind.k-추가 { background: #dafbe1; color: #1a7f37; } .notes-kind.k-삭제 { background: #ffebe9; color: #cf222e; } .notes-kind.k-수정 { background: #ddf4ff; color: #0969da; } .notes-kind.k-변경 { background: #fbefff; color: #8250df; }
    .crop { position: fixed; inset: 0; z-index: 2147483647; background: rgba(15,18,22,.82); display: flex; flex-direction: column; }
    .crop .bar { background: #fff; padding: 10px 14px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; color: #1f2328; }
    .crop .bar b { flex: 1; min-width: 200px; }
    .crop .area { flex: 1; overflow: auto; padding: 16px; display: flex; justify-content: center; }
    .crop .stage { position: relative; align-self: flex-start; cursor: crosshair; user-select: none; }
    .crop .stage img { display: block; max-width: calc(100vw - 48px); height: auto; pointer-events: none; }
    .crop .sel { position: absolute; border: 2px solid #4ade80; background: rgba(74,222,128,.15); box-shadow: 0 0 0 9999px rgba(0,0,0,.35); pointer-events: none; }
    .crop .stage { touch-action: none; }
    .onlytouch { display: none; }
    /* 휴대폰 (좁은 화면·터치) */
    @media (max-width: 600px), (pointer: coarse) {
      .panel, .panel.wide { width: 100vw; height: 100dvh; box-shadow: none; font-size: 14px; }
      .fab { right: 12px; bottom: 12px; height: 40px; padding: 0 14px; }
      .onlytouch { display: inline; } .onlymouse { display: none; }
      .btn, button.chip, header button { min-height: 34px; }
      .btn.sm { min-height: 30px; padding: 4px 10px; }
      select, input, textarea { font-size: 16px; }   /* 16px 미만이면 아이폰이 입력할 때 화면을 확대함 */
      .part select.cand { min-width: 0; width: 100%; }
      .part .sub { flex-wrap: wrap; }
      .cmpwrap, .answer { overflow-x: auto; }
      table.cmp { min-width: 560px; }
      .crop .bar { padding: 8px 10px; } .crop .bar b { min-width: 100%; font-size: 13px; }
      .crop .area { padding: 8px; } .crop .stage img { max-width: calc(100vw - 16px); }
      .sum .line input { width: 120px; }
    }
  </style>
  <button class="fab" title="완본체 계산기 열기" hidden>완본체 계산기</button>
  <div class="panel" hidden>
    <header>
      <div class="row"><h1>완본체 부품 계산기</h1><button data-act="sheet" title="원본 구글 시트 열기">원본 시트</button><button data-act="notes" title="데이터·스크립트 패치노트">패치노트</button><button data-act="settings" title="화면 버튼·단축키 설정">설정</button><button data-act="refresh">새로고침</button><button data-act="close">닫기</button></div>
      <div class="meta"></div>
      <div class="tabs"><button data-mode="build">계산기</button><button data-mode="power">파워 계산</button><button data-mode="saved">저장한 견적</button><button data-mode="search">부품 검색</button><button data-mode="parts">부품 비교</button></div>
    </header>
    <div class="controls"></div>
    <div class="body"></div>
  </div>`;

  const $ = s => root.querySelector(s);
  const panel = $('.panel'), body = $('.body'), meta = $('.meta'), controls = $('.controls'), fab = $('.fab');
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach(k => k != null && k !== false && n.append(k));
    return n;
  };
  const won = p => (p === null || p === undefined) ? '-' : Math.round(p).toLocaleString('ko-KR') + '원';
  const minPrice = it => { const ps = it.prices.map(p => p.price).filter(p => p !== null); return ps.length ? Math.min(...ps) : null; };
  const optLabel = cat => cat === 'SSD' || cat === 'RAM' ? '용량' : (cat === '케이스' || cat === 'CPU쿨러') ? '색상' : '옵션';

  // ----- 견적 계산 -----
  function defaultOpt(it, cap, color) {
    const ps = it.prices;
    if (it.cat === 'SSD') return ps[0] ? ps[0].opt : '';
    if (cap && (it.cat === 'RAM')) return cap;                       // 품절이어도 요청한 용량 유지
    if (color && (it.cat === '케이스' || it.cat === 'CPU쿨러')) {
      const m = ps.find(p => p.opt.includes(color)); return m ? m.opt : color;   // 없으면 요청한 색상 유지
    }
    if (!ps.length) return '';
    // 색상이 안 적혀 있으면 블랙(기본 색) 쪽을 먼저 고름
    if (!color && (it.cat === '케이스' || it.cat === 'CPU쿨러')) {
      const blk = ps.find(p => /블랙|black/i.test(p.opt) && p.price !== null) || ps.find(p => /블랙|black/i.test(p.opt));
      if (blk) return blk.opt;
    }
    const priced = ps.filter(p => p.price !== null);
    return (priced.length ? priced.reduce((a, b) => (a.price <= b.price ? a : b)) : ps[0]).opt;
  }
  function rowPrice(row) {
    if (row.custom != null) return row.custom;   // 사용자가 직접 입력한 가격 우선
    const it = byKey.get(row.key); if (!it) return null;
    const p = row.opt ? it.prices.find(x => x.opt === row.opt) : it.prices[0];
    if (!p) return null;
    let v = p.price;
    if (it.cat === 'RAM') { if (row.ramMode === 'same' && p.sameSpec != null) v = p.sameSpec; if (v != null) v *= (row.count || 1); }
    return v;
  }
  // 램 용량 표기: 패키지는 "32GB 패키지(16GB×2)", 일반 램은 "16GB × 2개"
  const ramCapText = (it, r) => {
    if (PCC.isPkg(it)) {
      const g = Number((String(r.opt || '').match(/(\d+)\s*GB/i) || [])[1] || 0);
      return `${r.opt || ''} 패키지${g ? `(${g / PCC.sticksFor(it, r.opt)}GB×${PCC.sticksFor(it, r.opt)})` : ''}` + ((r.count || 1) > 1 ? ` × ${r.count}세트` : '');
    }
    return `${r.opt || ''} × ${r.count || 1}개`.trim();
  };
  const ramQty = r => (r.count || 1) > 1 ? (PCC.isPkg(byKey.get(r.key)) ? ` × ${r.count}세트` : ' × ' + r.count) : '';
  // 흑금치 동일스펙 최저가의 기준 제품 (다나와 링크)
  function sameFromEl(p) {
    const f = p && p.sameFrom; if (!f) return null;
    const txt = f.sub ? `AS 정상 제품이 더 저렴 → ${f.name}` : (f.shortAs ? `짧은 AS(${f.warranty}) 최저가: ${f.name}` : `최저가: ${f.name}`);
    return /^https?:/.test(f.link || '') ? el('a', { class: 'samefrom' + (f.sub ? ' sub' : ''), href: f.link, target: '_blank', rel: 'noopener', text: txt }) : el('span', { class: 'samefrom' + (f.sub ? ' sub' : ''), text: txt });
  }
  function makeRow(it, extra = {}) {
    return { key: keyOf(it), cat: it.cat, opt: defaultOpt(it, extra.cap, extra.color), count: extra.count || 1,
      ramMode: 'same', line: extra.line || '', cands: extra.cands || [keyOf(it)] };
  }
  function rowFromMatch(m) {
    const it = m.cands[0].it;
    const rp = it.cat === 'RAM' ? PCC.ramPack(it, m.cap, m.count || 1) : { cap: m.cap, count: 1 };
    const row = makeRow(it, { cap: rp.cap, color: m.color, count: rp.count, line: m.orig || m.line, cands: m.cands.map(c => keyOf(c.it)) });
    row.score = m.cands[0].s;
    return row;
  }
  // 읽은 글자를 고쳤을 때: 그 줄만 다시 찾고, 위쪽 글상자의 같은 부분도 고쳐 둠 (다시 "부품 찾기"를 눌러도 유지)
  function fixText(oldText, newText) {
    const parts = String(oldText || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return;
    const re = new RegExp(parts.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
    if (re.test(build.text)) build.text = build.text.replace(re, () => newText);
    else build.text = (build.text.trim() ? build.text.trim() + '\n' : '') + newText;
  }
  function rematch(newText, hintCat) {
    const t = newText.trim();
    if (!t) return null;
    const q = hintCat && !PCC.parseLine(t).cat ? `${hintCat} : ${t}` : t;
    let m = PCC.matchText(db, q).find(x => x.cands.length);
    if (!m && q !== t) m = PCC.matchText(db, t).find(x => x.cands.length);   // 분류 힌트가 틀렸을 수도 있음
    return m || null;
  }
  function editRowText(idx, newText) {
    const row = build.rows[idx], t = newText.trim();
    if (!row || !t || t === (row.line || '')) { render(); return; }
    fixText(row.line, t);
    const m = rematch(t, row.cat);
    if (m) { const n = rowFromMatch(m); n.line = t; build.rows[idx] = n; }
    else { build.rows.splice(idx, 1); build.misses.push(t); showToast('고친 글자로도 부품을 찾지 못했습니다.', 2000); }
    build.rows.sort((a, b) => CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat));
    saveBuild(); render();
  }
  function editMissText(idx, newText) {
    const old = build.misses[idx], t = newText.trim();
    if (old == null || !t || t === old) { render(); return; }
    fixText(old, t);
    const m = rematch(t, PCC.parseLine(old).cat);
    if (m) {
      build.misses.splice(idx, 1);
      const n = rowFromMatch(m); n.line = t;
      const same = build.rows.findIndex(x => x.key === n.key);
      if (same >= 0) build.rows[same] = n; else build.rows.push(n);
      build.rows.sort((a, b) => CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat));
    } else { build.misses[idx] = t; showToast('고친 글자로도 부품을 찾지 못했습니다.', 2000); }
    saveBuild(); render();
  }
  // 글자를 눌러서 바로 고치는 입력칸
  function editableText(text, onSave, cls) {
    const span = el('span', { class: 'edtext ' + (cls || ''), title: '눌러서 읽은 글자 고치기', text });
    span.addEventListener('click', () => {
      const inp = el('input', { class: 'textinput', value: text });
      let closed = false;
      const done = save => { if (closed) return; closed = true; if (save) onSave(inp.value); else render(); };
      inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
      inp.addEventListener('blur', () => done(true));
      span.replaceWith(inp); inp.focus(); inp.select();
    });
    return span;
  }
  function runMatch() {
    const results = PCC.matchText(db, build.text);
    build.rows = []; build.misses = [];
    for (const m of results) {
      if (!m.cands.length) { if (!/^\s*(os|운영|윈도우|windows)/i.test(m.line) && PCC.looksLikePart(m.orig || m.line) && !m.brandOnly && !m.section) build.misses.push(m.orig || m.line); continue; }
      const row = rowFromMatch(m), score = row.score;
      // 바로 앞 줄과 같은 종류 부품이면 (사진 속 글자 + 제품명처럼) 하나만 남김
      // 단, 둘 다 확실하게 다른 제품이면(예: SSD 2개) 둘 다 둠
      // 같은 부품이 이미 있거나(두 번 읽은 결과·사진 속 글자), 같은 종류인데 둘 중 하나라도 확실하지 않으면 더 잘 맞는 쪽만 남김
      const dupIdx = build.rows.findIndex(x => x.key === row.key);
      const sameIdx = dupIdx >= 0 ? dupIdx : build.rows.findIndex(x => x.cat === row.cat && !(x.score >= 0.85 && row.score >= 0.85));
      if (sameIdx >= 0) { if (row.score > build.rows[sameIdx].score) build.rows[sameIdx] = row; continue; }
      build.rows.push(row);
    }
    build.rows.sort((a, b) => CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat));
    // 이미 찾은 종류의 부품 조각(두 번 읽기에서 나온 잔여 줄 등)은 '찾지 못함'에서 뺌
    const have = new Set(build.rows.map(r => r.cat));
    build.misses = [...new Set(build.misses)].filter(l => !have.has(PCC.parseLine(l).cat));
    saveBuild(); render();
  }
  function addToBuild(it) {
    build.rows.push(makeRow(it));
    build.rows.sort((a, b) => CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat));
    saveBuild(); state.mode = 'build'; state.selected = null; render();
  }


  // ----- OCR (Tesseract.js, 브라우저 안에서 처리) -----
  let ocrWorker = null, ocrStatus = '';
  const setOcrStatus = s => { ocrStatus = s; const n = root.querySelector('.ocrstat'); if (n) n.textContent = s; };
  async function getWorker() {
    if (ocrWorker) return ocrWorker;
    if (typeof Tesseract === 'undefined') throw new Error('OCR 엔진 파일을 불러오지 못했습니다.');
    setOcrStatus('OCR 엔진 준비 중… (처음 한 번은 한국어 데이터를 받느라 조금 걸립니다)');
    ocrWorker = await Tesseract.createWorker('kor+eng', 1, {
      logger: m => { if (m.status && typeof m.progress === 'number' && m.status !== 'recognizing text') setOcrStatus(`OCR 준비 중… ${Math.round(m.progress * 100)}%`); }
    });
    return ocrWorker;
  }
  // 읽기 좋게 확대하고 흑백으로 바꿈
  function prepCanvas(bitmap, r, invert) {
    const sw = r ? r.w : bitmap.width, sh = r ? r.h : bitmap.height;
    let scale = sw < 900 ? 3 : sw < 1600 ? 2 : 1;
    while (scale > 1 && (sw * scale > 6000 || sw * sh * scale * scale > 24e6)) scale--;
    const c = document.createElement('canvas'); c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
    const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(bitmap, r ? r.x : 0, r ? r.y : 0, sw, sh, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height), a = d.data, W = c.width, H = c.height;
    const L = new Uint8ClampedArray(W * H);
    for (let i = 0, p = 0; i < a.length; i += 4, p++) L[p] = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    // 어두운 바탕(남색 상자 등)의 흰 글씨는 밝기를 뒤집어 검은 글씨로 바꿈: 16px 칸 평균 → 주변 5×5칸 평균이 어두우면 뒤집기
    const T = 16, tw = Math.ceil(W / T), th = Math.ceil(H / T), tm = new Float32Array(tw * th), tc = new Uint16Array(tw * th);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = ((y / T) | 0) * tw + ((x / T) | 0); tm[k] += L[y * W + x]; tc[k]++; }
    for (let k = 0; k < tm.length; k++) tm[k] /= tc[k] || 1;
    const R = 2, dark = new Uint8Array(tw * th);
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
      let s = 0, n = 0;
      for (let yy = Math.max(0, ty - R); yy <= Math.min(th - 1, ty + R); yy++) for (let xx = Math.max(0, tx - R); xx <= Math.min(tw - 1, tx + R); xx++) { s += tm[yy * tw + xx]; n++; }
      dark[ty * tw + tx] = s / n < 100 ? 1 : 0;
    }
    let darkCount = 0; for (let k = 0; k < dark.length; k++) darkCount += dark[k];
    c.darkFrac = darkCount / dark.length;
    if (!invert) dark.fill(0);
    for (let y = 0, p = 0; y < H; y++) for (let x = 0; x < W; x++, p++) {
      const v = dark[((y / T) | 0) * tw + ((x / T) | 0)] ? 255 - L[p] : L[p];
      const i = p * 4; a[i] = a[i + 1] = a[i + 2] = v;
    }
    g.putImageData(d, 0, 0);
    return c;
  }

  // 어두운 상자(남색 바탕 등) 찾기: 8px 칸 단위로 어두운 곳을 이어 붙여 직사각형 상자를 찾음
  function findDarkBoxes(bitmap, r) {
    const sx = r ? r.x : 0, sy = r ? r.y : 0, W = r ? r.w : bitmap.width, H = r ? r.h : bitmap.height;
    const k = Math.min(1, 1600 / W);   // 너무 큰 이미지는 줄여서 계산
    const cw = Math.max(1, Math.round(W * k)), ch = Math.max(1, Math.round(H * k));
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d'); g.drawImage(bitmap, sx, sy, W, H, 0, 0, cw, ch);
    const d = g.getImageData(0, 0, cw, ch).data, T = 8, tw = Math.ceil(cw / T), th = Math.ceil(ch / T);
    const m = new Float32Array(tw * th), n = new Uint16Array(tw * th);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const i = (y * cw + x) * 4, kk = ((y / T) | 0) * tw + ((x / T) | 0); m[kk] += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n[kk]++; }
    const dark = new Uint8Array(tw * th); for (let i = 0; i < m.length; i++) dark[i] = m[i] / n[i] < 90 ? 1 : 0;
    const seen = new Uint8Array(tw * th), boxes = [];
    for (let s = 0; s < dark.length; s++) {
      if (!dark[s] || seen[s]) continue;
      const q = [s]; seen[s] = 1; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, cnt = 0;
      while (q.length) {
        const kk = q.pop(); cnt++; const x = kk % tw, y = (kk / tw) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= tw || ny >= th) continue; const nk = ny * tw + nx; if (dark[nk] && !seen[nk]) { seen[nk] = 1; q.push(nk); } }
      }
      const bw = (x1 - x0 + 1) * T, bh = (y1 - y0 + 1) * T, fill = cnt / ((x1 - x0 + 1) * (y1 - y0 + 1));
      if (bw >= cw * 0.12 && bh >= 24 && bh <= ch * 0.5 && fill > 0.8) boxes.push({ x: x0 * T / k, y: y0 * T / k, w: bw / k, h: bh / k });
    }
    return boxes.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  }
  // 상자 하나를 잘라 밝기를 뒤집고 크게 키움
  function boxCanvas(bitmap, r, b) {
    const sx = (r ? r.x : 0) + b.x, sy = (r ? r.y : 0) + b.y;
    const scale = b.w < 400 ? 3 : 2;
    const c = document.createElement('canvas'); c.width = Math.round(b.w * scale); c.height = Math.round(b.h * scale);
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(bitmap, sx, sy, b.w, b.h, 0, 0, c.width, c.height);
    const id = g.getImageData(0, 0, c.width, c.height), a = id.data;
    for (let i = 0; i < a.length; i += 4) { const v = 255 - (0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2]); a[i] = a[i + 1] = a[i + 2] = v; }
    g.putImageData(id, 0, 0);
    return c;
  }

  async function runOcr(bitmap, region) {
    try {
      const w = await getWorker();
      setOcrStatus('글자 읽는 중…');
      // 단어 위치로 칸(열)을 나누고 줄을 다시 만듦. 작은 안내 문구와 신뢰도 낮은 조각은 뺌
      const readOnce = async canvas => {
        const { data } = await w.recognize(canvas, {}, { text: true, blocks: true });
        const words = [];
        let lid = 0;
        for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
          // 단어 정보가 없으면 줄 단위로라도 씀
          const ws = l.words && l.words.length ? l.words : [{ text: l.text, bbox: l.bbox, confidence: l.confidence }];
          // 줄 글자(l.text)에서 각 단어 앞에 띄어쓰기가 있었는지 알아냄 (한글은 글자마다 단어로 나뉘어 나옴)
          const lt = l.text || ''; let pos = 0; lid++;
          for (const wd of ws) {
            const t = (wd.text || '').trim(); let sp = null;
            const at = t ? lt.indexOf(t, pos) : -1;
            if (at >= 0) { sp = at > pos ? /\s/.test(lt.slice(pos, at)) : pos === 0; pos = at + t.length; }
            words.push({ t, x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1, c: wd.confidence, lid, sp });
          }
        }
        return { data, words, text: words.length ? PCC.wordsToText(words, canvas.width) : data.text.split('\n').map(s => s.trim()).filter(Boolean).join('\n') };
      };
      const c1 = prepCanvas(bitmap, region, false);
      const r1 = await readOnce(c1);
      let text = r1.text, data = r1.data;
      const boxes = c1.darkFrac > 0.03 ? findDarkBoxes(bitmap, region) : [];
      if (boxes.length >= 2) {
        // 제품명이 어두운 상자 안에 있는 형식: 상자마다 따로 읽음 (상자 하나 = 제품 하나)
        const k = c1.width / (region ? region.w : bitmap.width);   // 전체 읽기 좌표 → 원본 좌표
        const pageWords = r1.words.map(wd => ({ ...wd, x0: wd.x0 / k, x1: wd.x1 / k, y0: wd.y0 / k, y1: wd.y1 / k }));
        const blocks = [];
        await w.setParameters({ tessedit_pageseg_mode: '6' });
        try {
          for (let bi = 0; bi < boxes.length; bi++) {
            const b = boxes[bi];
            setOcrStatus(`제품명 상자 읽는 중… (${bi + 1}/${boxes.length})`);
            const { data: bd } = await w.recognize(boxCanvas(bitmap, region, b));
            const line = bd.text.split('\n').map(s => s.trim()).filter(Boolean).join(' ');
            if (!line) continue;
            // 같은 칸에서 위쪽 상자와 이 상자 사이의 맨 위 줄 = 칸 제목(예: "그래픽카드")
            const above = boxes.filter(o => o !== b && o.y + o.h <= b.y && o.x < b.x + b.w && b.x < o.x + o.w).reduce((m, o) => Math.max(m, o.y + o.h), 0);
            const hw = pageWords.filter(wd => (wd.x0 + wd.x1) / 2 > b.x && (wd.x0 + wd.x1) / 2 < b.x + b.w && wd.y0 >= above && wd.y1 <= b.y);
            let head = '';
            if (hw.length) { const top = Math.min(...hw.map(wd => wd.y0)); head = hw.filter(wd => wd.y0 < top + (wd.y1 - wd.y0) * 0.6).sort((p, q) => p.x0 - q.x0).map(wd => wd.t).join(' '); }
            blocks.push((head ? head + '\n' : '') + line);
          }
        } finally { await w.setParameters({ tessedit_pageseg_mode: '3' }); }
        if (blocks.length) text = blocks.join('\n') + '\n-----\n' + text;
      } else if (c1.darkFrac > 0.03) {
        // 어두운 바탕(흰 글씨)이 있으면 밝기를 뒤집어 한 번 더 읽고 합침 (중복은 부품 찾기에서 정리)
        setOcrStatus('어두운 바탕의 글자를 한 번 더 읽는 중…');
        const r2 = await readOnce(prepCanvas(bitmap, region, true));
        if (r2.text) text += '\n-----\n' + r2.text;
      }
      if (!text) { setOcrStatus('읽을 수 있는 글자가 없었습니다. 사양 부분만 더 좁게 선택해 보세요.'); return; }
      build.text = (build.text.trim() ? build.text.trim() + '\n' : '') + text;
      setOcrStatus(`인식 완료 (신뢰도 ${Math.round(data.confidence)}%). 결과를 확인하고 틀린 글자는 고친 뒤 다시 "부품 찾기"를 눌러도 됩니다.`);
      state.mode = 'build'; runMatch();
      setOcrStatus(ocrStatus);
    } catch (e) {
      ocrWorker = null;
      setOcrStatus('OCR을 실행하지 못했습니다. 이 사이트의 보안 설정이 막고 있을 수 있습니다. 다른 사이트(예: 다나와)에서 패널을 열고 캡처를 붙여넣어 보세요. (' + (e && e.message || e) + ')');
    }
  }
  // 이미지 범위 선택 창
  async function openCrop(blob) {
    const url = URL.createObjectURL(blob);
    let bitmap;
    try { bitmap = await createImageBitmap(blob); }
    catch (e) {   // SVG 등 createImageBitmap이 못 여는 형식은 이미지 태그로 열어서 변환
      try {
        const im = new Image(); im.src = url; await im.decode();
        const c = document.createElement('canvas'); c.width = im.naturalWidth || 1000; c.height = im.naturalHeight || 1000;
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
        bitmap = c;
      } catch (e2) { URL.revokeObjectURL(url); openPanel(); setOcrStatus('이미지를 열 수 없습니다.'); return; }
    }
    const img = el('img', { src: url, alt: '' });
    const sel = el('div', { class: 'sel', style: 'display:none' });
    const stage = el('div', { class: 'stage' }, img, sel);
    let start = null, rect = null, onMove, onUp;
    const pos = e => { const b = stage.getBoundingClientRect(); return { x: Math.max(0, Math.min(e.clientX - b.left, b.width)), y: Math.max(0, Math.min(e.clientY - b.top, b.height)) }; };
    stage.addEventListener('pointerdown', e => { e.preventDefault(); try { stage.setPointerCapture(e.pointerId); } catch (_) {} start = pos(e); rect = null; sel.style.display = 'none'; });
    window.addEventListener('pointermove', onMove = e => {
      if (!start) return; const p = pos(e);
      rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      Object.assign(sel.style, { display: 'block', left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' });
    });
    window.addEventListener('pointerup', onUp = () => { start = null; });
    window.addEventListener('pointercancel', onUp);
    const close = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp); URL.revokeObjectURL(url); modal.remove(); };
    const go = useRect => {
      let region = null;
      if (useRect && rect && rect.w > 8 && rect.h > 8) {
        const k = bitmap.width / img.clientWidth;
        region = { x: Math.round(rect.x * k), y: Math.round(rect.y * k), w: Math.round(rect.w * k), h: Math.round(rect.h * k) };
      }
      close(); openPanel(); state.mode = 'build'; render(); runOcr(bitmap, region);
    };
    const modal = el('div', { class: 'crop' },
      el('div', { class: 'bar' },
        el('b', { text: '사양이 적힌 부분을 드래그(휴대폰은 손가락으로 끌기)해서 선택하세요. 좁게 고를수록 정확합니다.' }),
        el('button', { class: 'btn', text: '선택 영역 읽기', onclick: () => go(true) }),
        el('button', { class: 'btn ghost', text: '전체 읽기', onclick: () => go(false) }),
        el('button', { class: 'btn ghost', text: '취소', onclick: close })),
      el('div', { class: 'area' }, stage));
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    root.append(modal);
  }
  // 페이지의 이미지를 클릭해서 고르기
  function pickPageImage() {
    closePanel();
    showToast(isTouch ? '사양이 담긴 이미지를 누르세요. (취소: 이 알림 누르기)' : '사양이 담긴 이미지를 클릭하세요. (취소: Esc)');
    const cancelTap = () => { done(); openPanel(); };
    toast.addEventListener('click', cancelTap, { once: true });
    let hovered = null, oldOutline = '';
    const over = e => { const t = e.target; if (t.tagName !== 'IMG' || t === hovered) return; out(); hovered = t; oldOutline = t.style.outline; t.style.outline = '4px solid #4ade80'; };
    const out = () => { if (hovered) { hovered.style.outline = oldOutline; hovered = null; } };
    const done = () => { toast.removeEventListener('click', cancelTap); document.removeEventListener('mouseover', over, true); document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true); out(); toast.style.display = 'none'; };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); done(); openPanel(); } };
    const click = e => {
      const t = e.target; if (t.tagName !== 'IMG') return;
      e.preventDefault(); e.stopPropagation();
      const src = t.currentSrc || t.src; done();
      showToast('이미지를 불러오는 중…');
      GM_xmlhttpRequest({ method: 'GET', url: src, responseType: 'blob', timeout: 30000,
        onload: r => { toast.style.display = 'none'; if (r.status >= 200 && r.status < 300 && r.response) openCrop(r.response); else { openPanel(); setOcrStatus('이미지를 받지 못했습니다 (HTTP ' + r.status + ').'); } },
        onerror: () => { toast.style.display = 'none'; openPanel(); setOcrStatus('이미지를 받지 못했습니다.'); },
        ontimeout: () => { toast.style.display = 'none'; openPanel(); setOcrStatus('이미지를 받는 데 시간이 너무 걸립니다.'); } });
    };
    document.addEventListener('mouseover', over, true); document.addEventListener('click', click, true); document.addEventListener('keydown', key, true);
  }
  // 패널에서 Ctrl+V 로 캡처 이미지 붙여넣기
  panel.addEventListener('paste', e => {
    const item = [...(e.clipboardData && e.clipboardData.items || [])].find(i => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault(); const blob = item.getAsFile(); if (blob) openCrop(blob);
  });


  const checkRows = () => build.rows.map(r => ({ it: byKey.get(r.key), count: r.count || 1, opt: r.opt })).filter(x => x.it);

  // ----- 내보내기 -----
  // ----- 조립비 (시트 계산기와 같은 컴퓨존 기준: 싱글공랭 3.5만, 듀얼공랭 4만, 수랭 4.5만, OS 설치 +1만) -----
  const ASM_DEF = { single: 35000, dual: 40000, water: 45000, os: 10000 };
  const ASM_NAME = { single: '싱글공랭', dual: '듀얼공랭', water: '수랭' };
  const asmOn = b => (b.asm !== undefined ? !!b.asm : GM_getValue('pcc_asm_default', true) !== false);
  function asmType(rows) {
    const r = rows.find(x => x.cat === 'CPU쿨러'), it = r && byKey.get(r.key);
    if (!it) return { type: 'single', note: '쿨러 없음(기본 쿨러)' };
    const t = spec(it, '분류');
    return { type: /수랭/.test(t) && !/공랭/.test(t) ? 'water' : /싱글/.test(t) ? 'single' : 'dual' };
  }
  function asmCalc(b) {
    if (!asmOn(b)) return null;
    const t = asmType(b.rows || []);
    const base = ASM_DEF[t.type] + (b.asmOs ? ASM_DEF.os : 0);
    const fee = b.asmCustom != null ? b.asmCustom : base;
    return { type: t.type, fee, base, label: `조립비 (${t.note || ASM_NAME[t.type]}${b.asmOs ? ' + OS 설치' : ''}${b.asmCustom != null ? ', 직접 입력' : ''})` };
  }

  function exportData() {
    const n = v => { const d = String(v || '').replace(/[^\d]/g, ''); return d ? Number(d) : 0; };
    const rows = build.rows.map(r => {
      const it = byKey.get(r.key); if (!it) return null;
      const opt = it.cat === 'SSD' ? '' : (r.opt || '');
      const parts = [it.name];
      if (opt && !it.name.includes(opt)) parts.push(opt);
      if (it.cat === 'RAM' && (r.count || 1) > 1) parts.push(PCC.isPkg(it) ? `× ${r.count}세트` : '× ' + r.count);   // 패키지는 이름에 '패키지'가 이미 있음
      const p = rowPrice(r);
      const clean = s => (/^(없음|x|-|해당\s*없음|불명|\s*)$/i.test(String(s || '').trim()) ? '' : String(s).trim());
      return { cat: it.cat, name: parts.join(' ') + (r.custom != null ? ' (가격 직접 입력)' : ''), price: p, perf: it.perf, rec: it.rec,
        plus: clean(it.plus), minus: clean(it.minus), issue: clean(it.issue),
        ram: it.cat === 'RAM' ? (r.ramMode === 'same' ? '동일스펙 최저가' : '제품 최저가') : '' };
    }).filter(Boolean);
    const parts = rows.reduce((s, r) => s + (r.price || 0), 0);
    const asm = asmCalc(build);
    const total = parts + (asm ? asm.fee : 0);
    const sale = n(build.sale), disc = n(build.discount), real = Math.max(0, sale - disc);
    const diff = total - real, rate = total ? diff / total * 100 : 0;
    const date = (db.rules.priceDate || '').replace(/^.*?:\s*/, '');
    const avg = PCC.averageScores(checkRows());
    const issues = PCC.checkBuild(checkRows(), { psu: build.psu }).filter(x => x.level !== 'ok');
    return { rows, parts, asm, total, sale, disc, real, diff, rate, date, avg, issues, version: db.rules.version.replace(/^.*?:\s*/, ''), missing: rows.filter(r => r.price == null).length };
  }
  const priceText = p => p == null ? '판매 정보 없음' : won(p);
  const scoreText = r => (r.perf || r.rec) ? `${r.perf || '-'} / ${r.rec || '-'}` : '-';
  const avgText = a => `성능 ${a.perf ?? '-'} / 추천 ${a.rec ?? '-'}`;
  const summaryLines = (d, withScore) => {
    const out = [`부품 합계: ${won(d.parts)}` + (d.missing ? ` (판매 정보 없는 부품 ${d.missing}개 제외)` : '')];
    if (d.asm) out.push(`${d.asm.label}: ${won(d.asm.fee)}`, `합계 (조립비 포함): ${won(d.total)}`);
    if (d.sale) {
      out.push(`판매가: ${won(d.sale)}` + (d.disc ? ` / 할인·적립: ${won(d.disc)} / 체감가: ${won(d.real)}` : ''));
      const base = d.asm ? '부품+조립비' : '부품 합계';
      out.push(`${base}보다 ${d.diff >= 0 ? '저렴' : '비쌈'}: ${won(Math.abs(d.diff))} (${Math.abs(d.rate).toFixed(1)}%)`);
    }
    if (withScore && d.avg && (d.avg.perf !== null || d.avg.rec !== null)) out.push(`평균 점수 (케이스 제외): ${avgText(d.avg)}`);
    return out;
  };
  const issueLines = d => {
    const line = x => `${x.level === 'bad' ? '✗' : x.level === 'note' ? 'ℹ' : '⚠'} ${x.title}` + (x.detail ? ` - ${x.detail}` : '');
    const bad = d.issues.filter(x => x.level !== 'note'), notes = d.issues.filter(x => x.level === 'note');
    return [...(bad.length ? ['호환성 확인 필요:', ...bad.map(line)] : []), ...(notes.length ? ['참고:', ...notes.map(line)] : [])];
  };
  const footer = d => `다나와 최저가 기준 (${d.date || '날짜 정보 없음'}, ${d.version}) · ` + (d.asm ? '조립비는 컴퓨존 기준' : '조립비 미포함');

  // 평가 내용(시트의 성능·추천 점수, 가점·감점 요소, 이슈): 판매 페이지 사진과 함께 올릴 때 덧붙이는 정보
  const EVAL = [['plus', '가점', '+', '#1a7f37'], ['minus', '감점', '−', '#cf222e'], ['issue', '이슈', '!', '#9a6700']];
  const hasScore = r => r.cat !== '케이스' && (r.perf || r.rec);

  function toPlain(d, withEval) {
    const blocks = d.rows.map(r => {
      const out = [`[${r.cat}] ${r.name} - ${priceText(r.price)}`];
      if (withEval) {
        if (hasScore(r)) out.push(`  점수: 성능 ${r.perf || '-'} / 추천 ${r.rec || '-'}`);
        EVAL.forEach(([k, label, mark]) => { if (r[k]) out.push(`  ${mark} ${label}: ${r[k]}`); });
      }
      return out.join('\n');
    });
    const iss = issueLines(d);
    return [blocks.join(withEval ? '\n\n' : '\n'), '', ...summaryLines(d, withEval), ...(iss.length ? ['', ...iss] : []), footer(d)].join('\n');
  }
  function toMarkdown(d, withEval) {
    const esc = s => String(s || '').replace(/\|/g, '\\|');
    const head = withEval ? '| 부품 | 제품명 | 가격 | 성능/추천 | 가점 요소 | 감점 요소 | 이슈 |\n|---|---|---:|:---:|---|---|---|' : '| 부품 | 제품명 | 가격 |\n|---|---|---:|';
    const body = d.rows.map(r => `| ${r.cat} | ${esc(r.name)} | ${priceText(r.price)} |` +
      (withEval ? ` ${hasScore(r) ? scoreText(r) : '-'} | ${esc(r.plus) || '-'} | ${esc(r.minus) || '-'} | ${esc(r.issue) || '-'} |` : '')).join('\n');
    const iss = issueLines(d);
    return [head, body, '', ...summaryLines(d, withEval).map(l => '**' + l.replace(/: /, ':** ')), ...(iss.length ? ['', '**' + iss[0] + '**', ...iss.slice(1).map(l => '- ' + l)] : []), '', '_' + footer(d) + '_'].join('\n');
  }
  function toHtml(d, withEval) {
    const e = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const td = 'style="border:1px solid #999;padding:4px 8px;vertical-align:top"';
    const tdS = c => `style="border:1px solid #999;padding:4px 8px;vertical-align:top;font-size:12px;color:${c}"`;
    const th = 'style="border:1px solid #999;padding:4px 8px;background:#e2efda"';
    const heads = withEval ? ['부품', '제품명', '가격', '성능/추천', '가점 요소', '감점 요소', '이슈'] : ['부품', '제품명', '가격'];
    const rows = d.rows.map(r => `<tr><td ${td}>${e(r.cat)}</td><td ${td}>${e(r.name)}</td><td ${td} align="right">${e(priceText(r.price))}</td>` +
      (withEval ? `<td ${td} align="center">${e(hasScore(r) ? scoreText(r) : '-')}</td>` + EVAL.map(([k, , , c]) => `<td ${tdS(c)}>${e(r[k]) || '-'}</td>`).join('') : '') + '</tr>').join('');
    const sums = summaryLines(d, withEval).map(l => `<tr><td ${td} colspan="${heads.length}"><b>${e(l)}</b></td></tr>`).join('');
    const iss = issueLines(d);
    const issHtml = iss.length ? `<p style="font-size:13px;color:#9a6700"><b>${e(iss[0])}</b><br>${iss.slice(1).map(e).join('<br>')}</p>` : '';
    return `<table style="border-collapse:collapse"><tr>${heads.map(h => `<th ${th}>${h}</th>`).join('')}</tr>${rows}${sums}</table>${issHtml}<p style="font-size:12px;color:#666">${e(footer(d))}</p>`;
  }

  // 견적표 이미지 (캔버스에 직접 그림): 부품마다 이름·가격·점수 한 줄, 그 아래 가점·감점·이슈
  function toCanvas(d, withEval) {
    const S = 2, W = 860, pad = 24, priceW = 130, catW = 96;
    const font = (w, s) => `${w} ${s * S}px 'Malgun Gothic','Apple SD Gothic Neo','Pretendard',sans-serif`;
    const tmp = document.createElement('canvas').getContext('2d');
    const wrap = (t, width, size, w = '') => {
      tmp.font = font(w, size); const out = []; let line = '';
      for (const ch of String(t)) { if (tmp.measureText(line + ch).width / S > width && line) { out.push(line); line = ch; } else line += ch; }
      if (line) out.push(line); return out.length ? out : [''];
    };
    const nameX = pad + catW, nameW = W - pad - priceW - nameX - 12, evalX = nameX, evalW = W - pad - evalX;
    const items = d.rows.map(r => {
      const name = wrap(r.name, nameW, 14, 'bold');
      const ev = withEval ? EVAL.filter(([k]) => r[k]).map(([k, label, mark, c]) => ({ c, mark, lines: wrap(`${label}: ${r[k]}`, evalW - 18, 12.5) })) : [];
      const h = 14 + name.length * 20 + (withEval && hasScore(r) ? 0 : 0) + ev.reduce((s, x) => s + x.lines.length * 18, 0) + (ev.length ? 6 : 0) + 10;
      return { r, name, ev, h: Math.max(h, withEval && hasScore(r) ? 56 : 40) };
    });
    const sums = summaryLines(d, withEval);
    const iss = issueLines(d).slice(1).flatMap(l => wrap(l, W - pad * 2 - 24, 12.5).map((t, i) => ({ t, first: i === 0 })));
    const H = pad + 44 + 18 + items.reduce((s, x) => s + x.h, 0) + 16 + sums.length * 26 + 16 + (iss.length ? 30 + iss.length * 18 + 10 : 0) + 30 + pad;
    const c = document.createElement('canvas'); c.width = W * S; c.height = H * S;
    const g = c.getContext('2d');
    const T = (txt, x, y, opt = {}) => { g.font = font(opt.w || '', opt.s || 14); g.fillStyle = opt.c || '#1f2328'; g.textAlign = opt.a || 'left'; g.fillText(txt, x * S, y * S); };
    const line = (y, col) => { g.fillStyle = col; g.fillRect(pad * S, y * S, (W - pad * 2) * S, 1 * S); };
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#375623'; g.fillRect(0, 0, c.width, 56 * S);
    T('완본체 견적', pad, 36, { w: 'bold', s: 20, c: '#fff' });
    if (withEval) T('점수·평가: 완본체 부품리스트&계산기', W - pad, 35, { s: 12, c: '#dfe9d6', a: 'right' });
    let y = 56 + 18;
    for (const { r, name, ev, h } of items) {
      T(r.cat, pad, y + 22, { s: 13, c: '#375623', w: 'bold' });
      name.forEach((l, i) => T(l, nameX, y + 22 + i * 20, { s: 14, w: 'bold' }));
      T(priceText(r.price), W - pad, y + 22, { s: 14, w: 'bold', a: 'right', c: r.price == null ? '#cf222e' : '#1f2328' });
      if (withEval && hasScore(r)) T(`성능 ${r.perf || '-'} · 추천 ${r.rec || '-'}`, W - pad, y + 42, { s: 12, a: 'right', c: '#57606a' });
      let ey = y + 22 + name.length * 20 + 4;
      for (const x of ev) {
        T(x.mark, evalX, ey, { s: 12.5, w: 'bold', c: x.c });
        x.lines.forEach((l, i) => T(l, evalX + 16, ey + i * 18, { s: 12.5, c: x.c === '#9a6700' ? '#7d5600' : '#3d444d' }));
        ey += x.lines.length * 18;
      }
      y += h; line(y, '#eef0f2');
    }
    y += 16;
    g.fillStyle = '#f6f8fa'; g.fillRect(pad * S, (y - 4) * S, (W - pad * 2) * S, (sums.length * 26 + 12) * S);
    sums.forEach((l, i) => {
      const isDiff = /보다 (저렴|비쌈):/.test(l), strong = isDiff || /^(부품 합계|합계)/.test(l);
      T(l, pad + 12, y + 18 + i * 26, { s: strong ? 15 : 14, w: strong ? 'bold' : '', c: isDiff ? (d.diff >= 0 ? '#1a7f37' : '#cf222e') : '#1f2328' });
    });
    y += sums.length * 26 + 16;
    if (iss.length) {
      T('호환성 확인 필요', pad, y + 18, { s: 14, w: 'bold', c: '#9a6700' }); y += 30;
      iss.forEach(x => { T(x.t, pad + (x.first ? 0 : 16), y + 14, { s: 12.5, c: x.t.startsWith('✗') ? '#cf222e' : '#3d444d' }); y += 18; });
      y += 10;
    }
    T(footer(d), pad, y + 20, { s: 12, c: '#8b949e' });
    return c;
  }

  function copyText(text, html) {
    try { if (html) GM_setClipboard(html, { type: 'html', mimetype: 'text/html' }); else GM_setClipboard(text, { type: 'text', mimetype: 'text/plain' }); return true; }
    catch (e) { try { navigator.clipboard.writeText(text); return true; } catch (e2) { return false; } }
  }
  async function exportAction(kind, withScore) {
    if (!build.rows.length) { showToast('견적에 부품이 없습니다.', 1800); return; }
    const d = exportData();
    if (kind === 'html') { copyText(toPlain(d, withScore), toHtml(d, withScore)); showToast('표로 복사했습니다. 글쓰기 화면에 붙여넣으세요.', 2200); }
    else if (kind === 'plain') { copyText(toPlain(d, withScore)); showToast('텍스트로 복사했습니다.', 1800); }
    else if (kind === 'md') { copyText(toMarkdown(d, withScore)); showToast('마크다운으로 복사했습니다.', 1800); }
    else {
      const c = toCanvas(d, withScore);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      if (kind === 'imgcopy') {
        try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); showToast('이미지를 복사했습니다. 글쓰기 화면에 붙여넣으세요.', 2200); return; }
        catch (e) { showToast('이 사이트에서는 이미지 복사가 막혀 있어 파일로 저장합니다.', 2500); }
      }
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `완본체견적_${new Date().toISOString().slice(0, 10)}.png`; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      if (kind === 'imgsave') showToast('이미지를 저장했습니다.', 1800);
    }
  }


  // ----- 견적 상세 스펙 (한눈에 보기) -----
  // 부품 종류별로 보여줄 시트 열 [열 이름, 표시 이름]
  const SPEC_KEYS = {
    'CPU': [['코어/스레드'], ['최대 클럭'], ['L3 캐시'], ['소비 전력 / 권장 전원부', '전력·권장 전원부']],
    '메인보드': [['소켓'], ['칩셋'], ['규격'], ['전원부 성능', '전원부'], ['램 슬롯'], ['램 속도', '램 최대 속도'], ['M.2'], ['SATA'], ['PCIe 슬롯'], ['전면 USB 헤더'], ['유선랜 속도', '유선랜'], ['WIFI, 블루투스', '무선']],
    'RAM': [['@ramcap', '용량'], ['세대'], ['클럭-CL', '클럭'], ['다이'], ['방열판과 RGB 유무', '방열판/RGB'], ['램 높이'], ['보증 기간']],
    '그래픽카드': [['칩셋'], ['가로 길이', '길이'], ['두께'], ['전원 포트'], ['소비 전력(최대 제한 전력)', '소비 전력'], ['쿨링팬'], ['전원부']],
    'SSD': [['용량'], ['컨트롤러'], ['낸드 정보', '낸드'], ['디램 스펙', '디램'], ['순차 읽기'], ['순차 쓰기'], ['TBW'], ['보증 기간']],
    '파워서플라이': [['@watt', '용량'], ['80PLUS 인증'], ['모듈러 여부', '모듈러'], ['AS 기간'], ['CPU 보조전원'], ['PCIe 8핀 케이블', 'PCIe 8핀'], ['12V-2x6 케이블', '12V-2x6'], ['Cybenetics 인증']],
    '케이스': [['타입'], ['사이즈', '크기(mm)'], ['최대 지원 보드 규격', '지원 보드'], ['그래픽카드', '그래픽카드 길이'], ['공랭 쿨러 최대 높이', '쿨러 높이'], ['전면 라디'], ['상단 라디'], ['기본 제공 팬'], ['전면 USB']],
    'CPU쿨러': [['분류'], ['수치', '높이 / 라디'], ['팬 사양'], ['램 높이', '램 간섭 높이'], ['수랭 호스']]
  };
  // full=true: 시트의 모든 스펙 항목 (용량·개수, 메인보드 규격은 맨 앞에 덧붙임)
  function specPairs(r, full) {
    const it = byKey.get(r.key);
    if (full) {
      const head = [];
      if (it.cat === 'RAM') head.push(['용량', ramCapText(it, r)]);
      if ((it.cat === 'SSD' || it.cat === '케이스' || it.cat === 'CPU쿨러') && r.opt && it.cat !== 'SSD') head.push(['색상', r.opt]);
      let prev = '';
      const body = (it.allSpecs || it.specs).map(([h, v]) => {
        const label = /^[AC]$/.test(h) ? `${/전면/.test(prev) ? '전면' : '후면'} USB ${h}타입` : h;
        if (!/^[AC]$/.test(h)) prev = h;
        return [label, String(v || '').trim()];
      });
      return head.concat(body).map(([k, v]) => [k, v || '-']);   // 빈칸도 '-'로 남겨서 어떤 항목이 비었는지 보이게
    }
    return (SPEC_KEYS[it.cat] || []).map(([h, label]) => {
      let v;
      if (h === '@ramcap') v = ramCapText(it, r);
      else if (h === '@watt') v = (it.name.match(/\d{3,4}\s*W/i) || [spec(it, '용량')])[0];
      else v = spec(it, h);
      return [label || h, String(v || '').trim()];
    }).map(([k, v]) => [k, v || '-']);
  }
  const specRows = () => build.rows.filter(r => byKey.get(r.key)).sort((a, b) => CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat));
  const rowTitle = r => { const it = byKey.get(r.key); return it.name + (r.opt && r.cat !== 'SSD' && r.cat !== 'RAM' && !it.name.includes(r.opt) ? ' ' + r.opt : ''); };

  function renderBuildSpecs() {
    const rows = specRows(), full = !!state.specFull;
    controls.replaceChildren(el('div', { class: 'btnrow', style: 'align-items:center' },
      el('button', { class: 'btn ghost sm', text: '← 계산기', onclick: () => { state.specView = false; render(); } }),
      el('button', { class: 'btn sm', text: '표로 복사', onclick: () => { copyText(specText(rows, full), specHtml(rows, full)); showToast('상세 스펙을 표로 복사했습니다.', 1800); } }),
      el('button', { class: 'btn ghost sm', text: '이미지 복사', onclick: () => specImage(rows, true, full) }),
      el('button', { class: 'btn ghost sm', text: '이미지 저장', onclick: () => specImage(rows, false, full) })),
      el('div', { class: 'seg', style: 'margin-top:6px' },
        el('button', { class: full ? '' : 'on', text: '주요 항목', onclick: () => { state.specFull = false; render(); } }),
        el('button', { class: full ? 'on' : '', text: '전체 항목', onclick: () => { state.specFull = true; render(); } })));
    if (!rows.length) { body.append(el('div', { class: 'msg', text: '견적에 부품이 없습니다.' })); return; }
    rows.forEach(r => {
      const it = byKey.get(r.key);
      const grid = el('div', { class: 'sgrid' }, specPairs(r, full).flatMap(([k, v]) => [el('div', { class: 'sk', text: k }), el('div', { class: 'sv', text: v })]));
      body.append(el('div', { class: 'scard' },
        el('div', { class: 'shead' }, el('span', { class: 'cat', text: it.cat }), el('span', { class: 'snm', text: rowTitle(r) }),
          el('button', { class: 'info', text: '전체 스펙', onclick: () => { state.selected = it; render(); } })),
        grid));
    });
    body.append(el('div', { class: 'hint', style: 'padding:8px 12px 16px', text: full ? '시트의 모든 스펙 항목입니다. 복사·이미지도 전체 항목으로 만들어집니다.' : '주요 항목만 골라 보여줍니다. 위에서 "전체 항목"을 고르면 시트의 모든 항목을 보여주고, 복사·이미지도 전체 항목으로 만듭니다.' }));
  }
  function specText(rows, full) {
    return rows.map(r => [`[${r.cat}] ${rowTitle(r)}`, ...specPairs(r, full).map(([k, v]) => `  ${k}: ${v}`)].join('\n')).join('\n\n');
  }
  function specHtml(rows, full) {
    const e = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const td = 'style="border:1px solid #999;padding:4px 8px;vertical-align:top;font-size:13px"';
    const th = 'style="border:1px solid #999;padding:4px 8px;background:#e2efda;vertical-align:top"';
    return `<table style="border-collapse:collapse"><tr><th ${th}>부품</th><th ${th}>제품명</th><th ${th}>주요 스펙</th></tr>` +
      rows.map(r => `<tr><th ${th}>${e(r.cat)}</th><td ${td}><b>${e(rowTitle(r))}</b></td><td ${td}>${specPairs(r, full).map(([k, v]) => `<span style="color:#57606a">${e(k)}</span> ${e(v)}`).join('<br>')}</td></tr>`).join('') + '</table>';
  }
  async function specImage(rows, copy, full) {
    const S = 2, W = 900, pad = 24, colW = (W - pad * 2 - 24) / 2, keyW = 110;
    const font = (w, s) => `${w} ${s * S}px 'Malgun Gothic','Apple SD Gothic Neo','Pretendard',sans-serif`;
    const tmp = document.createElement('canvas').getContext('2d');
    const wrap = (t, width, size, w = '') => {
      tmp.font = font(w, size); const out = []; let line = '';
      for (const ch of String(t)) { if (tmp.measureText(line + ch).width / S > width && line) { out.push(line); line = ch; } else line += ch; }
      if (line) out.push(line); return out.length ? out : [''];
    };
    // 부품마다: 제목 + 2단 칸(항목: 값)
    const cards = rows.map(r => {
      const title = wrap(rowTitle(r), W - pad * 2 - 110, 15, 'bold');
      const cells = specPairs(r, full).map(([k, v]) => ({ k: wrap(k, keyW - 6, 12, 'bold'), v: wrap(v, colW - keyW - 8, 12.5) }));
      const rowsH = []; const ln = c => (c ? Math.max(c.v.length, c.k.length) : 0);
      for (let i = 0; i < cells.length; i += 2) rowsH.push(Math.max(ln(cells[i]), ln(cells[i + 1])) * 18 + 6);
      return { r, title, cells, rowsH, h: 16 + title.length * 22 + 6 + rowsH.reduce((a, b) => a + b, 0) + 14 };
    });
    const H = 56 + 16 + cards.reduce((s, c) => s + c.h + 10, 0) + 34;
    const c = document.createElement('canvas'); c.width = W * S; c.height = H * S;
    const g = c.getContext('2d');
    const T = (txt, x, y, o = {}) => { g.font = font(o.w || '', o.s || 13); g.fillStyle = o.c || '#1f2328'; g.textAlign = o.a || 'left'; g.fillText(txt, x * S, y * S); };
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#375623'; g.fillRect(0, 0, c.width, 56 * S);
    T(full ? '견적 상세 스펙 (전체 항목)' : '견적 상세 스펙', pad, 36, { w: 'bold', s: 20, c: '#fff' });
    T('완본체 부품리스트&계산기', W - pad, 35, { s: 12, c: '#dfe9d6', a: 'right' });
    let y = 56 + 16;
    for (const cd of cards) {
      g.fillStyle = '#f6f8fa'; g.fillRect(pad * S, y * S, (W - pad * 2) * S, cd.h * S);
      g.fillStyle = '#375623'; g.fillRect(pad * S, y * S, 4 * S, cd.h * S);
      T(cd.r.cat, pad + 14, y + 26, { w: 'bold', s: 13, c: '#375623' });
      cd.title.forEach((l, i) => T(l, pad + 110, y + 26 + i * 22, { w: 'bold', s: 15 }));
      let yy = y + 16 + cd.title.length * 22 + 10;
      for (let i = 0; i < cd.cells.length; i += 2) {
        [cd.cells[i], cd.cells[i + 1]].forEach((cell, j) => {
          if (!cell) return;
          const x = pad + 14 + j * (colW + 12);
          cell.k.forEach((l, k) => T(l, x, yy + 12 + k * 18, { s: 12, c: '#57606a', w: 'bold' }));
          cell.v.forEach((l, k) => T(l, x + keyW, yy + 12 + k * 18, { s: 12.5 }));
        });
        yy += cd.rowsH[i / 2];
      }
      y += cd.h + 10;
    }
    T(`다나와 가격 갱신 ${(db.rules.priceDate || '').replace(/^.*?:\s*/, '')} · 데이터 ${(db.rules.version || '').replace(/^.*?:\s*/, '')}`, pad, y + 18, { s: 11.5, c: '#8b949e' });
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    if (copy) {
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); showToast('상세 스펙 이미지를 복사했습니다.', 2000); return; }
      catch (e) { showToast('이 사이트에서는 이미지 복사가 막혀 있어 파일로 저장합니다.', 2500); }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `완본체견적_상세스펙_${new Date().toISOString().slice(0, 10)}.png`; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    if (!copy) showToast('상세 스펙 이미지를 저장했습니다.', 1800);
  }

  // ----- 품절(판매 정보 없음) 부품의 대체 후보 -----
  const spec = (it, h) => ((it.specs.find(([k]) => k === h) || [])[1] || '');
  const isWhite = s => /화이트|white/i.test(s);
  const priced = it => it.prices.filter(p => p.price != null);
  const cheapest = it => { const ps = priced(it); return ps.length ? ps.reduce((a, b) => (a.price <= b.price ? a : b)) : null; };
  function alternatives(row) {
    const it = byKey.get(row.key); if (!it) return [];
    const out = [];
    const add = (label, apply, price) => { if (out.length < 4 && price != null) out.push({ label, apply, price }); };
    // 같은 제품의 판매 중인 다른 옵션
    if (it.cat !== 'SSD') priced(it).filter(p => p.opt !== row.opt).sort((a, b) => a.price - b.price).slice(0, 2)
      .forEach(p => add(`같은 제품 ${p.opt || '기본'}`, r => { r.opt = p.opt; }, it.cat === 'RAM' ? p.price * (row.count || 1) : p.price));
    if (it.cat === 'RAM') {
      const p = it.prices.find(x => x.opt === row.opt);
      if (p && p.sameSpec != null && row.ramMode !== 'same') add('동일스펙 최저가로 계산', r => { r.ramMode = 'same'; }, p.sameSpec * (row.count || 1));
    }
    if (it.cat === 'SSD') {
      it.base && db.items.filter(x => x.cat === 'SSD' && x.base === it.base && x !== it && cheapest(x))
        .forEach(x => add(`같은 제품 ${spec(x, '용량')}`, r => { r.key = keyOf(x); r.opt = defaultOpt(x); }, cheapest(x).price));
      const cls = spec(it, '분류'), cap = spec(it, '용량'), ctl = spec(it, '컨트롤러');
      db.items.filter(x => x.cat === 'SSD' && x !== it && x.base !== it.base && spec(x, '분류') === cls && spec(x, '용량') === cap && cheapest(x))
        .map(x => ({ x, s: (spec(x, '컨트롤러') === ctl ? 0 : 1e9) + cheapest(x).price }))
        .sort((a, b) => a.s - b.s).slice(0, 2)
        .forEach(({ x }) => add(`비슷한 스펙: ${x.name}` + (spec(x, '컨트롤러') === ctl ? ' (같은 컨트롤러)' : ''), r => { r.key = keyOf(x); r.opt = defaultOpt(x); if (!r.cands.includes(keyOf(x))) r.cands.push(keyOf(x)); }, cheapest(x).price));
    }
    if (it.cat === '그래픽카드') {
      const chip = spec(it, '칩셋'), tier = spec(it, '상·중·하급기 여부'), white = isWhite(it.name);
      const model = (it.name.match(/(RTX|GTX|RX|ARC)\s?[A-Z]?\d{3,4}\s?(XTX|XT|Ti|SUPER|GRE)?/i) || [])[0] || '';
      db.items.filter(x => x.cat === '그래픽카드' && x !== it && cheapest(x) && isWhite(x.name) === white &&
          ((chip && spec(x, '칩셋') === chip) || (model && x.name.toUpperCase().includes(model.toUpperCase()))))
        .map(x => ({ x, s: (tier && spec(x, '상·중·하급기 여부') === tier ? 0 : 1e9) + cheapest(x).price }))
        .sort((a, b) => a.s - b.s).slice(0, 3)
        .forEach(({ x }) => add(`같은 칩셋${tier && spec(x, '상·중·하급기 여부') === tier ? '·같은 급' : ''}: ${x.name}`, r => { r.key = keyOf(x); r.opt = defaultOpt(x); if (!r.cands.includes(keyOf(x))) r.cands.push(keyOf(x)); }, cheapest(x).price));
    }
    return out;
  }

  // ----- 패널 열기/닫기, 단축키 -----
  // 화면 버튼은 기본으로 켬 (설정은 패널의 '설정'에서. Tampermonkey 메뉴는 있으면 덤으로)
  const HAS_MENU = typeof GM_registerMenuCommand === 'function';
  const fabDefault = () => true;
  // 화면 버튼을 숨겨도 되는 환경: 메뉴가 있고 휴대폰이 아님 (숨기면 단축키·메뉴로만 열 수 있음)
  const canHideFab = () => HAS_MENU && !(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const applyFab = () => { fab.hidden = !panel.hidden || !GM_getValue(FAB_KEY, fabDefault()); if (!fab.hidden && typeof placeFab === 'function') placeFab(); };
  function openPanel() { panel.hidden = false; applyFab(); if (!state.loading) loadData(false); else render(); }
  function closePanel() { panel.hidden = true; applyFab(); }
  const togglePanel = () => (panel.hidden ? openPanel() : closePanel());
  // 버튼 드래그로 위치 옮기기 (위치 기억)
  const FABPOS_KEY = 'pcc_fab_pos';
  const placeFab = () => {
    const pos = GM_getValue(FABPOS_KEY, null);
    if (!pos) { Object.assign(fab.style, { left: '', top: '', right: '20px', bottom: '20px' }); return; }
    const x = Math.min(Math.max(0, pos.x * window.innerWidth), window.innerWidth - fab.offsetWidth - 4);
    const y = Math.min(Math.max(0, pos.y * window.innerHeight), window.innerHeight - fab.offsetHeight - 4);
    Object.assign(fab.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
  };
  let drag = null;
  fab.addEventListener('pointerdown', e => { const b = fab.getBoundingClientRect(); drag = { dx: e.clientX - b.left, dy: e.clientY - b.top, sx: e.clientX, sy: e.clientY, moved: false }; fab.setPointerCapture(e.pointerId); });
  fab.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
    drag.moved = true;
    const x = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - fab.offsetWidth);
    const y = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - fab.offsetHeight);
    Object.assign(fab.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto', cursor: 'grabbing' });
  });
  fab.addEventListener('pointerup', e => {
    if (!drag) return;
    const moved = drag.moved; drag = null; fab.style.cursor = '';
    if (moved) { const b = fab.getBoundingClientRect(); GM_setValue(FABPOS_KEY, { x: b.left / window.innerWidth, y: b.top / window.innerHeight }); }
    else openPanel();
  });
  window.addEventListener('resize', placeFab);

  const DEFAULT_SHORTCUT = { ctrl: false, alt: true, shift: true, meta: false, code: 'KeyP' };
  const getShortcut = () => GM_getValue(KEY_KEY, DEFAULT_SHORTCUT);
  const comboText = s => [s.ctrl && 'Ctrl', s.alt && 'Alt', s.shift && 'Shift', s.meta && 'Meta', s.code.replace(/^Key/, '').replace(/^Digit/, '')].filter(Boolean).join(' + ');
  const isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const toast = root.appendChild(document.createElement('div'));
  toast.style.cssText = 'position:fixed;left:50%;top:24px;transform:translateX(-50%);z-index:2147483647;background:#1f2328;color:#fff;padding:12px 16px;border-radius:8px;font-size:14px;box-shadow:0 4px 14px rgba(0,0,0,.3);display:none;font-family:sans-serif';
  const showToast = (msg, ms) => { toast.textContent = msg; toast.style.display = 'block'; clearTimeout(showToast.t); if (ms) showToast.t = setTimeout(() => { toast.style.display = 'none'; }, ms); };
  let capturing = false;
  window.addEventListener('keydown', e => {
    if (capturing) {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.code === 'Escape') { capturing = false; showToast('단축키 변경을 취소했습니다.', 1500); return; }
      if (!e.ctrlKey && !e.altKey && !e.metaKey) { showToast('Ctrl 또는 Alt를 함께 눌러 주세요. (취소: Esc)'); return; }
      const s = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, code: e.code };
      GM_setValue(KEY_KEY, s); capturing = false; showToast('단축키를 ' + comboText(s) + ' 로 바꿨습니다.', 2500);
      return;
    }
    const s = getShortcut();
    if (e.code === s.code && e.ctrlKey === s.ctrl && e.altKey === s.alt && e.shiftKey === s.shift && e.metaKey === s.meta) {
      e.preventDefault(); e.stopPropagation(); togglePanel();
    }
  }, true);
  ['keydown', 'keyup', 'keypress'].forEach(ev => panel.addEventListener(ev, e => e.stopPropagation()));

  root.addEventListener('click', e => {
    const t = e.target.closest('[data-act],[data-mode],[data-cat],[data-idx]');
    if (!t) return;
    if (t.dataset.act === 'close') closePanel();
    else if (t.dataset.act === 'refresh') { if (!state.loading) loadData(true); }
    else if (t.dataset.act === 'notes') showNotes(false);
    else if (t.dataset.act === 'settings') openSettings();
    else if (t.dataset.act === 'sheet') window.open('https://docs.google.com/spreadsheets/d/' + PCC.SHEET_ID + '/edit', '_blank', 'noopener');
    else if (t.dataset.act === 'back') { state.selected = null; render(); }
    else if (t.dataset.mode) { state.mode = t.dataset.mode; state.selected = null; state.specView = false; render(); }
    else if (t.dataset.cat) { if (state.cat !== t.dataset.cat) state.filters = []; state.cat = t.dataset.cat; state.selected = null; render(); }
    else if (t.dataset.idx !== undefined) { state.selected = currentResults[Number(t.dataset.idx)]; render(); }
  });

  // ----- 그리기 -----
  let currentResults = [];
  function render() {
    root.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === state.mode));
    const scriptVer = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) ? `스크립트 v${GM_info.script.version}` : '';
    // 위쪽 정보: 항목마다 줄바꿈 없이, 줄은 항목 사이에서만 넘어감 (1줄: 스크립트·데이터 버전, 2줄: 다나와 갱신·불러온 시각)
    const mi = t => el('span', { class: 'mi', text: t });
    if (db) {
      const when = new Date(db.loadedAt), pad = n => String(n).padStart(2, '0');
      const pd = String(db.rules.priceDate || '').replace(/^.*?:\s*/, ''), m = pd.match(/(\d{4})년\s*(\d+)월\s*(\d+)일\s*(\d{1,2}:\d{2})?/);
      const price = m ? `다나와 갱신 ${m[2]}/${m[3]}${m[4] ? ' ' + m[4] : ''}` : (pd ? '다나와 갱신 ' + pd : '');
      const loaded = `불러온 시각 ${when.getMonth() + 1}/${when.getDate()} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
      meta.replaceChildren(
        el('div', { class: 'mrow' }, [scriptVer, `데이터 ${(db.rules.version || '버전 정보 없음').replace(/^.*?:\s*/, '')}`].filter(Boolean).map(mi)),
        el('div', { class: 'mrow' }, [price, loaded, state.progress].filter(Boolean).map(mi)));
    } else meta.replaceChildren(scriptVer ? el('div', { class: 'mrow' }, mi(scriptVer)) : '');
    body.replaceChildren();
    panel.classList.toggle('wide', ((state.mode === 'saved' && !!state.compare) || (state.mode === 'parts' && loadPartCmp().length > 1)) && !state.selected);
    if (state.error) body.append(el('div', { class: 'msg err', text: state.error }));
    if (state.loading) { controls.replaceChildren(); body.append(el('div', { class: 'msg', text: state.progress || '데이터를 불러오는 중입니다…' })); return; }
    if (!db) { controls.replaceChildren(); return; }
    if (state.selected) { controls.replaceChildren(); body.append(renderDetail(state.selected)); return; }
    if (state.mode === 'build') { if (state.specView) renderBuildSpecs(); else renderBuild(); }
    else if (state.mode === 'power') renderPowerTab();
    else if (state.mode === 'saved') renderSaved(); else if (state.mode === 'parts') renderParts(); else renderSearch();
  }

  // 검색 화면
  let searchInput;
  function renderSearch() {
    if (!searchInput) {
      searchInput = el('input', { type: 'search', placeholder: '부품 이름 또는 질문 (예: 7500f 소비전력)' });
      let timer;
      searchInput.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.query = searchInput.value; renderSearchResults(); }, 150); });
    }
    searchInput.value = state.query;
    const chips = el('div', { class: 'chips' }, CATS.map(c => el('button', { class: 'chip' + (c === state.cat ? ' on' : ''), 'data-cat': c, text: c })));
    // 정렬·가격 조건 (추천 목록)
    const sortSel = el('select', { class: 'sortsel' }, [['auto', '관련순'], ['rec', '추천 점수순'], ['perf', '성능 점수순'], ['price', '낮은 가격순']]
      .map(([v, t]) => el('option', { value: v, text: t, selected: (state.sort || 'auto') === v ? '' : null })));
    sortSel.addEventListener('change', () => { state.sort = sortSel.value; renderSearchResults(); });
    const maxIn = el('input', { class: 'maxprice', inputmode: 'numeric', placeholder: '최대 가격', value: state.maxPrice || '' });
    maxIn.addEventListener('input', () => { state.maxPrice = maxIn.value; clearTimeout(maxIn._t); maxIn._t = setTimeout(renderSearchResults, 250); });
    const onlyChk = el('input', { type: 'checkbox' }); onlyChk.checked = state.onlyPriced !== false;
    onlyChk.addEventListener('change', () => { state.onlyPriced = onlyChk.checked; renderSearchResults(); });
    const opts = el('div', { class: 'sopts' }, sortSel, maxIn, el('label', { class: 'hint' }, onlyChk, ' 판매 중인 제품만'));
    controls.replaceChildren(searchInput, chips, opts, state.cat !== '전체' ? renderFilters() : '');
    renderSearchResults();
    setTimeout(() => searchInput.focus(), 0);
  }
  function renderSearchResults() {
    [...body.children].forEach(n => { if (!n.classList.contains('err')) n.remove(); });
    const cat = state.cat === '전체' ? '' : state.cat;
    let q = state.query.trim().toLowerCase();
    if (!q && cat) { renderRanking(db.items.filter(it => it.cat === cat), cat); return; }
    if (cat && activeFilters().length && !PCC.askSpec(db, state.query, cat)) { renderRanking(PCC.search(db, q, cat), cat); return; }
    if (!q) {
      body.append(el('div', { class: 'msg', text: '위에서 부품 종류를 고르면 추천 점수 순으로 추천 목록을 보여줍니다. (정렬·최대 가격은 아래 칸에서)' }));
      body.append(el('div', { class: 'msg', style: 'padding-top:0', text: `부품 이름을 입력하세요. 띄어쓰기로 나눈 단어가 모두 들어간 제품을 찾습니다. (총 ${db.items.length.toLocaleString()}개 제품)` }),
        el('div', { class: 'msg', style: 'padding-top:0', text: '제품 이름 뒤에 궁금한 항목을 붙이면 바로 답합니다.\n예) B850M MAX GAMING 레인 공유 · 7800X3D 소비전력 · PC801 단점 · 5070 Ti 게이밍 트리오 길이\n두 제품을 "랑/와/,"로 이어 "호환"을 붙이면 호환성을 검사합니다.\n예) 9800X3D랑 B850M 박격포 호환 · RTX 5080 NOCTUA, 1stPlayer SP5 들어가?' }));
      return;
    }
    const ans = PCC.askSpec(db, state.query, cat);
    if (ans) {
      body.append(renderAnswer(ans));
      if (ans.kind === 'compat') return;
      q = (ans.rest || '').toLowerCase();
      if (!q) return;
    }
    if (state.sort && state.sort !== 'auto') { renderRanking(PCC.search(db, q, cat), cat); return; }
    currentResults = PCC.search(db, q, cat)
      .map(it => ({ it, s: (it.alias.toLowerCase().includes(q) || it.name.toLowerCase().includes(q) ? 0 : 1) + (minPrice(it) === null ? 2 : 0) }))
      .sort((a, b) => a.s - b.s).map(x => x.it).slice(0, 100);
    if (!currentResults.length) { body.append(el('div', { class: 'msg', text: '검색 결과가 없습니다. 단어를 줄이거나 다르게 입력해 보세요.' })); return; }
    currentResults.forEach((it, i) => {
      const p = minPrice(it);
      body.append(el('div', { class: 'item', 'data-idx': String(i) },
        el('span', { class: 'cat', text: it.cat }), el('span', { class: 'nm', text: it.name }),
        el('span', { class: 'pr' + (p === null ? ' muted' : ''), text: p === null ? '가격 없음' : (it.prices.length > 1 ? won(p) + '~' : won(p)) })));
    });
  }

  // ----- 스펙 조건 검색 (예: 칩셋 = X870E, 레인 공유 여부 = 없음, M.2 ≥ 4) -----
  const FOPS = [['has', '포함'], ['all', '모두 포함'], ['eq', '같음'], ['not', '제외'], ['ge', '이상 ≥'], ['le', '이하 ≤']];
  // 분류별 검색 항목 정리: hide = 검색 목록에서 뺄 원본(통합 항목이 대신함, 상세 화면엔 그대로), ops = 항목별로 쓸 비교
  // 적지 않은 항목은 모든 비교를 씀
  const GL = 'ge,le', EGL = 'eq,ge,le', EN = 'eq,not', EG = 'eq,ge', HAN = 'has,all,not', HN = 'has,not';
  const SEARCH_CFG = {
    'CPU': { hide: ['코어/스레드', '소비 전력 / 권장 전원부', 'L3 캐시'],
      ops: { '제조사': EN, '소켓': EN, '코어 수': EGL, '스레드 수': EGL, '소비 전력': GL, '권장 전원부': GL, '최대 클럭': GL, 'CCD당 L3 캐시': EGL } },
    '메인보드': { hide: ['전원부 성능', '방열판', 'M.2 방열판 여부', 'M.2 이지 클립', 'PCIe 슬롯', '팬/RGB 헤더', '전면 USB 헤더', '후면 USB 포트', '레인 공유 여부', '유선랜 속도', 'WIFI, 블루투스', '부가기능', 'M.2'],
      ops: { '소켓': EN, '제조사': EN, '칩셋': 'eq,not,ge,le', '규격': 'eq,not,ge,le', '전원부 총 전류': GL, '모스펫 종류': EGL, '전원부 방열판 등급': EGL, 'PCB': GL, '보조전원': EGL,
        '램 슬롯': 'eq', '램 용량': GL, '램 속도': GL, 'SATA': GL, '메인 슬롯': EGL, '레거시 PCI': 'eq', 'PCIE 슬롯 이지 래치': 'eq,has',
        '전면 C타입 헤더 속도': GL, '후면 C타입 최고 속도': GL, '랜 속도': GL, '썬더볼트': EG, '레인 공유 분류': HAN, 'x8/x8 지원': 'eq', '무선랜·블루투스': 'eq',
        '랜 포트 수': EG, 'WIFI 규격': EG, '블루투스 버전': EG, '사운드칩셋': 'has', '사운드 등급': EG, '디버그 표시': EG, '부가기능 태그': HAN },
      opsRe: [[/(슬롯|헤더|커넥터) 수$|^후면 (A타입 3\.x|2\.0|A타입|C타입) 수$/, GL]] },
    'RAM': { hide: ['클럭-CL', '다이', '방열판과 RGB 유무', '다이 근거'],
      ops: { '세대': 'eq', '클럭': EGL, 'CL': EGL, '클럭÷CL': GL, '유통 용량': HAN, '다이 제조사': EN, '다이 종류': HN, '수율': EGL, '방열판': 'eq', 'RGB': 'eq', '램 높이': GL, '이슈 태그': HN, '보증 기간': EG } },
    '그래픽카드': { hide: ['전원 포트', '전원부', '소비 전력(최대 제한 전력)', '쿨링팬', '히트파이프', '베이퍼챔버', '상·중·하급기 여부', '슬롯 수'],
      ops: { '칩셋 제조사': 'eq', '칩셋': 'eq,not,ge,le', 'VRAM 용량': EGL, '제조사': EN, '가로 길이': GL, '세로 길이': GL, '두께': GL, '커넥터 종류': 'eq', '8핀 개수': EGL, '전원부 총 전류': GL,
        '기본 전력': GL, '최대 제한 전력': GL, '파워 리밋': GL, '부스트 클럭': GL, '팩토리 오버': GL, '팬 개수': EGL, '후면 팬': 'eq', '팬 크기': GL, '쿨링 방식': 'eq', '히트파이프 개수': GL, '베이퍼챔버 여부': EG, '쿨링 등급': EGL } },
    'SSD': { hide: ['분류', '용량', '디램 스펙', '낸드 안내', '컨트롤러', '낸드 정보'],
      ops: { '인터페이스': EGL, '낸드 종류': 'eq', '디램': 'eq', '용량 급': EGL, '컨트롤러 제조사': HN, '낸드 제조사': HN, '낸드 혼용': 'eq', '양면/단면': 'eq', '디램 종류': EN, 'TB당 디램': GL,
        '순차 읽기': GL, '순차 쓰기': GL, '랜덤 4K 읽기': GL, '랜덤 4K 쓰기': GL, 'SLC 캐싱': GL, 'TBW': GL, 'TB당 TBW': GL, '보증 기간': EG } },
    '파워서플라이': { hide: ['용량', '80PLUS 인증', '모듈러 여부', 'AS 기간', '콘덴서', 'CPU 보조전원', 'PCIe 8핀 케이블', '12V-2x6 케이블', 'SATA 전원 커넥터', 'MOLEX 커넥터', 'Cybenetics 인증', 'Cybenetics 리포트', '자체제작'],
      ops: { '정격 출력': EGL, '80PLUS 등급': EGL, '유통사': EN, 'OEM 제조사': EN, '모듈러 방식': EG, '무상 AS': GL, '1차 콘덴서 원산지': EN, '1차 콘덴서 온도': EN, '2차 콘덴서 원산지': HN,
        'CPU 보조전원 구성': EG, '보조전원 케이블': 'eq', 'PCIe 8핀 커넥터 수': GL, 'PCIe 케이블 가닥 수': GL, '12V-2x6 개수': EG, '12V-2x6 최대 W': 'ge', 'SATA 커넥터 수': GL, 'MOLEX 커넥터 수': GL,
        '사이베네틱스 효율': EG, '사이베네틱스 소음': EG } },
    '케이스': { hide: ['사이즈', '최대 지원 보드 규격', '기본 제공 팬', '전면팬', '상단팬', '후면팬', '하단팬', '측면팬', '전면 라디', '상단 라디', '하단 라디', '측면 라디', '그래픽카드', '그래픽카드 길이 조건', '파워서플라이', '전면 USB', '확장', '부가기능'],
      hideRe: [/^(전면|상단|후면|하단|측면) 1[24]0mm 팬$/],
      ops: { '제조사': EN, '타입': EN, '가로': GL, '깊이': GL, '높이': GL, '부피': GL, '보드 규격 등급': EGL, 'BTF 지원': HN, '기본 팬 개수': EGL, '리버스팬 개수': EGL, '기본 팬 크기': 'eq', '팬 MOLEX 연결': 'eq',
        '120mm 팬 장착 수': GL, '140mm 팬 장착 수': GL, '기타 크기 팬': 'has', '공랭 쿨러 최대 높이': GL, '그래픽카드 최대 길이': GL, '그래픽카드 최대두께': GL, '파워 규격': HN, '파워 최대 길이': GL,
        '전면 C타입 속도': GL, '전면 C타입 수': GL, '전면 A타입 수': GL, '전면 2.0 수': GL, '2.5" 최대': GL, '3.5" 최대': GL, '부가기능 태그': HAN, '주의사항': 'has' },
      opsRe: [[/라디 1[24]0계열$/, EGL], [/라디 최대(두께|길이)$/, GL]] },
    'CPU쿨러': { hide: ['분류', '펌프 RPM', '팬 사양', '수치', '램 높이', '부가기능', '라디 계열'],
      ops: { '쿨러 종류': 'eq', '타워': 'eq', '라디 크기': EGL, '히트파이프 개수': GL, '펌프 최대 RPM': GL, '팬 개수': EGL, '팬 크기': EGL, '리버스팬 개수': EG, '쿨러 높이': GL, '수랭 호스': GL,
        '램 최대 높이': 'ge', '라디 길이': GL, '라디 두께': GL, '팬 두께': GL, '라디+팬 두께': GL, '부가기능 태그': HAN, '주의사항': 'has' } }
  };
  function opsFor(cat, h) {
    if (/^@/.test(h)) return ['ge', 'le'];
    const c = SEARCH_CFG[cat]; let o = c && c.ops && c.ops[h];
    if (!o && c && c.opsRe) { const r = c.opsRe.find(([re]) => re.test(h)); if (r) o = r[1]; }
    return o ? o.split(',') : ['has', 'eq', 'not', 'ge', 'le'];
  }
  function filterCols(cat) {
    // 그 분류의 모든 제품에서 항목 이름을 모음 (일부 제품에만 있는 통합 항목도 빠지지 않게), 원본 항목은 뺌
    const c = SEARCH_CFG[cat] || {}, hide = new Set(c.hide || []);
    const hidden = h => !h || /^[AC]$/.test(h) || hide.has(h) || (c.hideRe || []).some(re => re.test(h));
    const cols = [];
    db.items.forEach(it => { if (it.cat !== cat) return; let at = 0; (it.allSpecs || it.specs).forEach(([h]) => { if (hidden(h)) return; const k = cols.indexOf(h); if (k < 0) cols.splice(at++, 0, h); else at = k + 1; }); });
    const extra = ['@가격', '@성능 점수', '@추천 점수'];
    return [...extra, ...cols];
  }
  const MULTI_OPS = ['has', 'all', 'eq', 'not'];
  const splitVals = v => String(v || '').split(/\s*,\s+/).map(x => x.trim()).filter(Boolean);
  // 조건 비교용 값: 숫자 비교는 "1개, 2개" 같은 개수는 더하고, 전원부는 A 값, 나머지는 첫 숫자
  // 램 용량 조건(유통 용량 = 48GB 등)이 걸려 있으면 그 용량 기준 값(M다이, 용량별 이슈)으로 비교
  const capFilter = () => { const f = (state.filters || []).find(x => x.h === '유통 용량' && (x.op === 'eq' || x.op === 'has') && /\d+\s*GB/i.test(x.v)); return f ? (String(f.v).match(/\d+\s*GB/i)[0].replace(/\s/g, '').toUpperCase()) : ''; };
  function fieldValue(it, h) {
    if (h === '@가격') { const p = minPrice(it); return p == null ? '' : String(p); }
    if (h === '@성능 점수') return it.perf || '';
    if (h === '@추천 점수') return it.rec || '';
    if (h === '@규격') return PCC.mbForm(it);
    if (it.cat === 'RAM') { const cap = capFilter(); if (cap) { const o = PCC.ramCapView(it, cap); if (h in o) return o[h]; } }
    return specAll(it, h);
  }
  const specAll = (it, h) => { const s = (it.allSpecs || it.specs).find(([k]) => k === h); return s ? s[1] : ''; };
  const META = h => (PCC.FIELD_META || {})[h] || null;
  const isMulti = h => h === '레인 공유 분류' || (META(h) && META(h).type === 'tags');
  function fieldNumber(h, v) {
    const s = String(v || '');
    if (/전원부/.test(h)) { const m = s.match(/(\d+)\s*A\b/); if (m) return Number(m[1]); }
    if (h === '보조전원') { const n = s.match(/\d+/g); return n ? n.reduce((a, x) => a + Number(x), 0) : null; }   // 8+4 → 12핀
    const cnt = [...s.matchAll(/(\d+)\s*개/g)];
    if (cnt.length) return cnt.reduce((a, m) => a + Number(m[1]), 0);
    const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
  // 값 여러 개(쉼표): 포함·같음 = 하나라도 맞으면, 모두 포함 = 전부 맞아야, 제외 = 하나도 안 맞아야
  function passFilters(it) {
    return (state.filters || []).every(f => {
      if (!f.h || String(f.v).trim() === '') return true;
      const vals = MULTI_OPS.includes(f.op) ? splitVals(f.v) : [String(f.v).trim()];
      if (!vals.length) return true;
      if (f.op === 'all') return vals.every(v => testOne(it, f.h, 'has', v));
      if (f.op === 'not') return vals.every(v => testOne(it, f.h, 'not', v));
      if (f.op === 'has' || f.op === 'eq') return vals.some(v => testOne(it, f.h, f.op, v));
      return testOne(it, f.h, f.op, vals[0]);
    });
  }
  function testOne(it, h, op, v0) {
    const f = { h, op, v: v0 };
    {
      const raw = fieldValue(it, f.h), low = String(raw).toLowerCase();
      let v = String(f.v).trim();
      if (f.h === '보조전원') v = v.replace(/\s*핀\s*/g, '').replace(/\s*\+\s*/g, '+');   // "8핀", "8 + 4핀"도 같은 값으로
      const vl = v.toLowerCase();
      if (f.h === '보조전원' && (f.op === 'ge' || f.op === 'le')) {   // 핀 수 합계로 비교: 12 이상 = 8+4, 8+8
        const a = fieldNumber(f.h, raw), b = fieldNumber(f.h, v);
        if (a == null || b == null) return false;
        return f.op === 'ge' ? a >= b : a <= b;
      }
      // CCD당 L3 캐시 "96+32MB": CCD 중 하나라도 맞으면 (같음 96·같음 32·이상 32 모두 걸림)
      if (f.h === 'CCD당 L3 캐시' && ['eq', 'ge', 'le'].includes(f.op)) {
        const ns = (String(raw).match(/\d+(?:\.\d+)?/g) || []).map(Number), t = Number(v.replace(/[^\d.]/g, ''));
        if (!ns.length || isNaN(t)) return false;
        return ns.some(n => f.op === 'eq' ? n === t : f.op === 'ge' ? n >= t : n <= t);
      }
      // 그래픽카드 칩셋: 제조사별 순서 (5070 이상 → NVIDIA 5070·5070 Ti·5080·5090만)
      if (it.cat === '그래픽카드' && f.h === '칩셋' && (f.op === 'ge' || f.op === 'le')) {
        const a = PCC.gpuChipRank(raw), b = PCC.gpuChipRank(v);
        if (!a || !b || a.fam !== b.fam) return false;
        return f.op === 'ge' ? a.lo >= b.lo : a.hi <= b.hi;
      }
      if (f.h === '램 최대 높이' && /제한\s*없음/.test(raw) && (f.op === 'ge' || f.op === 'le')) return f.op === 'ge';   // 제한 없음 = 어떤 높이든
      if (/라디 1[24]0계열$/.test(f.h) && /^없음$/.test(String(raw).trim()) && (f.op === 'ge' || f.op === 'le')) return f.op === 'le';   // 없음 = 0
      if (f.h === '양면/단면' && f.op === 'eq') return low.replace(/\?$/, '').trim() === vl;   // '양면?'(추정)은 양면으로
      const meta = META(f.h);
      if (meta && meta.type === 'tags') {   // 쉼표로 나뉜 값 하나하나와 비교
        const tags = low.split(/\s*,\s*/).filter(Boolean);
        if (f.op === 'has') return tags.some(t => t.includes(vl));
        if (f.op === 'not') return !tags.some(t => t.includes(vl));
        if (f.op === 'eq') return tags.some(t => t === vl || t.replace(/\s*\(.*\)$/, '') === vl);
      }
      if (meta && meta.type === 'rank' && f.op !== 'has' && f.op !== 'not') {   // 등급 순서로 비교 (예: 모스펫 종류 Dr.MOS 이상 → Dr.MOS, SPS)
        const a = PCC.rankOf(f.h, raw), b = PCC.rankOf(f.h, v);
        if (b < 0) return f.op === 'eq' ? low.trim() === vl : false;
        if (a < 0) return false;
        return f.op === 'eq' ? a === b : f.op === 'ge' ? a >= b : a <= b;
      }
      if (meta && meta.unknownPass && meta.unknownPass.test(raw) && (f.op === 'ge' || f.op === 'le')) return true;   // 최대두께 미확인 → 조건에 걸리게 두고 화면에 미확인 표시
      if (meta && meta.type === 'max' && (f.op === 'ge' || f.op === 'le')) {   // "20+10Gbps" → 가장 빠른 값으로
        const ns = (String(raw).match(/\d+(?:\.\d+)?/g) || []).map(Number), t = Number(v.replace(/[^\d.]/g, ''));
        if (!ns.length || isNaN(t)) return false;
        return f.op === 'ge' ? Math.max(...ns) >= t : Math.max(...ns) <= t;
      }
      if (f.op === 'has') return low.includes(vl);
      if (f.op === 'not') return !low.includes(vl);
      if (f.op === 'eq') return low.trim() === vl || low.split(/\s*[,/]\s*/).includes(vl) || (/^[가-힣]+$/.test(vl) && new RegExp('(^|\\s)' + vl + '$').test(low.trim()));   // "레인 공유 없음" = 없음
      if (f.h === '칩셋') {   // 칩셋은 등급으로 비교 (같은 소켓 계열 안에서만: B650 이상 → B650·B650E·B850·X870·X870E)
        const a = PCC.chipRank(raw), b = PCC.chipRank(v);
        if (!a || !b || a.fam !== b.fam) return false;
        return f.op === 'ge' ? a.rank >= b.rank : a.rank <= b.rank;
      }
      if (f.h === 'WIFI 규격') {   // 6E는 6과 7 사이로 비교
        const w = x => { const m = String(x).match(/(\d+)\s*(E?)/i); return m ? Number(m[1]) + (m[2] ? 0.5 : 0) : null; };
        const a = w(raw), b = w(v); if (a == null || b == null) return false;
        return f.op === 'ge' ? a >= b : a <= b;
      }
      const n = fieldNumber(f.h, raw), t = Number(v.replace(/[^\d.-]/g, ''));
      if (n == null || isNaN(t)) return false;
      return f.op === 'ge' ? n >= t : n <= t;
    }
  }
  // 항목별 짧은 비교 규칙 (조건 줄 아래에 표시)
  function fieldHint(cat, h) {
    if (!h) return '';
    const meta = META(h);
    if (h === '칩셋' && cat === '메인보드') return '같은 소켓 안에서 등급으로 비교 (B650E = B850)';
    if (h === '칩셋' && cat === '그래픽카드') return 'NVIDIA·AMD를 따로 성능 순서로 비교 (이상·이하는 같은 제조사끼리만)';
    if (h === 'CCD당 L3 캐시') return 'CCD 중 하나라도 맞으면 표시 (96+32MB는 96·32 둘 다 걸림)';
    if (h === '유통 용량') return '용량을 고르면 다이·이슈도 그 용량 기준으로 봅니다';
    if (h === '보조전원') return '이상·이하는 핀 수 합계로 비교 (8+4 = 12핀)';
    if (h === '램 최대 높이') return "'제한 없음'은 이상 조건에서 항상 통과";
    if (/라디 1[24]0계열$/.test(h)) return "'없음'은 0으로 계산";
    if (h === '양면/단면') return "'양면?'(추정)도 양면으로 찾음";
    if (h === 'WIFI 규격') return '6E는 6과 7 사이로 비교';
    if (/전원부/.test(h)) return '이상·이하는 총 전류(A)로 비교';
    if (meta && meta.type === 'rank') return '등급 순서로 비교 (값 목록이 낮은 순 → 높은 순)';
    if (meta && meta.type === 'max') return "'20+10Gbps'처럼 여러 값이면 가장 빠른 값으로 비교";
    if (isMulti(h)) return '여러 개 체크 시: 포함 = 하나라도, 모두 포함 = 전부, 제외 = 하나도 없음';
    if (/수$|개수/.test(h.replace(/^@/, ''))) return '숫자로 비교 (여러 개면 합산)';
    return '';
  }
  // ⓘ 스펙 조건 도움말 팝업 (패치노트 모달 모양 재사용)
  function openFilterHelp() {
    const old = root.querySelector('.notes-modal'); if (old) old.remove();
    const items = [
      ['값 칸', '누르면 시트에 있는 실제 값 목록이 나옴'],
      ['비교', '포함 = 글자가 들어 있으면 / 같음 = 값이 같으면 / 제외 = 들어 있지 않으면 / 이상·이하 = 숫자·등급으로 비교'],
      ['여러 값', '값 목록에서 여러 개를 체크하면 포함·같음은 하나라도 맞는 제품, 모두 포함은 전부 맞는 제품, 제외는 하나도 안 맞는 제품'],
      ['개수', 'M.2 "5.0 2개, 4.0 2개"처럼 개수가 여러 개면 더해서 비교'],
      ['등급', '모스펫 종류·사운드 등급·80PLUS 등급 등은 정해진 순서로 비교'],
      ['속도', '"20+10Gbps"처럼 값이 여러 개면 가장 빠른 값으로 비교'],
      ['칩셋', '메인보드는 같은 소켓 안의 등급(B650E = B850), 그래픽카드는 NVIDIA·AMD를 따로 성능 순서로 비교'],
      ['램', '유통 용량을 고르면 그 용량 기준(M다이·용량별 이슈)으로 봄'],
      ['조건 여러 개', '모든 조건을 동시에 만족하는 제품만 표시']];
    const close = () => m.remove();
    const m = el('div', { class: 'notes-modal', onclick: e => { if (e.target === m) close(); } },
      el('div', { class: 'notes-box fhelp' },
        el('div', { class: 'notes-hd' }, el('b', { text: '스펙 조건 도움말' }), el('button', { class: 'x', text: '×', title: '닫기', onclick: close })),
        el('div', { class: 'notes-list' }, items.map(([k, t]) => el('div', { class: 'notes-row' }, el('span', { class: 'notes-kind', text: k }), el('span', { text: t })))),
        el('div', { class: 'btnrow', style: 'justify-content:flex-end' }, el('button', { class: 'btn sm', text: '확인', onclick: close }))));
    panel.append(m);
  }
  function renderFilters() {
    const cols = filterCols(state.cat);
    state.filters = state.filters || [];
    const box = el('div', { class: 'filters' });
    state.filters.forEach((f, i) => {
      const colSel = el('select', {}, el('option', { value: '', text: '항목 선택' }), cols.map(h => el('option', { value: h, text: h.replace(/^@/, ''), selected: f.h === h ? '' : null })));
      const allowed = f.h ? opsFor(state.cat, f.h) : FOPS.map(x => x[0]);
      if (f.h && !allowed.includes(f.op)) f.op = allowed[0];
      const opSel = el('select', {}, FOPS.filter(([v]) => allowed.includes(v)).map(([v, t]) => el('option', { value: v, text: t, selected: f.op === v ? '' : null })));
      const valIn = el('input', { value: f.v || '', placeholder: '값', autocomplete: 'off' });
      // 값 목록: 입력한 값과 상관없이 항상 전체 목록을 보여줌 (브라우저 자동완성은 입력값으로 걸러져서 직접 만듦)
      const pop = el('div', { class: 'vpop' });
      let vals = [], hi = -1;
      const fillList = () => {
        const seen = new Map();
        const multi = isMulti(f.h);   // 여러 값이 쉼표로 붙어 있어서 하나씩 제안
        const meta = META(f.h);
        if (meta && meta.type === 'rank') { vals = meta.order.slice(); return; }   // 등급은 순서대로
        if (state.cat === '그래픽카드' && f.h === '칩셋') {   // 칩셋은 제조사별 순서대로 (시트에 있는 것만)
          const have = new Set(db.items.filter(it => it.cat === '그래픽카드').map(it => String(fieldValue(it, '칩셋')).trim()));
          vals = [...PCC.GPU_CHIP_ORDER.NVIDIA, ...PCC.GPU_CHIP_ORDER.AMD].filter(x => have.has(x)); return;
        }
        if (f.h) db.items.forEach(it => { if (it.cat !== state.cat) return; const vs = multi ? String(fieldValue(it, f.h)).split(/\s*,\s*/).map(x => x.replace(/\s*\(.*\)$/, '')) : [String(fieldValue(it, f.h)).trim()]; vs.forEach(v => { if (v && v.length < 40) seen.set(v, (seen.get(v) || 0) + 1); }); });
        vals = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([v]) => v);
      };
      // 포함·모두 포함·같음·제외는 값을 여러 개 고를 수 있음 (체크), 이상·이하는 하나만
      const multiOk = () => MULTI_OPS.includes(f.op);
      const pick = v => {
        if (multiOk()) {
          const cur = splitVals(valIn.value), k = cur.indexOf(v);
          if (k >= 0) cur.splice(k, 1); else cur.push(v);
          valIn.value = f.v = cur.join(', '); openPop(); renderSearchResults(); return;
        }
        valIn.value = v; f.v = v; closePop(); renderSearchResults();
      };
      const closePop = () => { pop.classList.remove('on'); hi = -1; };
      const openPop = () => {
        if (!vals.length) { closePop(); return; }
        const multi = multiOk(), chosen = new Set(multi ? splitVals(valIn.value) : [valIn.value.trim()]);
        pop.replaceChildren(...vals.map((v, j) => el('div', { class: 'vopt' + (chosen.has(v) ? ' cur' : '') + (j === hi ? ' hi' : ''),
          onmousedown: e => { e.preventDefault(); pick(v); } }, multi ? el('span', { class: 'ck', text: chosen.has(v) ? '☑' : '☐' }) : null, el('span', { text: v }))));
        pop.classList.add('on');
        const c = pop.querySelector('.hi') || pop.querySelector('.cur'); if (c) c.scrollIntoView({ block: 'nearest' });
      };
      fillList();
      colSel.addEventListener('change', () => { f.h = colSel.value; f.v = ''; render(); });   // 항목이 바뀌면 쓸 수 있는 비교도 바뀜
      opSel.addEventListener('change', () => {
        f.op = opSel.value;
        if (!multiOk()) { const one = splitVals(f.v)[0] || ''; if (one !== String(f.v).trim()) valIn.value = f.v = one; }   // 이상·이하는 값 하나만
        renderSearchResults();
      });
      valIn.addEventListener('input', () => { f.v = valIn.value; clearTimeout(valIn._t); valIn._t = setTimeout(renderSearchResults, 250); if (pop.classList.contains('on')) openPop(); });
      valIn.addEventListener('focus', openPop);
      valIn.addEventListener('click', () => { if (!pop.classList.contains('on')) openPop(); });
      valIn.addEventListener('blur', () => setTimeout(closePop, 120));
      valIn.addEventListener('keydown', e => {
        if (e.key === 'Escape') { closePop(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (hi < 0) hi = Math.max(-1, vals.indexOf(valIn.value.trim()));
          hi = e.key === 'ArrowDown' ? Math.min(vals.length - 1, hi + 1) : Math.max(0, hi - 1);
          openPop();
        } else if ((e.key === 'Enter' || (e.key === ' ' && multiOk())) && pop.classList.contains('on') && hi >= 0) { e.preventDefault(); pick(vals[hi]); }
      });
      box.append(el('div', { class: 'frow' }, colSel, opSel, el('div', { class: 'vwrap' }, valIn, pop),
        el('button', { class: 'x', text: '×', title: '조건 지우기', onclick: () => { state.filters.splice(i, 1); render(); } })));
      const fh = fieldHint(state.cat, f.h);   // 고른 항목에 해당하는 규칙만 그 조건 아래에 짧게
      if (fh) box.append(el('div', { class: 'fhint frowhint', text: fh }));
    });
    // A안: 목록 아래 전체 폭 '+ 조건 추가' 버튼 + ⓘ 도움말 (버튼 높이 고정, 긴 설명은 팝업으로)
    box.append(el('div', { class: 'faddrow' },
      el('button', { class: 'fadd', onclick: () => { state.filters.push({ h: '', op: 'has', v: '' }); render(); } }, '+ 조건 추가'),
      el('button', { class: 'finfo', text: 'ⓘ', title: '스펙 조건 도움말', onclick: openFilterHelp })));
    if (!state.filters.length) box.append(el('div', { class: 'fhint', text: '예) 칩셋 이상 B650 · M.2 전체 슬롯 수 이상 4' }));
    return box;
  }
  // 조건 문구: "M.2: 4개 이상", "칩셋: X870E", "레인 공유 분류: M.2와 메인 슬롯 공유 제외"
  function filterText(f) {
    const h = f.h.replace(/^@/, ''), v = String(f.v).trim();
    let val = v;
    if (h === '보조전원' && /^\d+(\s*\+\s*\d+)*\s*핀?$/.test(v)) val = v.replace(/\s*핀$/, '').replace(/\s*\+\s*/g, '+') + '핀';
    else if (/^\d+(\.\d+)?$/.test(v)) {   // 숫자만 적었으면 그 항목 값에 맞는 단위를 붙임 (개, GB, 원 …)
      if (h === '가격') val = Number(v).toLocaleString() + '원';
      else {
        const sample = db.items.filter(it => it.cat === state.cat).map(it => String(fieldValue(it, f.h))).find(x => /\d/.test(x)) || '';
        const unit = (sample.match(/\d\s*(개|GB|TB|MB|mm|W|A|MHz|M\/T|Gbps|페이즈)/) || [])[1];
        if (unit) val = v + unit;
        else if (/슬롯|개수|헤더/.test(h)) val = v + '개';
      }
    }
    const word = { has: '포함', all: '모두 포함', not: '제외', ge: '이상', le: '이하' }[f.op];
    return `${h}: ${val}${word ? ' ' + word : ''}`;
  }
  const activeFilters = () => (state.filters || []).filter(f => f.h && String(f.v).trim() !== '');

  // 추천 목록: 점수·가격으로 정렬해서 순위로 보여줌
  function renderRanking(items, cat) {
    const sc = v => { const n = parseFloat(v); return isNaN(n) ? -1 : n; };
    const maxP = Number(String(state.maxPrice || '').replace(/[^\d]/g, '')) || 0;
    let sort = ['rec', 'perf', 'price'].includes(state.sort) ? state.sort : 'rec';
    const noScore = cat === '케이스';
    if (noScore && sort !== 'price') sort = 'price';   // 케이스는 시트에 점수가 없음
    let list = items.filter(passFilters).map(it => ({ it, p: minPrice(it) }))
      .filter(x => !(state.onlyPriced !== false && x.p === null) && !(maxP && (x.p === null || x.p > maxP)));
    const byPrice = (a, b) => (a.p ?? 1e12) - (b.p ?? 1e12);
    const cmp = {
      rec: (a, b) => sc(b.it.rec) - sc(a.it.rec) || sc(b.it.perf) - sc(a.it.perf) || byPrice(a, b),
      perf: (a, b) => sc(b.it.perf) - sc(a.it.perf) || sc(b.it.rec) - sc(a.it.rec) || byPrice(a, b),
      price: byPrice
    }[sort];
    list.sort(cmp);
    currentResults = list.slice(0, 100).map(x => x.it);
    const label = { rec: '추천 점수순', perf: '성능 점수순', price: '낮은 가격순' }[sort];
    const fdesc = activeFilters().map(filterText).join(', ');
    body.append(el('div', { class: 'hint', style: 'padding:8px 12px 0' , text: `${cat || '전체'} ${label}${fdesc ? ` · 조건: ${fdesc}` : ''}${maxP ? ` · ${won(maxP)} 이하` : ''} · ${list.length.toLocaleString()}개 중 ${currentResults.length}개` + (noScore ? ' (케이스는 점수가 없어 가격순)' : '') }));
    if (!currentResults.length) { body.append(el('div', { class: 'msg', text: '조건에 맞는 제품이 없습니다. 최대 가격이나 "판매 중인 제품만"을 바꿔 보세요.' })); return; }
    const lv = v => { const n = parseFloat(v); return isNaN(n) ? '' : n < 5 ? 'lo' : n < 7 ? 'mid' : 'hi'; };
    currentResults.forEach((it, i) => {
      const p = minPrice(it);
      body.append(el('div', { class: 'item rank', 'data-idx': String(i) },
        el('span', { class: 'rk', text: String(i + 1) }),
        cat ? null : el('span', { class: 'cat', text: it.cat }),
        el('span', { class: 'nm', text: it.name }),
        it.cat !== '케이스' && (it.perf || it.rec) ? el('span', { class: 'scorebox' },
          el('span', { class: 'sc ' + lv(it.perf), text: '성능 ' + (it.perf || '-') }), el('span', { class: 'sc ' + lv(it.rec), text: '추천 ' + (it.rec || '-') })) : null,
        el('span', { class: 'pr' + (p === null ? ' muted' : ''), text: p === null ? '가격 없음' : (it.prices.length > 1 ? won(p) + '~' : won(p)) })));
    });
  }

  // ----- 견적 저장·비교 -----
  // ----- 부품 비교: 부품 2개 이상을 나란히 놓고 스펙 비교 -----
  const PCMP_KEY = 'pcc_partcmp_v1', PCMP_MAX = 6;
  const loadPartCmp = () => (GM_getValue(PCMP_KEY, []) || []).filter(k => !db || byKey.has(k));
  const inPartCmp = it => loadPartCmp().includes(keyOf(it));
  function togglePartCmp(it) {
    const k = keyOf(it); let l = loadPartCmp();
    l = l.includes(k) ? l.filter(x => x !== k) : [...l, k].slice(-PCMP_MAX);
    GM_setValue(PCMP_KEY, l);
  }
  function partCmpTable(items, onlyDiff) {
    const t = el('table', { class: 'cmp' });
    t.append(el('tr', {}, el('th', { text: items[0].cat }), ...items.map(it => el('th', {},
      el('a', { href: '#', text: it.name, onclick: e => { e.preventDefault(); state.selected = it; render(); } }), ' ',
      el('button', { class: 'x', text: '×', title: '비교에서 빼기', onclick: () => { togglePartCmp(it); render(); } })))));
    const row = (label, vals, best, fmt) => {
      const txt = vals.map((v, i) => (fmt ? fmt(v, i) : v == null || v === '' ? '-' : String(v)));
      const differ = new Set(txt).size > 1;
      if (onlyDiff && !differ) return;
      let target = null;
      if (best && differ) { const nums = vals.map(best.score).filter(x => x != null && x >= 0); if (nums.length > 1) target = best.dir === 'min' ? Math.min(...nums) : Math.max(...nums); }
      t.append(el('tr', { class: differ ? 'drow' : '' }, el('th', { text: label }), ...vals.map((v, i) => el('td', { class: target != null && best.score(v) === target ? 'best' : '', text: txt[i] }))));
    };
    row('최저가', items.map(minPrice), { dir: 'min', score: v => (v == null ? null : Number(v)) }, (p, i) => (p == null ? '가격 없음' : won(p) + (items[i].prices.length > 1 ? '~' : '')));
    if (items[0].cat !== '케이스') { row('성능 점수', items.map(it => it.perf), { dir: 'max', score: v => (v == null || v === '' ? null : parseFloat(v)) }); row('추천 점수', items.map(it => it.rec), { dir: 'max', score: v => (v == null || v === '' ? null : parseFloat(v)) }); }
    row('이슈', items.map(it => it.issue || '없음')); row('가점 요소', items.map(it => it.plus || '없음')); row('감점 요소', items.map(it => it.minus || '없음'));
    const heads = [];
    items.forEach(it => { let at = 0; (it.allSpecs || it.specs).forEach(([h]) => { if (!h) return; const k = heads.indexOf(h); if (k < 0) heads.splice(at++, 0, h); else at = k + 1; }); });
    heads.forEach(h => {
      const meta = (PCC.FIELD_META || {})[h];
      row(h, items.map(it => specAll(it, h)), meta && meta.type === 'rank' ? { dir: 'max', score: v => PCC.rankOf(h, v) } : null);
    });
    return t;
  }
  function renderParts() {
    const items = loadPartCmp().map(k => byKey.get(k)).filter(Boolean);
    state.pcmpDiff = state.pcmpDiff || false;
    const chk = el('input', { type: 'checkbox' }); chk.checked = state.pcmpDiff;
    chk.addEventListener('change', () => { state.pcmpDiff = chk.checked; render(); });
    controls.replaceChildren(el('div', { class: 'btnrow', style: 'align-items:center' },
      el('button', { class: 'btn ghost sm', text: '부품 찾아 담기', onclick: () => { state.mode = 'search'; render(); } }),
      items.length ? el('button', { class: 'btn ghost sm', text: '모두 빼기', onclick: () => { GM_setValue(PCMP_KEY, []); render(); } }) : null,
      items.length > 1 ? el('button', { class: 'btn sm', text: '비교표 복사', onclick: () => { const ts = [...body.querySelectorAll('table.cmp')]; copyText(ts.map(t => [...t.rows].map(r => [...r.cells].map(c => c.textContent.replace(/×$/, '').trim()).join('\t')).join('\n')).join('\n\n'), ts.map(t => t.outerHTML.replace(/<button[^>]*>×<\/button>/g, '')).join('<br>')); showToast('비교표를 복사했습니다.', 1800); } }) : null,
      items.length > 1 ? el('label', { class: 'hint' }, chk, ' 다른 항목만') : null,
      el('span', { class: 'hint', text: '초록색: 등급·점수·가격이 가장 좋은 값 · 굵은 줄: 제품마다 다른 항목' })));
    if (items.length < 2) {
      body.append(el('div', { class: 'msg', text: (items.length ? `지금 ${items.length}개를 담았습니다. ` : '') + '부품 검색에서 제품을 열고 "비교에 담기"를 누르세요. 2개 이상 담으면 스펙을 나란히 비교합니다. (최대 ' + PCMP_MAX + '개)' }));
      if (items.length) body.append(el('div', { class: 'cmpwrap' }, partCmpTable(items, false)));
      return;
    }
    // 분류가 섞여 있으면 분류별로 표를 나눔
    for (const cat of CAT_ORDER) {
      const g = items.filter(it => it.cat === cat);
      if (!g.length) continue;
      if (g.length === 1) body.append(el('div', { class: 'hint', style: 'padding:8px 0 4px', text: `${cat}는 1개만 담겨 있어요. 같은 분류를 하나 더 담으면 나란히 비교합니다.` }));
      body.append(el('div', { class: 'cmpwrap' }, partCmpTable(g, state.pcmpDiff && g.length > 1)));
    }
  }

  const SAVED_KEY = 'pcc_saved_v1', SAVED_MAX = 50;
  const loadSaved = () => GM_getValue(SAVED_KEY, []) || [];
  const storeSaved = list => GM_setValue(SAVED_KEY, list.slice(0, SAVED_MAX));
  const savedById = id => (id ? loadSaved().find(s => s.id === id) : null);
  const numOf = v => { const d = String(v || '').replace(/[^\d]/g, ''); return d ? Number(d) : 0; };
  const shortName = it => it.name.replace(/^(AMD|인텔)\s*/, '').replace(/\s*\([^)]*\)\s*$/, '').replace(/^(라이젠\d-\d세대|코어\s*울트라\d?\s*시리즈\d|코어i\d-\d+세대)\s*/, '');
  // 견적 하나의 합계·점수·호환성 (가격은 지금 데이터 기준으로 다시 계산)
  function buildStats(b) {
    const rows = (b.rows || []).filter(r => byKey.get(r.key));
    const parts = rows.reduce((s, r) => s + (rowPrice(r) || 0), 0);
    const asm = asmCalc(b), total = parts + (asm ? asm.fee : 0);
    const missing = rows.filter(r => rowPrice(r) == null).length;
    const sale = numOf(b.sale), disc = numOf(b.discount), real = Math.max(0, sale - disc);
    const cr = rows.map(r => ({ it: byKey.get(r.key), count: r.count || 1, opt: r.opt }));
    const checks = PCC.checkBuild(cr, { psu: b.psu });
    return { rows, parts, asm, total, missing, sale, disc, real, diff: sale ? total - real : null, avg: PCC.averageScores(cr),
      bad: checks.filter(x => x.level === 'bad').length, warn: checks.filter(x => x.level === 'warn').length, checks };
  }
  function autoName(b) {
    const one = cat => { const r = b.rows.find(x => x.cat === cat); const it = r && byKey.get(r.key); return it ? shortName(it) : ''; };
    const gr = b.rows.find(x => x.cat === '그래픽카드'), git = gr && byKey.get(gr.key);
    const gpu = git ? ((git.name.match(/(RTX|GTX|RX|ARC)\s*[A-Z]?\d{3,4}(\s*(Ti|XTX|XT|SUPER|GRE))*/i) || [''])[0] || shortName(git)) : '';
    return [one('CPU'), gpu, numOf(b.sale) ? won(numOf(b.sale)) : ''].filter(Boolean).join(' · ') || '견적';
  }
  function saveCurrent(asNew) {
    const list = loadSaved();
    const snap = JSON.parse(JSON.stringify({ rows: build.rows, misses: build.misses, text: build.text, sale: build.sale, discount: build.discount, asm: asmOn(build), asmOs: !!build.asmOs, asmCustom: build.asmCustom ?? null, psu: build.psu || null }));
    const total = buildStats(build).total;
    const old = !asNew && build.savedId && list.find(s => s.id === build.savedId);
    if (old) {
      Object.assign(old, { build: snap, savedAt: Date.now(), totalAtSave: total, dataVersion: db.rules.version });
      list.splice(list.indexOf(old), 1); list.unshift(old);
      storeSaved(list); showToast('저장한 견적을 덮어썼습니다: ' + old.name, 2000);
    } else {
      const item = { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: autoName(build), savedAt: Date.now(),
        url: location.href, pageTitle: document.title.slice(0, 120), build: snap, totalAtSave: total, dataVersion: db.rules.version };
      list.unshift(item); storeSaved(list); build.savedId = item.id; saveBuild();
      showToast(`견적을 저장했습니다 (${list.length}/${SAVED_MAX}). "저장한 견적" 탭에서 비교할 수 있습니다.`, 2400);
    }
    render();
  }
  function loadIntoBuild(s) {
    build = Object.assign({ text: '', rows: [], misses: [], sale: '', discount: '' }, JSON.parse(JSON.stringify(s.build)), { savedId: s.id });
    saveBuild(); state.mode = 'build'; state.compare = null; render();
  }
  const fmtDate = t => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  function renderSaved() {
    const list = loadSaved();
    if (state.compare) { renderCompare(list.filter(s => state.compare.includes(s.id))); return; }
    state.pick = (state.pick || []).filter(id => list.some(s => s.id === id));
    const cmpBtn = el('button', { class: 'btn sm', text: `선택한 견적 비교 (${state.pick.length})`,
      onclick: () => { if (state.pick.length >= 2) { state.compare = state.pick.slice(0, 4); render(); } } });
    if (state.pick.length < 2) cmpBtn.disabled = true;
    controls.replaceChildren(el('div', { class: 'btnrow', style: 'align-items:center' }, cmpBtn,
      el('span', { class: 'hint', text: '2~4개를 골라 비교합니다. 가격은 지금 데이터로 다시 계산합니다.' })));
    if (!list.length) { body.append(el('div', { class: 'msg', text: '저장한 견적이 없습니다.\n계산기 탭에서 부품을 찾은 뒤 "견적 저장"을 누르면 여기에 모입니다.' })); return; }
    list.forEach(s => {
      const st = buildStats(s.build);
      const chk = el('input', { type: 'checkbox' }); chk.checked = state.pick.includes(s.id);
      chk.addEventListener('change', () => {
        if (chk.checked) { if (state.pick.length >= 4) { chk.checked = false; showToast('최대 4개까지 비교할 수 있습니다.', 1600); return; } state.pick.push(s.id); }
        else state.pick = state.pick.filter(x => x !== s.id);
        render();
      });
      const name = editableText(s.name, v => { const L = loadSaved(); const t = L.find(x => x.id === s.id); if (t && v.trim()) { t.name = v.trim(); storeSaved(L); } render(); }, 'grow');
      const priceTxt = [`부품 합계 ${won(st.parts)}` + (st.missing ? ` (가격 없음 ${st.missing})` : '') + (st.asm ? ` + 조립비 ${won(st.asm.fee)}` : ''),
        st.sale ? `판매가 ${won(st.sale)}` + (st.disc ? ` → 체감가 ${won(st.real)}` : '') : '',
        st.diff != null ? (st.diff >= 0 ? `부품보다 ${won(st.diff)} 저렴` : `부품보다 ${won(-st.diff)} 비쌈`) : ''].filter(Boolean).join(' · ');
      const changed = s.totalAtSave != null && s.totalAtSave !== st.total ? ` (저장 당시 ${won(s.totalAtSave)})` : '';
      body.append(el('div', { class: 'saved' },
        el('div', { class: 'srow' }, chk, name),
        el('div', { class: 'sub2', text: priceTxt + changed }),
        el('div', { class: 'sub2' }, `평균 ${avgText(st.avg)} · `,
          el('span', { class: st.bad ? 'bad' : st.warn ? 'warnc' : 'good', text: st.bad ? `호환성 문제 ${st.bad}` + (st.warn ? `, 주의 ${st.warn}` : '') : st.warn ? `호환성 주의 ${st.warn}` : '호환성 이상 없음' }),
          ` · ${fmtDate(s.savedAt)} 저장`),
        el('div', { class: 'btnrow', style: 'margin-top:4px' },
          el('button', { class: 'btn ghost sm', text: '불러오기', onclick: () => loadIntoBuild(s) }),
          /^https?:/.test(s.url) ? el('a', { class: 'info', href: s.url, target: '_blank', rel: 'noopener noreferrer', title: s.pageTitle || s.url, text: '판매 페이지' }) : null,
          el('button', { class: 'info', style: 'margin-left:auto;color:#cf222e', text: '삭제', onclick: () => {
            if (!confirmDelete(s)) return;
            storeSaved(loadSaved().filter(x => x.id !== s.id)); state.pick = state.pick.filter(x => x !== s.id); render();
          } }))));
    });
  }
  // 삭제는 두 번 눌러야 지워짐 (실수 방지)
  let delArmed = null;
  function confirmDelete(s) {
    if (delArmed === s.id) { delArmed = null; return true; }
    delArmed = s.id; showToast(`"${s.name}"을(를) 지우려면 삭제를 한 번 더 누르세요.`, 2500);
    setTimeout(() => { if (delArmed === s.id) delArmed = null; }, 3000);
    return false;
  }

  function renderCompare(items) {
    const stats = items.map(s => buildStats(s.build));
    controls.replaceChildren(el('div', { class: 'btnrow', style: 'align-items:center' },
      el('button', { class: 'btn ghost sm', text: '← 목록으로', onclick: () => { state.compare = null; render(); } }),
      el('button', { class: 'btn sm', text: '비교표 복사', title: '커뮤니티 글쓰기 편집기에 표로 붙여넣기', onclick: () => { copyText(compareText(items, stats), compareHtml(items, stats)); showToast('비교표를 복사했습니다.', 1800); } }),
      el('span', { class: 'hint', text: '초록색: 가장 좋은 값 · 굵은 글씨: 견적마다 다른 부품' })));
    const t = el('table', { class: 'cmp' });
    t.append(el('tr', {}, el('th', { text: '' }), ...items.map(s => el('th', { text: s.name }))));
    // 부품 줄
    for (const cat of CAT_ORDER) {
      const cells = stats.map(st => st.rows.filter(r => r.cat === cat));
      if (cells.every(c => !c.length)) continue;
      const keys = cells.map(c => c.map(r => r.key + '|' + (r.opt || '') + '|' + (r.count || 1)).join(','));
      const differ = new Set(keys).size > 1;
      t.append(el('tr', {}, el('th', { text: cat }), ...cells.map(rs => el('td', { class: differ ? 'diff' : '' }, ...(rs.length ? rs.map(r => {
        const it = byKey.get(r.key), p = rowPrice(r);
        const nm = it.name + (r.opt && r.cat !== 'SSD' && !it.name.includes(r.opt) ? ' ' + r.opt : '') + (r.cat === 'RAM' ? ramQty(r) : '');
        return el('div', { class: 'cp' }, el('div', { class: 'cn', text: nm }),
          el('div', { class: 'cs', text: [p == null ? '가격 없음' : won(p), it.cat !== '케이스' && (it.perf || it.rec) ? `성능 ${it.perf || '-'} · 추천 ${it.rec || '-'}` : ''].filter(Boolean).join(' · ') }));
      }) : [el('span', { text: '없음' })])))));
    }
    // 요약 줄: best = 'min' | 'max'
    const sumRow = (label, vals, fmt, best) => {
      const nums = vals.filter(v => v != null && !isNaN(v));
      const target = best && nums.length > 1 ? (best === 'min' ? Math.min(...nums) : Math.max(...nums)) : null;
      t.append(el('tr', { class: 'sumr' }, el('th', { text: label }), ...vals.map(v => el('td', { class: target != null && v === target ? 'best' : '', text: v == null ? '-' : fmt(v) }))));
    };
    sumRow('부품 합계', stats.map(s => s.parts), won, null);   // 부품 구성이 달라서 합계가 낮다고 더 좋은 건 아님
    if (stats.some(s => s.asm)) { sumRow('조립비', stats.map(s => (s.asm ? s.asm.fee : null)), won, null); sumRow('합계 (조립비 포함)', stats.map(s => s.total), won, null); }
    if (stats.some(s => s.sale)) {
      sumRow('판매가', stats.map(s => s.sale || null), won, 'min');
      if (stats.some(s => s.disc)) sumRow('체감가', stats.map(s => s.sale ? s.real : null), won, 'min');
      sumRow(stats.some(s => s.asm) ? '부품+조립비 대비' : '부품 합계 대비', stats.map(s => (s.diff == null ? null : s.diff)), v => (v >= 0 ? `${won(v)} 저렴` : `${won(-v)} 비쌈`), 'max');
    }
    sumRow('평균 성능', stats.map(s => s.avg.perf), v => String(v), 'max');
    sumRow('평균 추천', stats.map(s => s.avg.rec), v => String(v), 'max');
    t.append(el('tr', { class: 'sumr' }, el('th', { text: '호환성' }), ...stats.map(s => el('td', {},
      ...(s.bad || s.warn ? s.checks.filter(x => x.level === 'bad' || x.level === 'warn').map(x => el('div', { class: x.level === 'bad' ? 'bad' : 'warnc', text: (x.level === 'bad' ? '✗ ' : '! ') + x.title })) : [el('span', { class: 'good', text: '이상 없음' })])))));
    body.append(el('div', { class: 'cmpwrap' }, t));
  }
  function compareText(items, stats) {
    const out = [];
    items.forEach((s, i) => {
      const st = stats[i];
      out.push(`■ ${s.name}`);
      st.rows.forEach(r => { const it = byKey.get(r.key); out.push(`  ${r.cat}: ${it.name}${r.cat === 'RAM' ? ramQty(r) : ''} - ${priceText(rowPrice(r))}`); });
      out.push(`  부품 합계: ${won(st.parts)}` + (st.asm ? ` / 조립비: ${won(st.asm.fee)} / 합계: ${won(st.total)}` : '') + (st.sale ? ` / 판매가: ${won(st.sale)}` + (st.disc ? ` / 체감가: ${won(st.real)}` : '') : ''));
      out.push(`  평균 점수: ${avgText(st.avg)} / 호환성: ${st.bad || st.warn ? `문제 ${st.bad}, 주의 ${st.warn}` : '이상 없음'}`, '');
    });
    out.push(`다나와 최저가 기준 (${(db.rules.priceDate || '').replace(/^.*?:\s*/, '')}) · 조립비는 컴퓨존 기준`);
    return out.join('\n');
  }
  function compareHtml(items, stats) {
    const e = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const td = 'style="border:1px solid #999;padding:4px 8px;vertical-align:top;font-size:13px"';
    const th = 'style="border:1px solid #999;padding:4px 8px;background:#e2efda"';
    let h = `<table style="border-collapse:collapse"><tr><th ${th}></th>${items.map(s => `<th ${th}>${e(s.name)}</th>`).join('')}</tr>`;
    for (const cat of CAT_ORDER) {
      const cells = stats.map(st => st.rows.filter(r => r.cat === cat));
      if (cells.every(c => !c.length)) continue;
      h += `<tr><th ${th}>${cat}</th>${cells.map(rs => `<td ${td}>${rs.map(r => { const it = byKey.get(r.key); return `${e(it.name)}${r.cat === 'RAM' ? ramQty(r) : ''}<br><small>${e(priceText(rowPrice(r)))}${it.cat !== '케이스' && (it.perf || it.rec) ? ` · 성능 ${e(it.perf || '-')} · 추천 ${e(it.rec || '-')}` : ''}</small>`; }).join('<br>') || '-'}</td>`).join('')}</tr>`;
    }
    const row = (label, vals) => { h += `<tr><th ${th}>${label}</th>${vals.map(v => `<td ${td}><b>${e(v)}</b></td>`).join('')}</tr>`; };
    row('부품 합계', stats.map(s => won(s.parts)));
    if (stats.some(s => s.asm)) { row('조립비', stats.map(s => (s.asm ? won(s.asm.fee) : '-'))); row('합계 (조립비 포함)', stats.map(s => won(s.total))); }
    if (stats.some(s => s.sale)) { row('판매가', stats.map(s => (s.sale ? won(s.sale) : '-'))); row('체감가', stats.map(s => (s.sale ? won(s.real) : '-'))); }
    row('평균 점수', stats.map(s => avgText(s.avg)));
    row('호환성', stats.map(s => (s.bad || s.warn ? `문제 ${s.bad}, 주의 ${s.warn}` : '이상 없음')));
    return h + `</table><p style="font-size:12px;color:#666">${e(`다나와 최저가 기준 (${(db.rules.priceDate || '').replace(/^.*?:\s*/, '')}) · 조립비는 컴퓨존 기준`)}</p>`;
  }

  // 검색창 질문에 대한 답 카드
  function renderAnswer(ans) {
    const box = el('div', { class: 'answer compat' });
    const link = it => el('button', { class: 'info', text: it.name, title: '상세 보기', onclick: () => { state.selected = it; render(); } });
    if (ans.kind === 'compat') {
      box.append(el('div', { class: 'sec', style: 'margin-top:0', text: '호환성 검사' }));
      ans.parts.forEach(p => box.append(el('div', { class: 'ans-part' }, el('span', { class: 'cat', text: p.it.cat }), link(p.it))));
      const checks = ans.checks;
      if (!checks.length) box.append(el('div', { class: 'hint', text: '이 두 부품 사이에는 검사할 항목이 없습니다. (예: CPU-메인보드, 메인보드-램, 케이스-그래픽카드, 파워-그래픽카드)' }));
      checks.forEach(x => box.append(el('div', { class: 'ci ' + x.level },
        el('span', { class: 'ic', text: x.level === 'bad' ? '✗' : x.level === 'warn' ? '!' : x.level === 'note' ? 'i' : '✓' }),
        el('div', {}, el('div', { class: 'ct', text: x.title }), x.detail ? el('div', { class: 'cd', text: x.detail }) : null))));
      box.append(el('div', { class: 'hint', style: 'margin-top:6px', text: '다른 제품을 뜻했다면 제품 이름을 더 자세히 적어 주세요.' }));
      return box;
    }
    if (!ans.part) { box.append(el('div', { class: 'hint', text: `"${ans.rest || '(제품 이름 없음)'}"에 해당하는 제품을 찾지 못했습니다. 제품 이름을 함께 적어 주세요.` })); return box; }
    const it = ans.part.it;
    box.append(el('div', { class: 'ans-part' }, el('span', { class: 'cat', text: it.cat }), link(it), ans.part.guess ? el('span', { class: 'tag', text: '추정' }) : null));
    if (!ans.fields.length) box.append(el('div', { class: 'hint', text: '이 제품에는 물어본 항목이 없습니다. "상세"에서 전체 스펙을 확인하세요.' }));
    else box.append(el('table', {}, ans.fields.map(([h, v]) => el('tr', {}, el('th', { text: h }), el('td', { text: v })))));
    if (ans.part.others && ans.part.others.length) box.append(el('div', { class: 'hint', style: 'margin-top:6px' }, '다른 후보: ',
      ...ans.part.others.flatMap((o, i) => [i ? ' · ' : '', link(o)])));
    return box;
  }

  // 견적 화면
  function renderBuild() {
    const ta = el('textarea', { placeholder: '판매 페이지의 사양을 복사해서 붙여넣으세요. 한 줄에 부품 하나씩 찾습니다.\n예) CPU : AMD 라이젠5 7500F\n     메모리 : 삼성 DDR5-5600 16GB x2' });
    ta.value = build.text;
    ta.addEventListener('input', () => { build.text = ta.value; saveBuild(); });
    const fileIn = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    fileIn.addEventListener('change', () => { if (fileIn.files[0]) openCrop(fileIn.files[0]); fileIn.value = ''; });
    const ocrBar = el('div', { class: 'ocrbar' },
      el('span', { class: 'hint', text: '이미지로 읽기:' }),
      el('button', { class: 'btn ghost sm', text: '페이지 이미지 고르기', onclick: pickPageImage }),
      el('button', { class: 'btn ghost sm', text: '이미지 파일', onclick: () => fileIn.click() }),
      el('span', { class: 'hint onlymouse', text: '또는 캡처(Win+Shift+S) 후 여기서 Ctrl+V' }),
      el('span', { class: 'hint onlytouch', text: '휴대폰: 판매 페이지를 캡처한 뒤 "이미지 파일"로 고르세요' }), fileIn);
    const taLabel = el('div', { class: 'hint', text: build.text.trim() ? '읽은 글자 (틀린 글자를 고치고 "부품 찾기"를 다시 누르거나, 아래 부품의 "읽은 글자"를 눌러 한 줄씩 고칠 수 있습니다)' : '' });
    controls.replaceChildren(taLabel, ta, ocrBar, el('div', { class: 'ocrstat', text: ocrStatus }), el('div', { class: 'btnrow' },
      el('button', { class: 'btn', text: '부품 찾기', onclick: () => { build.text = ta.value; runMatch(); } }),
      el('button', { class: 'btn ghost', text: '부품 직접 추가', onclick: () => { state.mode = 'search'; render(); } }),
      el('button', { class: 'btn ghost', text: '비우기', onclick: () => { build = { text: '', rows: [], misses: [], sale: '', discount: '' }; saveBuild(); render(); } })),
      build.rows.length ? el('div', { class: 'btnrow', style: 'margin-top:6px' },
        el('button', { class: 'btn sm', text: '상세 스펙', title: '견적 부품의 주요 스펙을 한눈에 (표·이미지로 복사 가능)', onclick: () => { state.specView = true; render(); } }),
        el('button', { class: 'btn ghost sm', text: savedById(build.savedId) ? '저장한 견적 덮어쓰기' : '견적 저장', onclick: () => saveCurrent(false) }),
        savedById(build.savedId) ? el('button', { class: 'btn ghost sm', text: '새로 저장', onclick: () => saveCurrent(true) }) : null,
        savedById(build.savedId) ? el('span', { class: 'hint', text: '불러온 견적: ' + savedById(build.savedId).name }) : '') : '');

    if (!build.rows.length && !build.misses.length) {
      body.append(el('div', { class: 'msg', text: '사양을 붙여넣고 "부품 찾기"를 누르면 견적표가 만들어집니다. 잘못 찾은 부품은 줄마다 다른 후보로 바꿀 수 있습니다.' }));
      return;
    }
    build.rows.forEach((row, idx) => body.append(renderPart(row, idx)));
    build.misses.forEach((line, idx) => body.append(el('div', { class: 'miss' },
      el('span', { text: '찾지 못함:', style: 'flex:none' }),
      editableText(line, v => editMissText(idx, v), 'grow'),
      el('button', { class: 'btn ghost sm', text: '검색', onclick: () => { state.mode = 'search'; state.query = PCC.parseLine(line).text; render(); if (searchInput) { searchInput.value = state.query; renderSearchResults(); } } }),
      el('button', { class: 'x', title: '지우기', text: '×', onclick: () => { build.misses.splice(idx, 1); saveBuild(); render(); } }))));
    const sc = renderScore(); if (sc) body.append(sc);   // 평균 점수를 호환성 검사 위에 크게
    const pq = renderPowerLine(); if (pq) body.append(pq);   // 파워 계산 한 줄 요약 (자세한 건 '파워 계산' 탭)
    body.append(renderCompat());
    body.append(renderSum());
    const scoreChk = el('input', { type: 'checkbox' }); scoreChk.checked = GM_getValue('pcc_export_eval', true) !== false;
    scoreChk.addEventListener('change', () => GM_setValue('pcc_export_eval', scoreChk.checked));
    const act = k => () => exportAction(k, scoreChk.checked);
    body.append(el('div', { class: 'sum', style: 'border-top:none;padding-top:0' },
      el('div', { class: 'sec', style: 'margin-top:4px', text: '내보내기' }),
      el('div', { class: 'ocrbar' },
        el('button', { class: 'btn sm', text: '표로 복사', title: '커뮤니티 글쓰기 편집기에 표로 붙여넣기', onclick: act('html') }),
        el('button', { class: 'btn ghost sm', text: '텍스트로 복사', onclick: act('plain') }),
        el('button', { class: 'btn ghost sm', text: '마크다운 복사', onclick: act('md') })),
      el('div', { class: 'ocrbar', style: 'margin-top:6px' },
        el('button', { class: 'btn ghost sm', text: '이미지 복사', onclick: act('imgcopy') }),
        el('button', { class: 'btn ghost sm', text: '이미지 저장', onclick: act('imgsave') }),
        el('label', { class: 'hint', style: 'display:flex;gap:4px;align-items:center;margin-left:auto' }, scoreChk, '점수·가감점·이슈 포함')),
      el('div', { class: 'ocrbar', style: 'margin-top:6px' },
        el('button', { class: 'btn ghost sm', text: '상세 스펙 표로 복사', title: '견적 부품의 시트 스펙 전체를 표로', onclick: () => { copyText(specText(specRows(), true), specHtml(specRows(), true)); showToast('상세 스펙(전체 항목)을 표로 복사했습니다.', 1800); } }),
        el('button', { class: 'btn ghost sm', text: '상세 스펙 이미지 복사', onclick: () => specImage(specRows(), true, true) }),
        el('button', { class: 'btn ghost sm', text: '상세 스펙 이미지 저장', onclick: () => specImage(specRows(), false, true) }))));
  }

  function renderPart(row, idx) {
    const it = byKey.get(row.key);
    if (!it) return el('div', { class: 'miss' }, el('span', { text: '데이터에서 사라진 부품: ' + row.key.split('|')[1] }),
      el('button', { class: 'x', text: '×', onclick: () => { build.rows.splice(idx, 1); saveBuild(); render(); } }));
    const cand = el('select', { class: 'cand', title: '다른 후보로 바꾸기' },
      row.cands.map(k => byKey.get(k)).filter(Boolean).map(c => el('option', { value: keyOf(c), selected: keyOf(c) === row.key, text: c.name })));
    cand.addEventListener('change', () => {
      const n = byKey.get(cand.value); const p = PCC.parseLine(row.line || '');
      const rp = n.cat === 'RAM' ? PCC.ramPack(n, p.cap, p.count || 1) : { cap: p.cap, count: row.count };
      Object.assign(row, { key: cand.value, cat: n.cat, opt: defaultOpt(n, rp.cap, p.color), count: rp.count, custom: null }); saveBuild(); render();
    });
    const sub = el('div', { class: 'sub' });
    if (it.cat === 'SSD' && it.base) {
      // SSD: 같은 제품의 다른 용량(=다른 행)으로 바꾸기
      const sibs = db.items.filter(x => x.cat === 'SSD' && x.base === it.base);
      const capOf = x => (x.prices[0] && x.prices[0].opt) || x.name;
      const os = el('select', { title: '용량' }, sibs.map(x => el('option', { value: keyOf(x), selected: keyOf(x) === row.key,
        text: capOf(x) + (x.prices[0] && x.prices[0].price != null ? ' · ' + won(x.prices[0].price) : ' (판매 정보 없음)') })));
      os.addEventListener('change', () => { const n = byKey.get(os.value); row.key = os.value; row.opt = defaultOpt(n); row.custom = null; if (!row.cands.includes(os.value)) row.cands.push(os.value); saveBuild(); render(); });
      sub.append(os);
    } else if (it.prices.length > 1 || (it.prices.length === 1 && it.prices[0].opt) || (row.opt && it.cat !== 'SSD')) {
      const opts = it.prices.map(p => ({ v: p.opt, t: (p.opt || '기본') + (p.price == null ? ' (판매 정보 없음)' : ' · ' + won(p.price)) }));
      if (row.opt && !it.prices.some(p => p.opt === row.opt)) opts.unshift({ v: row.opt, t: row.opt + ' (판매 정보 없음)' });
      const os = el('select', { title: optLabel(it.cat) }, opts.map(o => el('option', { value: o.v, selected: o.v === row.opt, text: o.t })));
      os.addEventListener('change', () => { row.opt = os.value; row.custom = null; saveBuild(); render(); });
      sub.append(os);
    }
    if (it.cat === 'RAM') {
      const pk = PCC.isPkg(it);
      const cs = el('select', { title: pk ? '세트 수 (패키지 한 세트 = 램 ' + PCC.PKG_STICKS + '개)' : '개수' }, (pk ? [1, 2] : [1, 2, 4]).map(n => el('option', { value: n, selected: n === row.count, text: n + (pk ? '세트' : '개') })));
      cs.addEventListener('change', () => { row.count = Number(cs.value); saveBuild(); render(); });
      const ms = el('select', { title: '가격 기준' }, [['same', '동일스펙 최저가'], ['product', '제품 최저가']].map(([v, t]) => el('option', { value: v, selected: v === row.ramMode, text: t })));
      ms.addEventListener('change', () => { row.ramMode = ms.value; saveBuild(); render(); });
      sub.append(cs, ms);
      const po = it.prices.find(x => x.opt === row.opt) || it.prices[0];
      if (row.ramMode === 'same' && row.custom == null) { const n = sameFromEl(po); if (n) sub.append(n); }
    }
    const p = rowPrice(row);
    const priceEl = el('span', { class: 'pr editable' + (p == null ? ' bad' : ''), title: '눌러서 가격 직접 입력', text: p == null ? '판매 정보 없음' : won(p) });
    if (row.custom != null) priceEl.append(el('span', { class: 'tag', text: '직접 입력' }));
    priceEl.addEventListener('click', () => {
      const inp = el('input', { inputmode: 'numeric', class: 'priceinput', placeholder: '가격', value: p != null ? String(Math.round(p)) : '' });
      const done = save => {
        if (save) { const d = inp.value.replace(/[^\d]/g, ''); row.custom = d ? Number(d) : null; saveBuild(); }
        render();
      };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
      inp.addEventListener('blur', () => done(true));
      priceEl.replaceWith(inp); inp.focus(); inp.select();
    });
    sub.append(el('button', { class: 'info', text: '상세', onclick: () => { state.selected = it; render(); } }));
    if (/^https:\/\//.test(it.link)) sub.append(el('a', { class: 'info', href: it.link, target: '_blank', rel: 'noopener noreferrer', title: '다나와 상품 페이지 (새 탭)', text: '다나와' }));
    // 성능·추천 점수 (10점 만점): 낮은 부품이 바로 보이게 색으로 구분
    if (it.cat !== '케이스' && (it.perf || it.rec)) {
      const lv = v => { const n = parseFloat(v); return isNaN(n) ? '' : n < 5 ? 'lo' : n < 7 ? 'mid' : 'hi'; };
      sub.append(el('span', { class: 'scorebox', title: '시트의 성능 / 추천 점수 (10점 만점)' },
        el('span', { class: 'sc ' + lv(it.perf), text: '성능 ' + (it.perf || '-') }),
        el('span', { class: 'sc ' + lv(it.rec), text: '추천 ' + (it.rec || '-') })));
    }
    sub.append(priceEl);
    if (row.custom != null) sub.append(el('button', { class: 'info', text: '원래 가격', title: '직접 입력한 가격 지우기', onclick: () => { row.custom = null; saveBuild(); render(); } }));
    // 판매 정보가 없으면 대체 후보 제안
    let altBox = null;
    if (p == null) {
      const alts = alternatives(row);
      altBox = el('div', { class: 'alts' },
        el('div', { class: 'hint', text: alts.length ? '판매 정보가 없습니다. 대체 후보:' : '판매 정보가 없습니다. 다른 후보를 고르거나 가격을 눌러 직접 입력하세요.' }),
        alts.map(a => el('button', { class: 'alt', onclick: () => { a.apply(row); row.custom = null; saveBuild(); render(); } },
          el('span', { text: a.label }), el('b', { text: won(a.price) }))));
    }
    return el('div', { class: 'part' },
      el('div', { class: 'top' }, el('span', { class: 'cat', text: it.cat }), cand,
        el('button', { class: 'x', title: '견적에서 빼기', text: '×', onclick: () => { build.rows.splice(idx, 1); saveBuild(); render(); } })),
      sub, altBox, row.line ? el('div', { class: 'src' }, el('span', { text: '읽은 글자: ', style: 'flex:none' }), editableText(row.line, v => editRowText(idx, v), 'grow'),
        el('span', { class: 'edhint', text: '✎' })) : null);
  }

  // 평균 성능·추천 점수 (케이스 제외, 시트 계산기와 같은 방식) → 큰 숫자 두 칸
  function renderScore() {
    const avg = PCC.averageScores(checkRows());
    if (avg.perf === null && avg.rec === null) return null;
    const tile = (label, v) => el('div', { class: 'stile' }, el('div', { class: 'sl', text: label }),
      el('div', { class: 'sv' }, el('b', { text: v ?? '-' }), el('span', { text: ' / 10' })));
    return el('div', { class: 'sum scores', title: '시트 계산기와 같이 케이스를 뺀 부품의 평균 (10점 만점)' },
      el('div', { class: 'sgrid2' }, tile('평균 성능', avg.perf), tile('평균 추천', avg.rec)),
      el('div', { class: 'hint', style: 'margin-top:4px;text-align:center', text: '케이스를 뺀 부품의 평균 점수' }));
  }

  // '파워 계산' 탭: 계산기 탭의 견적으로 계산
  function renderPowerTab() {
    controls.replaceChildren(el('div', { class: 'hint', text: '계산기 탭에 담은 견적으로 예상 소비 전력과 파워 용량을 계산합니다. 팬·HDD를 더 달 계획이면 아래 옵션에 넣어 주세요.' }));
    const p = renderPower();
    if (p) { body.append(p); return; }
    body.append(el('div', { class: 'msg', text: '견적에 CPU나 그래픽카드가 없습니다. 계산기 탭에서 견적을 먼저 만들어 주세요.' }),
      el('div', { class: 'btnrow', style: 'justify-content:center;margin-top:8px' }, el('button', { class: 'btn sm', text: '계산기로 가기', onclick: () => { state.mode = 'build'; render(); } })));
  }
  // 계산기 탭의 한 줄 요약: 예상 소비 전력 · 권장 용량 · 담은 파워 판정 → 누르면 파워 계산 탭
  function renderPowerLine() {
    const rows = checkRows(), pc = PCC.psuCalc(rows, build.psu || {});
    if (!pc.ready) return null;
    const psuR = rows.find(r => r.it.cat === '파워서플라이');
    const pw = psuR ? PCC.psuWatt(psuR.it) : null;
    const t = PCC.psuTier(pc, pw), rc = pc.tiers[1];
    const judge = t ? { low: ['bad', '부족'], min: ['warnc', '여유 적음'], rec: ['good', '권장 이상'], sweet: ['good', '스윗스팟'] }[t] : null;
    return el('div', { class: 'sum pline1', title: '눌러서 파워 계산 탭 열기', onclick: () => { state.mode = 'power'; render(); } },
      el('span', {}, '파워 계산: 예상 ', el('b', { text: pc.load + 'W' }), ' · 권장 ', el('b', { text: rc.w + 'W' }),
        judge ? el('span', {}, ' · 담은 파워 ', el('b', { class: judge[0], text: `${pw}W ${judge[1]}` })) : ''),
      el('span', { class: 'plink', text: '자세히 →' }));
  }
  // 파워 계산기: 예상 최대 소비 전력 + 세 단계 용량(사용 가능·권장·스윗스팟) + 담은 파워 판정
  function renderPower() {
    const po = build.psu = build.psu || { fans: 0, hdd: 0, gpuMax: false };
    const rows = checkRows(), pc = PCC.psuCalc(rows, po);
    if (!pc.ready) return null;
    const psuR = rows.find(r => r.it.cat === '파워서플라이');
    const pw = psuR ? PCC.psuWatt(psuR.it) : null;
    const t = PCC.psuTier(pc, pw);
    const [mn, rc, sw] = pc.tiers;
    const box = el('div', { class: 'sum power' }, el('div', { class: 'sec', style: 'margin-top:0', text: '파워 계산' }));
    const det = el('details', {}, el('summary', {}, '예상 최대 소비 전력 ', el('b', { class: 'pload', text: pc.load + 'W' }), el('span', { class: 'muted', text: ' (부품별 내역)' })));
    pc.parts.forEach(([n, w, d]) => det.append(el('div', { class: 'pline' }, el('span', { text: n }), el('span', { class: 'muted', text: d }), el('b', { text: w + 'W' }))));
    box.append(det);
    const tile = (label, tr, extra) => el('div', { class: 'ptile' + (tr.key === 'rec' ? ' main' : '') },
      el('div', { class: 'pl', text: label }), el('div', { class: 'pv', text: tr.w + 'W' }), el('div', { class: 'pd', text: extra }));
    const v = rc.vendor;   // 그래픽카드 칩셋 제조사 공식 권장
    const recDesc = v ? (rc.raised ? `${v.maker} 권장 ${v.w}W보다 부하가 커서 올림` : `${v.maker} 공식 권장${v.est ? ' (추정)' : ''}`) : `+${rc.pct}% · 순간 피크까지`;
    const tiles = [tile('사용 가능', mn, `+${mn.pct}% · 여유 적음`)];
    if (pc.merged) tiles.push(tile('권장 · 스윗스팟', rc, `${v ? recDesc : '+' + rc.pct + '% 이상'} · 효율 최고 구간`));
    else tiles.push(tile('권장', rc, recDesc), tile('스윗스팟', sw, `+${sw.pct}% · 효율 최고 구간`));
    box.append(el('div', { class: 'ptiles', style: `grid-template-columns:repeat(${tiles.length},1fr)` }, tiles));
    if (v) box.append(el('div', { class: 'hint', text: `권장 용량은 ${v.maker}가 발표한 ${v.maker === 'NVIDIA' ? 'RTX ' + v.chip : v.chip} 권장 파워(${v.w}W)를 기준으로 합니다${v.est ? ' (공식 값을 찾지 못해 같은 전력대 기준으로 추정)' : ''}. 그래픽카드 제품마다(오버클럭 모델 등) 더 높게 권장하기도 하니 제품 페이지도 확인해 주세요.` }));
    if (pw) {
      const rate = Math.round(pc.load / pw * 100);
      const msg = { low: ['bad', `담은 파워 ${pw}W → 용량 부족 (사용 가능 ${mn.w}W 이상 필요)`], min: ['warnc', `담은 파워 ${pw}W → 사용 가능 (부하율 약 ${rate}%, 권장 ${rc.w}W보다 작음)`],
        rec: ['good', `담은 파워 ${pw}W → 권장 이상 (부하율 약 ${rate}%)`], sweet: ['good', `담은 파워 ${pw}W → 스윗스팟 (부하율 약 ${rate}%, 효율이 가장 좋은 구간)`] }[t];
      box.append(el('div', { class: 'pnow ' + msg[0], text: msg[1] }));
    }
    // 옵션: 추가 팬, HDD, 그래픽카드 최대 제한 전력
    const num = (key, min) => {
      const i = el('input', { type: 'number', step: '1', min: String(min), max: '20', value: String(po[key] || 0) });
      i.addEventListener('change', () => { po[key] = Math.max(min, Math.min(20, Math.round(Number(i.value) || 0))); saveBuild(); render(); });
      return i;
    };
    const caseR = rows.find(r => r.it.cat === '케이스');
    const caseFans = caseR ? ((spec(caseR.it, '기본 제공 팬').match(/\*\s*\d+/g) || []).reduce((a, x) => a + Number(x.replace(/\D/g, '')), 0)) : 0;
    const gChk = el('input', { type: 'checkbox' }); gChk.checked = !!po.gpuMax;
    gChk.addEventListener('change', () => { po.gpuMax = gChk.checked; saveBuild(); render(); });
    box.append(el('div', { class: 'popts' },
      el('label', {}, '추가 팬 ', num('fans', -caseFans), '개'),
      el('label', {}, 'HDD ', num('hdd', 0), '개'),
      el('label', {}, gChk, ' 그래픽카드 최대 제한 전력 기준')));
    box.append(el('div', { class: 'hint', text: `팬갈이를 하면 추가 팬 수 = 총 장착할 팬 개수 − 케이스 기본 팬 개수(${caseFans}개)로 넣어 주세요. 기본 팬을 떼면 음수도 됩니다.` }),
      el('div', { class: 'hint', text: '팬 미포함 수랭 쿨러는 라디에이터 크기만큼 팬을 단 기준(360 → 3개)으로 셉니다.' }));
    return box;
  }

  function renderCompat() {
    const res = PCC.checkBuild(checkRows(), { psu: build.psu });
    const box = el('div', { class: 'sum compat' }, el('div', { class: 'sec', style: 'margin-top:0', text: '호환성 검사' }));
    if (!res.length) { box.append(el('div', { class: 'hint', text: '검사할 수 있는 부품 조합이 아직 없습니다. (CPU·메인보드·케이스·파워 등을 담으면 검사합니다)' })); return box; }
    const item = x => el('div', { class: 'ci ' + x.level },
      el('span', { class: 'ic', text: x.level === 'bad' ? '✗' : x.level === 'warn' ? '!' : x.level === 'note' ? 'i' : '✓' }),
      el('div', {}, el('div', { class: 'ct', text: x.title }), x.detail ? el('div', { class: 'cd', text: x.detail }) : null));
    const bad = res.filter(x => x.level === 'bad' || x.level === 'warn'), notes = res.filter(x => x.level === 'note'), ok = res.filter(x => x.level === 'ok');
    bad.forEach(x => box.append(item(x)));
    if (!bad.length) box.append(el('div', { class: 'ci ok' }, el('span', { class: 'ic', text: '✓' }), el('div', { class: 'ct', text: '문제를 찾지 못했습니다.' })));
    notes.forEach(x => box.append(item(x)));   // 문제는 아니지만 알아 둘 것 (예: Y자 케이블 사용)
    if (ok.length) {
      const det = el('details', {}, el('summary', { text: `통과한 항목 ${ok.length}개` }));
      ok.forEach(x => det.append(item(x)));
      box.append(det);
    }
    box.append(el('div', { class: 'hint', style: 'margin-top:6px', text: '시트의 스펙으로 확인한 결과입니다.' }));
    return box;
  }

  function renderSum() {
    const parts = build.rows.reduce((s, r) => s + (rowPrice(r) || 0), 0);
    const asm = asmCalc(build);
    const total = parts + (asm ? asm.fee : 0);
    const missing = build.rows.filter(r => rowPrice(r) == null).length;
    const n = v => { const d = String(v || '').replace(/[^\d]/g, ''); return d ? Number(d) : 0; };
    const sale = n(build.sale), disc = n(build.discount), real = Math.max(0, sale - disc);
    const box = el('div', { class: 'sum' });
    const money = (key) => {
      const i = el('input', { inputmode: 'numeric', placeholder: '0', value: build[key] ? n(build[key]).toLocaleString('ko-KR') : '' });
      i.addEventListener('change', () => { build[key] = String(n(i.value)); saveBuild(); render(); });
      return i;
    };
    box.append(el('div', { class: asm ? 'line' : 'line big' }, el('span', { text: '부품 합계' }), el('span', { text: won(parts) })));
    // 조립비: 쿨러 종류로 자동 (싱글공랭·듀얼공랭·수랭), 금액은 눌러서 직접 바꿀 수 있음
    const asmChk = el('input', { type: 'checkbox' }); asmChk.checked = asmOn(build);
    asmChk.addEventListener('change', () => { build.asm = asmChk.checked; GM_setValue('pcc_asm_default', asmChk.checked); saveBuild(); render(); });
    const asmLine = el('div', { class: 'line' }, el('label', { class: 'asm' }, asmChk, ' ' + (asm ? asm.label : '조립비 포함')));
    if (asm) {
      const fi = el('input', { inputmode: 'numeric', value: asm.fee.toLocaleString('ko-KR'), title: '눌러서 금액 바꾸기 (비우면 기본 금액)' });
      fi.addEventListener('change', () => { const v = n(fi.value); build.asmCustom = !v || v === asm.base ? null : v; saveBuild(); render(); });
      asmLine.append(fi);
    }
    box.append(asmLine);
    if (asm) {
      const osChk = el('input', { type: 'checkbox' }); osChk.checked = !!build.asmOs;
      osChk.addEventListener('change', () => { build.asmOs = osChk.checked; saveBuild(); render(); });
      box.append(el('div', { class: 'line sub' }, el('label', { class: 'asm hint' }, osChk, ` OS 설치 포함 (+${won(ASM_DEF.os)})`), el('span', { class: 'hint', text: '컴퓨존 기준' })),
        el('div', { class: 'line big' }, el('span', { text: '합계 (조립비 포함)' }), el('span', { text: won(total) })));
    }
    if (missing) box.append(el('div', { class: 'hint bad', text: `판매 정보가 없는 부품 ${missing}개는 합계에서 빠졌습니다. 일시 품절이거나 단종된 제품일 수 있으니, 용량·색상 목록에서 판매 중인 옵션을 골라 비교해 보세요.` }));
    box.append(el('div', { class: 'line' }, el('span', { text: '완본체 판매가' }), money('sale')),
      el('div', { class: 'line' }, el('span', { text: '할인·적립 (상품권, 포인트 등)' }), money('discount')));
    if (sale) {
      const diff = total - real, rate = total ? diff / total * 100 : 0;
      box.append(el('div', { class: 'line' }, el('span', { text: '체감가' }), el('span', { text: won(real) })),
        el('div', { class: 'line big' }, el('span', { text: (asm ? '부품+조립비보다 ' : '부품 합계보다 ') + (diff >= 0 ? '저렴' : '비쌈') }),
          el('span', { class: diff >= 0 ? 'good' : 'bad', text: won(Math.abs(diff)) + ` (${Math.abs(rate).toFixed(1)}%)` })));
    }
    box.append(el('div', { class: 'hint', style: 'margin-top:6px', text: '부품 합계는 다나와 최저가 기준입니다. 조립비는 시트 계산기와 같은 컴퓨존 기준(싱글공랭 3.5만, 듀얼공랭 4만, 수랭 4.5만, OS 설치 +1만)이며 쿨러 종류로 자동으로 정합니다.' }));
    return box;
  }

  function renderDetail(it) {
    const d = el('div', { class: 'detail' },
      el('div', { class: 'btnrow', style: 'justify-content:space-between;align-items:center' },
        el('button', { class: 'back', 'data-act': 'back', text: '← 돌아가기' }),
        el('span', {}, el('button', { class: 'btn ghost sm', text: inPartCmp(it) ? '비교에서 빼기' : '비교에 담기', onclick: e => { togglePartCmp(it); e.target.textContent = inPartCmp(it) ? '비교에서 빼기' : '비교에 담기'; showToast(inPartCmp(it) ? `부품 비교에 담았습니다 (${loadPartCmp().length}개)` : '부품 비교에서 뺐습니다.', 1500); } }), ' ',
          el('button', { class: 'btn sm', text: '견적에 담기', onclick: () => addToBuild(it) }))),
      el('div', {}, el('span', { class: 'cat', text: it.cat })), el('h2', { text: it.name }));
    d.append(el('div', { class: 'sec', text: '최저가' }));
    if (!it.prices.length) d.append(el('div', { class: 'msg', text: '현재 판매 가격 정보가 없습니다.' }));
    else if (it.cat === 'RAM') {
      const t = el('table', { class: 'prices' }, el('tr', {}, el('th', { text: '용량' }), el('th', { class: 'num', text: '제품 최저가' }), el('th', { class: 'num', text: '동일스펙 최저가' })));
      const want = capFilter();
      it.prices.forEach(p => {
        const pc = el('td', { class: 'num', text: won(p.price) });
        const sc = el('td', { class: 'num', text: won(p.sameSpec) });
        const n = sameFromEl(p); if (n) sc.append(el('div', {}, n));
        // 용량 칸: 패키지는 구성(16GB×2), 용량별 M다이·이슈, 그 용량 다나와 검색 링크
        const gb = Number((String(p.opt).match(/(\d+)\s*GB/i) || [])[1] || 0);
        const oc = el('td', {}, el('div', { text: p.opt + (PCC.isPkg(it) && gb ? ` (${gb / PCC.sticksFor(it, p.opt)}GB×${PCC.sticksFor(it, p.opt)})` : '') }));
        const cv = PCC.ramCapView(it, p.opt);
        if (cv['다이 종류'] === 'M다이') oc.append(el('div', { class: 'hint', text: 'M다이' }));
        for (const m of spec(it, '이슈 태그').matchAll(/([^,]+?)\s*\((\d+)GB 모델만\)/g)) if (Number(m[2]) === gb) oc.append(el('div', { class: 'hint', text: m[1].trim() }));
        oc.append(el('a', { class: 'samefrom', href: 'https://search.danawa.com/dsearch.php?query=' + encodeURIComponent(it.name + ' ' + p.opt), target: '_blank', rel: 'noopener noreferrer', text: '다나와 검색' }));
        t.append(el('tr', { style: want && want === String(p.opt).replace(/\s/g, '').toUpperCase() ? 'background:rgba(255,200,0,.12)' : null }, oc, pc, sc));
      });
      d.append(t, el('div', { class: 'hint', style: 'padding:6px 0', text: PCC.isPkg(it) ? '1세트 기준 가격입니다. (용량 옆 괄호가 세트 구성)' : '1개 기준 가격입니다.' }));
    } else {
      const t = el('table', { class: 'prices' });
      it.prices.forEach(p => t.append(el('tr', {}, el('th', { text: p.opt || (it.prices.length === 1 ? '가격' : optLabel(it.cat)) }), el('td', { class: 'num', text: won(p.price) }))));
      d.append(t);
    }
    if (it.perf || it.rec) d.append(el('div', { class: 'sec', text: '점수 (10점 만점)' }), el('div', { class: 'scores' },
      el('div', { class: 'score' }, '성능', el('b', { text: it.perf || '-' })), el('div', { class: 'score' }, '추천', el('b', { text: it.rec || '-' }))));
    // 평가·스펙은 비어 있거나 '없음'이어도 항목을 모두 보여줌 (어떤 항목이 빠졌는지 보이게)
    const evals = [['이슈', it.issue], ['가점 요소', it.plus], ['감점 요소', it.minus]];
    { d.append(el('div', { class: 'sec', text: '평가' })); const t = el('table', {}); evals.forEach(([k, v]) => t.append(el('tr', {}, el('th', { text: k }), el('td', { text: v || '없음' })))); d.append(t); }
    if (it.note) d.append(el('div', { class: 'sec', text: '주의사항' }), el('div', { class: 'note', text: it.note }));
    const allSpecs = it.allSpecs || it.specs;
    if (allSpecs.length) {
      d.append(el('div', { class: 'sec', text: '스펙' })); const t = el('table', {}); let prev = '';
      allSpecs.forEach(([k, v]) => {
        const label = /^[AC]$/.test(k) ? `${/전면/.test(prev) ? '전면' : '후면'} USB ${k}타입` : k;   // A·C 열 이름을 알아보기 쉽게
        if (!/^[AC]$/.test(k)) prev = k;
        t.append(el('tr', {}, el('th', { text: label }), el('td', { text: v || '-' })));
      });
      d.append(t);
    }
    if (it.cat === 'RAM' && spec(it, '다이')) d.append(el('div', { class: 'hint', style: 'padding:6px 0', text: '다이 정보는 유통사·제조사 공지나 수율을 보고 판단한 값이라 실제 제품과 다를 수 있습니다.' }));
    const capQ = it.cat === 'RAM' ? capFilter() : '';
    if (capQ) d.append(el('a', { class: 'link', href: 'https://search.danawa.com/dsearch.php?query=' + encodeURIComponent(it.name + ' ' + capQ), target: '_blank', rel: 'noopener noreferrer', text: `다나와에서 ${capQ} 검색` }));
    else if (/^https:\/\//.test(it.link)) d.append(el('a', { class: 'link', href: it.link, target: '_blank', rel: 'noopener noreferrer', text: '다나와에서 보기' }));
    return d;
  }

  (document.body || document.documentElement).append(host);
  applyFab();
  if (HAS_MENU) {
    GM_registerMenuCommand('부품 계산기 열기/닫기', togglePanel);
    GM_registerMenuCommand('단축키 바꾸기', () => { capturing = true; showToast('원하는 단축키를 누르세요. 지금: ' + comboText(getShortcut()) + ' (취소: Esc)'); });
    GM_registerMenuCommand('데이터 새로고침', () => { openPanel(); loadData(true); });
    GM_registerMenuCommand('화면 버튼 보이기/숨기기', () => { GM_setValue(FAB_KEY, !GM_getValue(FAB_KEY, fabDefault())); applyFab(); });
    GM_registerMenuCommand('화면 버튼 위치 초기화', () => { GM_setValue(FABPOS_KEY, null); placeFab(); });
  }
})();
