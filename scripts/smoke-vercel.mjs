// 웹 화면만 Vercel에 올린 시연의 연기 시험(10/30 Vercel 배포 회의). Vercel 배포 뒤에 읽기만으로 확인해요.
// 로그인·쓰기는 하지 않고, 쿠키·토큰 값은 찍지 않아요. 시연 서버 쪽은 SMOKE_API_ONLY=1 node scripts/smoke.mjs <서버 주소>예요.
//   SMOKE_BUILD=<커밋 전체 SHA> node scripts/smoke-vercel.mjs https://<Vercel 주소>
import { HTML_CSP } from '../packages/shared/src/web-headers.ts';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base.startsWith('https://')) {
  console.log('✗ Vercel 주소(https://…)를 넣어 주세요');
  process.exit(1);
}
const failures = [];
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failures.push(name);
};
const get = (path, headers = {}) => fetch(`${base}${path}`, { headers, redirect: 'manual' });
const isHtml = (res) => (res.headers.get('content-type') ?? '').includes('text/html');
const isJson = (res) => (res.headers.get('content-type') ?? '').includes('application/json');

const home = await get('/');
const html = await home.text();
check('/ 는 HTML 200', home.status === 200 && isHtml(home));
check('/ 는 저장하지 않아요(no-store)', home.headers.get('cache-control') === 'no-store');
check('/ CSP가 운영 값과 같아요', home.headers.get('content-security-policy') === HTML_CSP);
check('/ 틀(iframe)에 넣지 못해요', home.headers.get('x-frame-options') === 'DENY');
check('/ 형식 추측·주소 넘김을 막아요', home.headers.get('x-content-type-options') === 'nosniff' && home.headers.get('referrer-policy') === 'no-referrer');
check('/ 검색에 잡히지 않아요(noindex)', (home.headers.get('x-robots-tag') ?? '').includes('noindex'));

for (const path of ['/oauth/consent', '/r/smoke-token']) {
  const res = await get(path);
  check(`${path} 는 화면(HTML)이고 저장하지 않아요`, res.status === 200 && isHtml(res) && res.headers.get('cache-control') === 'no-store');
}

const script = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
check('index.html이 /assets의 JS를 불러요', Boolean(script));
if (script) {
  const js = await get(script);
  check('JS는 1년 동안 그대로 둬요(immutable)', js.status === 200 && (js.headers.get('cache-control') ?? '').includes('immutable'));
}
const missing = await get('/assets/smoke-missing.js');
check('없는 /assets 파일은 404예요(화면으로 대신 답하지 않아요)', missing.status === 404);
const page = await get('/smoke-no-such-page');
check('화면 주소가 아니면 404예요', page.status === 404);

// /api는 Vercel이 시연 서버로 넘겨요. 서버가 답했는지는 판 머리와 JSON으로 봐요.
const config = await get('/api/config/public');
check('/api/config/public 이 시연 서버에서 JSON으로 와요', config.status === 200 && isJson(config));
const build = config.headers.get('x-desk-build');
check('응답에 서버 판(x-desk-build)이 있어요', Boolean(build));
if (process.env.SMOKE_BUILD) check(`서버 판이 ${process.env.SMOKE_BUILD}이에요(웹과 같은 커밋)`, build === process.env.SMOKE_BUILD);
if (config.ok) check('시연 비밀번호를 받아요', (await config.json()).login?.password === true);
const me = await get('/api/me');
check('/api/me 는 로그인 전 401이고 저장하지 않아요', me.status === 401 && me.headers.get('cache-control') === 'no-store');
const ops = await get('/api/ops/settings');
check('운영 설정(/api/ops)은 시연 서버로 넘기지 않아요', ops.status === 404 && !ops.headers.get('x-desk-build'));

if (failures.length) {
  console.log(`\n연기 시험 실패 ${failures.length}개`);
  process.exit(1);
}
console.log('\n연기 시험 통과');
