// 배포 연기 시험(10/29 배포 준비 회의 A7의 바닥 부분). 이미지를 띄운 뒤나 배포 직후에 읽기만으로 확인해요.
// 로그인·쓰기는 하지 않고, 쿠키·토큰 값은 찍지 않아요. 상태와 머리 이름만 봐요.
//   node scripts/smoke.mjs http://localhost:3190
// 기대하는 CSP는 서버와 같은 파일에서 읽어요(Node 22.18·24부터 .ts를 바로 읽어요).
import { HTML_CSP, NON_HTML_CSP } from '../packages/shared/src/web-headers.ts';

const base = (process.argv[2] ?? 'http://localhost:3190').replace(/\/$/, '');
const failures = [];
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failures.push(name);
};
const get = (path, headers = {}) => fetch(`${base}${path}`, { headers, redirect: 'manual' });
const isHtml = (res) => (res.headers.get('content-type') ?? '').includes('text/html');

// 서버가 뜰 때까지 60초 기다려요.
for (let i = 0; ; i++) {
  const res = await get('/health').catch(() => undefined);
  if (res?.ok) break;
  if (i >= 30) {
    console.log('✗ 60초 안에 /health가 200이 되지 않았어요');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
check('/health 200', true);

// 살아 있음·받을 준비(A5). 받을 준비 응답에는 안쪽 정보(AI 공급자)가 없고 떠 있는 판이 있어요.
const live = await get('/health/live');
check('/health/live 200', live.status === 200);
const ready = await (await get('/health/ready')).json();
check('/health/ready 는 첫 보관 회차까지 끝났어요', ready.ok === true && ready.retention === 'done');
check('/health/ready 에 AI 공급자 이름이 없어요', !('ai' in ready));
// 배포 잡이 기대하는 판을 넘기면(SMOKE_BUILD) 떠 있는 판이 맞는지도 봐요.
if (process.env.SMOKE_BUILD) check(`떠 있는 판이 ${process.env.SMOKE_BUILD}이에요`, ready.build === process.env.SMOKE_BUILD);

const home = await get('/');
const html = await home.text();
check('/ 는 HTML 200', home.status === 200 && isHtml(home));
check('/ 는 저장하지 않아요(no-store)', home.headers.get('cache-control') === 'no-store');
check('/ CSP가 운영 값과 같아요', home.headers.get('content-security-policy') === HTML_CSP);
check('/ 틀(iframe)에 넣지 못해요', home.headers.get('x-frame-options') === 'DENY');
check('/ 형식 추측·주소 넘김을 막아요', home.headers.get('x-content-type-options') === 'nosniff' && home.headers.get('referrer-policy') === 'no-referrer');
check('응답에 무작위 요청 번호(x-request-id)가 있어요', /^[0-9a-f-]{36}$/.test(home.headers.get('x-request-id') ?? ''));
check('응답에 떠 있는 판(x-desk-build)이 있어요', Boolean(home.headers.get('x-desk-build')));

const consent = await get('/oauth/consent');
check('/oauth/consent 는 화면(HTML)이에요', consent.status === 200 && isHtml(consent));

const script = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
check('index.html이 /assets의 JS를 불러요', Boolean(script));
if (script) {
  const js = await get(script, { 'accept-encoding': 'br, gzip' });
  check('JS는 1년 동안 그대로 둬요(immutable)', js.status === 200 && (js.headers.get('cache-control') ?? '').includes('immutable'));
  check('JS는 미리 압축한 br로 와요', js.headers.get('content-encoding') === 'br');
}

const missing = await get('/assets/smoke-missing.js');
check('없는 /assets 파일은 404이고 HTML이 아니에요', missing.status === 404 && !isHtml(missing));
// 쿼리에 넣은 표시가 응답에 돌아오지 않아야 해요(B5). 서버 로그에도 없는지는 CI가 컨테이너 로그로 따로 봐요.
const page = await get('/smoke-no-such-page?q=SMOKE_CANARY');
check('화면 주소가 아니면 404이고 HTML이 아니에요', page.status === 404 && !isHtml(page));
check('404 응답에 쿼리가 돌아오지 않아요', !(await page.text()).includes('SMOKE_CANARY'));

const me = await get('/api/me');
check('/api/me 는 로그인 전 401이에요', me.status === 401);
check(
  'API는 저장하지 않고 아무것도 못 불러오는 CSP예요',
  me.headers.get('cache-control') === 'no-store' && me.headers.get('content-security-policy') === NON_HTML_CSP,
);

if (failures.length) {
  console.log(`\n연기 시험 실패 ${failures.length}개`);
  process.exit(1);
}
console.log('\n연기 시험 통과');
