#!/usr/bin/env node
/**
 * 기업마당(bizinfo.go.kr) 지원사업 공고 수집기
 * ─────────────────────────────────────────────────────────────
 * API 응답을 index-b.html 의 PROGRAMS 스키마로 정규화해
 * data/programs-initial.json (첫 로드용 마감임박 N건) 과
 * data/programs-full.json (지연 로딩용 전체) 두 파일로 저장합니다.
 *
 * 사용법
 *   1) 인증키 설정 — 아래 셋 중 하나 (위쪽이 우선)
 *        a. 실행 인자        :  node scripts/fetch-bizinfo.mjs --key 발급받은키
 *        b. 세션 환경변수    :  $env:BIZINFO_KEY = "키"   (PowerShell)
 *                               export BIZINFO_KEY="키"    (bash)
 *        c. .env 파일 (권장) :  프로젝트 루트에 .env 생성 후
 *                               BIZINFO_KEY=발급받은키
 *
 *      ※ 인증키를 index-b.html 등 공개 파일에 절대 넣지 마세요.
 *        .env 는 .gitignore 에 포함되어 저장소에 올라가지 않습니다.
 *
 *   2) 응답 구조 먼저 확인 (최초 1회 권장)
 *        node scripts/fetch-bizinfo.mjs --probe
 *
 *   3) 수집 실행
 *        node scripts/fetch-bizinfo.mjs
 *        node scripts/fetch-bizinfo.mjs --field 01 --count 200
 *        node scripts/fetch-bizinfo.mjs --keep-expired      (마감건도 포함)
 *        node scripts/fetch-bizinfo.mjs --split 150         (첫 로드 건수 조정, 기본 100)
 *
 * Node 18+ (전역 fetch 필요). 외부 패키지 의존성 없음.
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT      = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_INIT  = resolve(ROOT, 'data/programs-initial.json');  // 첫 로드용 (마감임박 N건)
const OUT_FULL  = resolve(ROOT, 'data/programs-full.json');     // 지연 로딩용 (전체)
const ENV_PATH  = resolve(ROOT, '.env');
const ENDPOINT = 'https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do';

/* ── .env 로더 (외부 패키지 없이) ─────────────────────────────
   프로젝트 루트의 .env 파일에서 KEY=VALUE 를 읽어 환경변수로 넣습니다.
   이미 설정된 환경변수가 있으면 그쪽이 우선합니다.           */
function loadDotenv(path) {
  if (!existsSync(path)) return false;
  let loaded = false;
  for (let line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) { process.env[k] = v; loaded = true; }
  }
  return loaded;
}
const ENV_LOADED = loadDotenv(ENV_PATH);

/* ── 인자 파싱 ───────────────────────────────────────────── */
const argv  = process.argv.slice(2);
const has   = f => argv.includes(f);
const arg   = (f, d) => { const i = argv.indexOf(f); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };

/* 우선순위: --key 인자 > 터미널 환경변수 > .env 파일 */
const KEY          = arg('--key', '') || process.env.BIZINFO_KEY || '';
const PROBE        = has('--probe');
const KEEP_EXPIRED = has('--keep-expired');
const COUNT        = arg('--count', '0');   // 0 = 전체 (기업마당 사양)
const FIELD        = arg('--field', '');          // 01~07, 09 (미지정 시 전체)
const DRY_FILE     = arg('--dry-file', '');       // 저장해 둔 응답 JSON으로 매핑만 검증
const FULL         = has('--full');                // 본문을 자르지 않고 원문 길이 그대로 보관

if (!KEY && !DRY_FILE) {
  console.error('\n✗ 인증키(BIZINFO_KEY)를 찾지 못했습니다.\n');
  console.error('  [방법 1 · 권장] 프로젝트 루트에 .env 파일을 만들고 아래 한 줄을 넣으세요');
  console.error('      BIZINFO_KEY=발급받은키');
  console.error(`      경로: ${ENV_PATH}`);
  console.error(existsSync(ENV_PATH)
    ? '      → .env 파일은 있지만 BIZINFO_KEY 항목이 없거나 비어 있습니다.'
    : '      → 현재 .env 파일이 없습니다.');
  console.error('\n  [방법 2] 이번 실행에만 적용');
  console.error('      node scripts/fetch-bizinfo.mjs --key 발급받은키');
  console.error('\n  [방법 3] 터미널 세션 환경변수');
  console.error('      PowerShell : $env:BIZINFO_KEY = "발급받은키"');
  console.error('      bash       : export BIZINFO_KEY="발급받은키"\n');
  process.exit(1);
}
if (ENV_LOADED && !arg('--key', '')) console.log('· .env 에서 인증키를 읽었습니다.');

/* ── 기업마당 지원분야 코드 ──────────────────────────────── */
const FIELD_CODES = {
  '01': '금융', '02': '기술', '03': '인력', '04': '수출',
  '05': '내수', '06': '창업', '07': '경영', '09': '기타'
};
const FIELD_NAMES = new Set(Object.values(FIELD_CODES));

const REGIONS = ['서울','부산','대구','인천','광주','대전','울산','세종',
                 '경기','강원','충북','충남','전북','전남','경북','경남','제주'];

/* 업종 추정용 키워드 — trgetNm / bsnsSumryCn 텍스트에서 매칭 */
const INDUSTRY_HINTS = {
  '제조업'        : ['제조', '공장', '생산', '설비', '가공', '뿌리기업'],
  '도소매업'      : ['도소매', '유통', '판매업', '소매', '도매'],
  '음식·숙박업'   : ['음식', '외식', '숙박', '관광', 'food', '카페'],
  '서비스업'      : ['서비스업', '용역', '컨설팅'],
  '건설업'        : ['건설', '건축', '토목', '시공'],
  'IT·소프트웨어' : ['소프트웨어', 'ICT', 'IT', '앱', '플랫폼', '디지털', 'AI', '인공지능', 'SW'],
  '운수업'        : ['운수', '물류', '운송', '화물']
};

/* 업력 추정 — "N년 미만/이내"는 그 이하 구간, "N년 이상"은 그 이상 구간을 켭니다 */
const ALL_YEARS = ['pre', 'y0_1', 'y1_3', 'y3_7', 'y7'];
function extractYearsFrom(blob) {
  const on = new Set();
  const add = (...cs) => cs.forEach(c => on.add(c));

  if (/예비\s*창업|창업\s*예정/.test(blob))            add('pre');
  if (/1년\s*(미만|이내)/.test(blob))                  add('pre', 'y0_1');
  if (/3년\s*(미만|이내)/.test(blob))                  add('pre', 'y0_1', 'y1_3');
  if (/(5|7)년\s*(미만|이내)/.test(blob))              add('pre', 'y0_1', 'y1_3', 'y3_7');
  if (/1년\s*이상/.test(blob))                         add('y1_3', 'y3_7', 'y7');
  if (/3년\s*이상/.test(blob))                         add('y3_7', 'y7');
  if (/(5|7)년\s*이상/.test(blob))                     add('y7');
  if (/재창업|재도전/.test(blob))                      add('pre', 'y0_1', 'y1_3');

  return on.size ? ALL_YEARS.filter(y => on.has(y)) : [...ALL_YEARS];
}

/* ── 유틸 ────────────────────────────────────────────────── */
const clean = s => String(s ?? '')
  .replace(/<[^>]*>/g, ' ')            // 태그 제거
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] != null && o[k] !== '') return o[k]; return ''; };

/**
 * 신청기간 파싱.
 * 실측 결과 전체의 60%가 날짜가 아닌 문자열입니다.
 *   "예산 소진시까지"(627) "상시 접수"(135) "선착순 접수"(37) "모집 완료시"(34) → rolling
 *   "세부사업별 상이"(23) "차수별 상이"(7) "추후 공지"(7)                      → unknown
 * 둘을 구분해야 UI에서 "상시 접수"와 "공고 확인 필요"를 다르게 표시할 수 있습니다.
 * 어느 쪽이든 dday 는 null 입니다 — 가짜 D-day 를 만들지 않습니다.
 */
function parsePeriod(raw) {
  const s = clean(raw);
  if (!s) return { begin: null, end: null, type: 'unknown', raw: '' };

  const ds = s.match(/\d{4}[.\-/]?\d{2}[.\-/]?\d{2}/g) || [];
  const toDate = t => {
    if (!t) return null;
    const n = String(t).replace(/\D/g, '');
    if (n.length !== 8) return null;
    const mo = +n.slice(4, 6), dy = +n.slice(6, 8);
    if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
    const d = new Date(+n.slice(0, 4), mo - 1, dy);
    return isNaN(d) ? null : d;
  };
  const begin = toDate(ds[0]);
  const end   = toDate(ds[1]) || begin;
  if (begin || end) return { begin, end, type: 'fixed', raw: s };

  if (/상시|수시|연중|예산\s*소진|선착순|모집\s*(완료|마감)|소진\s*시/.test(s))
    return { begin: null, end: null, type: 'rolling', raw: s };

  return { begin: null, end: null, type: 'unknown', raw: s };
}

/** trgetNm 은 업종이 아니라 '기업 유형'입니다 (중소기업 1177 / 소상공인 213 / 창업벤처 91 …) */
const TARGET_TYPES = ['중소기업', '소상공인', '창업벤처', '사회적기업', '여성기업', '장애인기업', '협동조합', '마을기업'];

/**
 * 기업 유형 추출.
 * trgetNm 이 "중소기업" 하나로만 등록돼 있어도 제목에 대상이 명시된 공고가 많습니다.
 *   예) trgetNm="중소기업" / 제목="[대전] 서구 2026년 소상공인 경영안정자금 지원사업 공고"
 * 그래서 제목까지 함께 봅니다. 본문(bsnsSumryCn)은 보지 않습니다 —
 * 실측 결과 본문 매칭은 46건 중 대부분이 오탐이었습니다
 * (중소기업 대상 공모전·기획전 설명에 소상공인이 스쳐 언급되는 경우).
 */
function normTargetType(trgetNm, title) {
  const src   = clean(trgetNm);
  const head  = clean(title);
  const found = new Set();

  TARGET_TYPES.forEach(x => { if (src.includes(x)) found.add(x); });
  // 제목에 명시된 경우만 보강 (신뢰도 높은 매칭)
  TARGET_TYPES.forEach(x => { if (head.includes(x)) found.add(x); });
  // 소공인은 소상공인의 한 갈래(제조업 소상공인)입니다
  if (/소공인/.test(src + head)) found.add('소상공인');

  if (found.size) return TARGET_TYPES.filter(t => found.has(t));
  return src ? [src] : ['기타'];
}

/** 날짜 차이를 '일' 단위로 — 시각/시간대 영향을 받지 않도록 자정 기준으로 계산 */
function daysLeft(end) {
  if (!end) return null;
  const n = new Date(); const today = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  const e = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((e - today) / 86400000);
}

/** toISOString() 은 UTC로 바뀌며 하루 밀리므로 로컬 기준으로 직접 포맷 */
function ymd(d) {
  if (!d) return null;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 공고 링크가 상대경로로 오는 경우가 있어 절대 URL로 보정 */
function absUrl(u) {
  const s = clean(u);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return 'https://www.bizinfo.go.kr' + (s.startsWith('/') ? s : '/' + s);
}

function normField(name) {
  const s = clean(name);
  for (const f of FIELD_NAMES) if (s.includes(f)) return f;
  if (/자금|융자|보증|금융/.test(s)) return '금융';
  if (/R&D|기술|연구/.test(s))      return '기술';
  if (/고용|인력|채용/.test(s))     return '인력';
  if (/수출|해외|글로벌/.test(s))   return '수출';
  if (/판로|내수|유통/.test(s))     return '내수';
  if (/창업/.test(s))               return '창업';
  if (/경영|컨설팅|진단/.test(s))   return '경영';
  return '기타';
}

/**
 * 지역 추출.
 * hashtags 에 전 지역명을 나열한 공고가 많아(실측 452건이 17개 지역 전부 매칭)
 * 일정 개수를 넘으면 사실상 전국 사업으로 봅니다.
 */
function extractRegions(...texts) {
  const blob = texts.map(clean).join(' ');
  if (/전국/.test(blob)) return ['전국'];
  const hit = REGIONS.filter(r => blob.includes(r));
  if (hit.length === 0 || hit.length >= 8) return ['전국'];
  return hit;
}

function extractIndustries(...texts) {
  const blob = texts.map(clean).join(' ');
  const hit = Object.entries(INDUSTRY_HINTS)
    .filter(([, kws]) => kws.some(k => blob.toLowerCase().includes(k.toLowerCase())))
    .map(([name]) => name);
  return hit.length ? hit : Object.keys(INDUSTRY_HINTS).concat('기타');  // 단서 없으면 전 업종
}

function extractYears(...texts) {
  return extractYearsFrom(texts.map(clean).join(' '));
}

/* ── API 호출 ────────────────────────────────────────────── */
async function callApi() {
  if (DRY_FILE) {
    console.log('→ 로컬 파일 모드:', DRY_FILE);
    return JSON.parse(await readFile(resolve(ROOT, DRY_FILE), 'utf8'));
  }
  const qs = new URLSearchParams({ crtfcKey: KEY, dataType: 'json', searchCnt: COUNT });
  if (FIELD) qs.set('searchLclasId', FIELD);

  const url = `${ENDPOINT}?${qs}`;
  console.log('→ 요청:', url.replace(KEY, '***'));

  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const text = await res.json().catch(async () => JSON.parse(await res.text()));
  if (text?.reqErr) throw new Error(`API 오류: ${text.reqErr}`);
  return text;
}

/** 응답 봉투(envelope)가 문서와 다를 수 있어 방어적으로 배열을 찾습니다 */
function extractItems(payload) {
  const candidates = [
    payload?.jsonArray,
    payload?.items,
    payload?.item,
    payload?.response?.body?.items,
    payload?.response?.body?.items?.item,
    payload?.rss?.channel?.item,
    payload?.channel?.item,
    payload?.data,
    payload
  ];
  for (const c of candidates) if (Array.isArray(c) && c.length) return c;
  // 객체 안에서 첫 번째 배열을 탐색
  if (payload && typeof payload === 'object') {
    for (const v of Object.values(payload)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
      if (v && typeof v === 'object') { const inner = extractItems(v); if (inner.length) return inner; }
    }
  }
  return [];
}

/* ── 정규화 ──────────────────────────────────────────────── */
function normalize(raw, idx) {
  const title = clean(pick(raw, 'pblancNm', 'title', 'bsnsNm'));
  if (!title) return null;

  const summary = clean(pick(raw, 'bsnsSumryCn', 'description', 'cn'));
  const target  = clean(pick(raw, 'trgetNm', 'trget'));
  const tags    = clean(pick(raw, 'hashTags', 'hashtags'));
  const period  = parsePeriod(pick(raw, 'reqstBeginEndDe', 'reqstBeginDe', 'pubDate'));
  const dd      = period.type === 'fixed' ? daysLeft(period.end) : null;   // 가짜 D-day 금지

  const views = parseInt(clean(pick(raw, 'inqireCo')), 10) || 0;

  /* 랜딩페이지가 통째로 내려받는 파일이라 용량이 곧 로딩 속도입니다.
     상세 전문은 url(공고 원문)로 보내고, 여기서는 카드·모달에 필요한 만큼만 담습니다.
     --full 을 주면 원문 길이 그대로 보관합니다. */
  const cut = (s, n) => {
    const t = clean(s);
    return !FULL && t.length > n ? t.slice(0, n).replace(/[\s,.·]+$/, '') + '…' : t;
  };

  /* 단서가 없어 전 업종/전 업력으로 열린 경우는 null 로 — 배열을 통째로 싣지 않습니다 */
  const ind = extractIndustries(target, summary, title);
  const yrs = extractYears(target, summary, title);

  return {
    id       : clean(pick(raw, 'pblancId', 'guid')) || `bz${String(idx).padStart(4, '0')}`,
    field    : normField(pick(raw, 'pldirSportRealmLclasCodeNm', 'category', 'lclasNm')),
    subField : clean(pick(raw, 'pldirSportRealmMlsfcCodeNm')),   // 중분류: 시설/입지지원 등
    title,
    org      : clean(pick(raw, 'excInsttNm', 'jrsdInsttNm', 'author')) || '기관 미상',
    ministry : clean(pick(raw, 'jrsdInsttNm')),
    region   : extractRegions(tags, target, title),
    targetType: normTargetType(target, title),   // 중소기업 / 소상공인 / 창업벤처 …  (trgetNm + 제목)
    industry : ind.length >= 8 ? null : ind,     // null = 단서 없음(전 업종). 키워드 추정이라 오탐 가능
    years    : yrs.length >= 5 ? null : yrs,     // null = 단서 없음. 추정률 10% 미만 — 하드 필터 금지
    dday     : dd,                               // fixed 일 때만 숫자, 그 외 null
    deadline : period.type,                      // fixed | rolling | unknown
    period   : period.raw,
    endDate  : ymd(period.end),
    desc     : cut(summary, 180) || '자세한 내용은 공고 원문을 확인해 주세요.',
    url      : absUrl(pick(raw, 'pblancUrl', 'link')),
    target,
    applyHow : cut(pick(raw, 'reqstMthPapersCn'), 120),   // 신청 방법·제출 서류
    contact  : cut(pick(raw, 'refrncNm'), 80),            // 소관 기관 문의처
    views,                                               // 조회수 (인기공고 배지 근거)
    updatedAt: clean(pick(raw, 'updtPnttm', 'creatPnttm')).slice(0, 10)
  };
}

/* ── 실행 ────────────────────────────────────────────────── */
(async () => {
  try {
    const payload = await callApi();

    if (PROBE) {
      const items = extractItems(payload);
      console.log('\n─── 응답 최상위 키 ───');
      console.log(Object.keys(payload || {}));
      console.log(`\n─── 배열 길이: ${items.length} ───`);
      if (items[0]) {
        console.log('\n─── 첫 번째 레코드 필드 ───');
        for (const [k, v] of Object.entries(items[0])) {
          console.log(`  ${k.padEnd(34)} : ${String(v).slice(0, 70)}`);
        }
      } else {
        console.log('\n배열을 찾지 못했습니다. 원본 일부:');
        console.log(JSON.stringify(payload).slice(0, 1200));
      }
      console.log('\n※ 위 필드명이 normalize() 의 pick() 목록과 다르면 스크립트를 맞춰 수정하세요.\n');
      return;
    }

    const items = extractItems(payload);
    if (!items.length) {
      console.error('✗ 공고 배열을 찾지 못했습니다. --probe 로 응답 구조를 먼저 확인하세요.');
      process.exit(1);
    }

    let list = items.map(normalize).filter(Boolean);
    const before = list.length;

    if (!KEEP_EXPIRED) list = list.filter(p => p.dday == null || p.dday >= 0);

    // 중복 제거 (동일 id 또는 동일 제목)
    const seen = new Set();
    list = list.filter(p => { const k = p.id || p.title; if (seen.has(k)) return false; seen.add(k); return true; });

    // 날짜 확정 공고를 마감 임박순으로 앞에, 상시·미상은 뒤로
    list.sort((a, b) => (a.dday ?? 99999) - (b.dday ?? 99999) || b.views - a.views);

    /* ── 2분할 저장 ──────────────────────────────────────────
       첫 화면은 마감임박 N건만 받아 즉시 렌더하고,
       전체는 뒤에서 지연 로딩합니다. (페이지의 loadInitial/loadFull 와 짝)
       initial 은 full 의 부분집합이며, 페이지가 id 로 중복을 제거합니다. */
    const SPLIT   = Math.max(1, parseInt(arg('--split', '100'), 10) || 100);
    const initial = list.slice(0, SPLIT);

    const meta = {
      generatedAt : new Date().toISOString(),
      source      : '기업마당(bizinfo.go.kr) 공공데이터 오픈API',
      notice      : '신청 자격·기간·요건은 각 사업의 소관 기관 공식 공고를 기준으로 합니다.',
      total       : list.length
    };
    const stringify = o => has('--pretty') ? JSON.stringify(o, null, 2) : JSON.stringify(o);
    const jsonInit  = stringify({ ...meta, part: 'initial', count: initial.length, programs: initial });
    const jsonFull  = stringify({ ...meta, part: 'full',    count: list.length,    programs: list });

    await mkdir(dirname(OUT_FULL), { recursive: true });
    await writeFile(OUT_INIT, jsonInit, 'utf8');
    await writeFile(OUT_FULL, jsonFull, 'utf8');

    const byField = list.reduce((a, p) => (a[p.field] = (a[p.field] || 0) + 1, a), {});
    const cnt = f => list.filter(f).length;
    const zlib = await import('node:zlib');
    const kb   = s => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(0) + 'KB';
    const gzkb = s => (zlib.gzipSync(Buffer.from(s)).length / 1024).toFixed(0) + 'KB';

    console.log(`\n✓ 수집 ${before}건 → 저장 ${list.length}건 (마감 제외 ${before - list.length}건)`);
    console.log(`  분야별: ${Object.entries(byField).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    console.log(`  마감유형: 날짜확정 ${cnt(p => p.deadline === 'fixed')} · 상시 ${cnt(p => p.deadline === 'rolling')} · 미상 ${cnt(p => p.deadline === 'unknown')}`);
    console.log(`  마감임박(D-7 이내): ${cnt(p => p.dday != null && p.dday <= 7)}건`);
    console.log(`  지역: 전국 ${cnt(p => p.region.includes('전국'))} · 특정지역 ${cnt(p => !p.region.includes('전국'))}`);
    const noUrl = cnt(p => !p.url);
    if (noUrl) console.log(`  ⚠ 원문 링크 없음: ${noUrl}건`);

    console.log('');
    console.log(`  ① ${OUT_INIT}`);
    console.log(`     첫 로드 ${initial.length}건 · ${kb(jsonInit)} (gzip ${gzkb(jsonInit)})`);
    console.log(`  ② ${OUT_FULL}`);
    console.log(`     지연 로딩 ${list.length}건 · ${kb(jsonFull)} (gzip ${gzkb(jsonFull)})`);
    console.log('');
  } catch (e) {
    console.error('\n✗ 실패:', e.message);
    if (/인증키/.test(e.message)) {
      console.error('  → 기업마당에서 발급받은 키가 맞는지, 앞뒤 공백이나 따옴표가 섞이지 않았는지 확인하세요.');
      console.error(`  → .env 를 쓰신다면: ${ENV_PATH}`);
    } else {
      console.error('  → 네트워크 연결과 API 점검 여부를 확인하세요.');
    }
    console.error('');
    // process.exit() 를 즉시 호출하면 진행 중인 소켓 정리와 충돌해
    // Windows에서 libuv 어서션이 출력됩니다. 종료 코드만 지정하고 자연 종료시킵니다.
    process.exitCode = 1;
  }
})();
