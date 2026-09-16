/**
 * 기업마당 API 중계 (Cloudflare Workers)
 * ─────────────────────────────────────────────────────────────
 * 인증키를 서버에만 두고 브라우저에는 노출하지 않기 위한 중계입니다.
 * 페이지(index-b.html)의 CONFIG.live 를 아래처럼 설정하면 연결됩니다.
 *
 *   live: {
 *     enabled : true,
 *     mode    : 'proxy',
 *     endpoint: 'https://<워커이름>.<계정>.workers.dev/programs'
 *   }
 *
 * 응답은 기업마당 원본({ jsonArray: [...] })을 그대로 전달합니다.
 * 페이지의 RAW.list() 가 정규화하므로 여기서 가공할 필요가 없습니다.
 *
 * ── 배포 방법 (5분) ──────────────────────────────────────────
 *   1) npm i -g wrangler && wrangler login
 *   2) wrangler init bizinfo-proxy   → 생성된 src/index.js 를 이 파일로 교체
 *   3) wrangler secret put BIZINFO_KEY      (발급받은 키 입력)
 *   4) wrangler deploy
 *   5) 출력된 주소 + '/programs' 를 CONFIG.live.endpoint 에 넣기
 *
 * ★ ALLOWED_ORIGINS 를 실제 도메인으로 반드시 바꾸세요.
 *   (안 바꾸면 누구나 이 중계를 통해 키를 대신 써버릴 수 있습니다)
 */

const ALLOWED_ORIGINS = [
  'https://example.com',            // ← 실제 서비스 도메인으로 교체
  'https://www.example.com',
  'http://localhost:5177'           // 로컬 확인용 (운영 배포 시 삭제 권장)
];

const UPSTREAM = 'https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do';
const CACHE_SECONDS = 600;          // 10분 — 정부 서버 부하와 응답 속도의 절충

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allow  = ALLOWED_ORIGINS.includes(origin) ? origin : '';

    const cors = {
      'Access-Control-Allow-Origin': allow || 'null',
      'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' }
      });
    }
    if (request.method !== 'GET')   return json({ error: 'GET only' }, 405, cors);
    if (url.pathname !== '/programs') return json({ error: 'Not found' }, 404, cors);
    if (!allow)                     return json({ error: 'Origin not allowed' }, 403, cors);
    if (!env.BIZINFO_KEY)           return json({ error: 'BIZINFO_KEY secret is not set' }, 500, cors);

    /* 클라이언트가 넘긴 값 중 안전한 것만 통과시킵니다 (키 주입 차단) */
    const up = new URL(UPSTREAM);
    up.searchParams.set('crtfcKey', env.BIZINFO_KEY);
    up.searchParams.set('dataType', 'json');
    up.searchParams.set('searchCnt', clampInt(url.searchParams.get('count'), 0, 2000, 500));
    const field = url.searchParams.get('field');
    if (field && /^0[1-7]$|^09$/.test(field)) up.searchParams.set('searchLclasId', field);

    /* 엣지 캐시 — 같은 조건이면 정부 서버를 다시 때리지 않습니다 */
    const cacheKey = new Request(up.toString(), { method: 'GET' });
    const cache    = caches.default;
    let res = await cache.match(cacheKey);

    if (!res) {
      const upstream = await fetch(up.toString(), { headers: { Accept: 'application/json' } });
      if (!upstream.ok) return json({ error: 'upstream ' + upstream.status }, 502, cors);

      const body = await upstream.text();
      if (/reqErr/.test(body)) return json({ error: '인증키 오류 또는 API 거부' }, 502, cors);

      res = new Response(body, {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` }
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }

    const out = new Response(res.body, res);
    Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
    return out;
  }
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors }
  });
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  return String(Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt);
}
