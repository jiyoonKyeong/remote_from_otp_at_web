# 개발 인수인계 문서 (원격 접속 게이트)

이 문서는 이 프로젝트를 이어서 개발할 사람(또는 AI)을 위한 것입니다. 설치·배포 방법은 `README.md`, 환경 변수 설명은 `.env.example` 에 있으니 여기서는 **왜 이렇게 만들었는지, 어디까지 확인했는지, 무엇이 남았는지**를 적습니다.

- 작성 시점: 2026-11-25
- 저장소: `https://github.com/jiyoonKyeong/remote_from_otp_at_web` (브랜치 `master`, 첫 커밋 `17c62e0`)
- 로컬 경로: `C:\Users\240116\Desktop\ZEEYOON\clone_from_cf`
- 이 문서(`dev.md`)는 위 커밋 이후에 추가되어 아직 커밋되지 않았습니다.

## 1. 요구사항

사용자가 요청한 내용 그대로입니다.

1. 웹앱 사용자는 2명.
2. 웹앱에 접속하면 두 사람 각자에게 휴대폰 OTP(일회용 인증번호)를 보낸다.
3. 인증번호로 확인된 두 사람에게만 내부 접근제어용 PC 원격 접속을 허용한다.
4. 접근제어용 PC 는 Windows 이고, 접근제어는 Apache Guacamole 을 쓴다.
5. 원격 화면이 웹앱 안에 나와야 한다.
6. "보안적으로 안전해야 하며, 보안상 이슈가 없는 조건으로."

추가로 물어서 확정한 것:

| 질문 | 사용자 답 |
| --- | --- |
| 언제 열리나 | 두 사람이 **모두** OTP 인증을 마쳐야 열림. 한 명만 인증하면 대기 |
| 화면 방식 | 같은 화면을 함께 보되 **한 명만 조작**, 다른 한 명은 보기만 |
| 문자 발송 | "휴대폰 인증문자(SMS)". 특정 서비스는 정하지 않음 → 갈아 끼울 수 있게 만듦 |
| 호스팅 | 외부 클라우드. Guacamole 까지는 터널이나 공개 주소로 연결 |

## 2. 현재 상태

- 기능 구현 완료. `npm test` 47개 통과 (Node v20.13.1, Windows).
- 의존성 2개: `ws`, `guacamole-common-js@1.5.0`. `npm audit` 취약점 0.
- 프레임워크, DB 없음. Node 20.6+ 순수 ESM 자바스크립트.
- **실제 Guacamole, 실제 문자 발송과는 아직 한 번도 연결해 보지 못했습니다** (6절 참고). 이것이 가장 큰 남은 일입니다.

## 3. 실행

```bash
npm install
npm run hash-password   # 비밀번호 해시 생성 (두 사람 것 각각)
copy .env.example .env  # USER1_*, USER2_* 채우기
npm run mock            # 연습용 가짜 Guacamole (8081, MOCK_PORT 로 변경 가능)
npm run dev             # 게이트 (8080), --env-file=.env --watch
npm test
```

로컬에서 두 사람을 흉내 내려면 **브라우저 두 개**(또는 일반 창 + 시크릿 창)가 필요합니다. 세션 쿠키가 하나라서 같은 브라우저의 탭 두 개로는 안 됩니다. `SMS_PROVIDER=console` 이면 인증번호가 서버 터미널에 찍힙니다.

## 4. 구조

```
src/server.js     시작점. 설정 읽기 → 서버 띄우기 → 종료 신호 처리
src/config.js     환경 변수 읽기와 검사. 문제가 있으면 ConfigError 로 시작 거부
src/gate.js       HTTP 서버: 정적 파일, API, 보안 헤더, WebSocket 입구(/tunnel)
src/auth.js       로그인 → OTP → 세션. 횟수 제한과 잠금
src/password.js   scrypt 해시 만들기/검증 (형식: scrypt:N:r:p:salt:hash)
src/sms.js        문자 발송 연결부 (console, solapi, sens, twilio)
src/room.js       "방": 두 사람 규칙, Guacamole 터널 하나를 두 브라우저에 나눠 주기, 조작 권한
src/guacamole.js  Guacamole 로그인(REST) + 화면 터널(WebSocket) + 토큰 폐기
src/protocol.js   Guacamole 명령 읽기/만들기, 양방향 허용 목록 필터
src/audit.js      접속 기록(JSON 한 줄씩 stdout), 전화번호 가리기
public/           index.html, app.js, style.css (빌드 과정 없음)
scripts/hash-password.js    비밀번호 해시 생성기
scripts/mock-guacamole.js   가짜 Guacamole (시험과 로컬 체험에 공용)
test/             protocol / config / gate(전체 흐름) 시험, helpers.js
```

브라우저용 Guacamole 라이브러리는 `node_modules/guacamole-common-js/dist/esm/guacamole-common.min.js` 를 `/vendor/guacamole-common.min.js` 로 그대로 내려 줍니다.

### 접속 흐름

```
POST /api/login {id, password}      비밀번호 확인 → 문자 발송 → 임시 세션(stage: otp) 쿠키
POST /api/otp/verify {code}         확인 → 세션 값 새로 발급(stage: verified)
WS   /tunnel                        verified 세션만 연결 가능 → room.attach()
                                    두 사람이 모두 붙으면 room 이 Guacamole 터널 1개를 연다
```

### API

| 경로 | 설명 |
| --- | --- |
| `GET /` `/app.js` `/style.css` `/vendor/guacamole-common.min.js` | 정적 파일 (이 4개가 전부) |
| `GET /healthz` | 상태 확인용. Host 검사 없이 `ok` |
| `GET /api/state` | 현재 단계와 방 상태. 브라우저가 2초마다 조회 |
| `POST /api/login` | `{id, password}` |
| `POST /api/otp/verify` | `{code}` |
| `POST /api/otp/resend` | 본문 없음 |
| `POST /api/logout` | 세션 삭제 |
| `POST /api/control/handover` | 조작 권한을 상대에게 넘김 (조작 중인 사람만) |
| `WS /tunnel` | 화면 연결. 하위 프로토콜 `guacamole` |

모든 POST 는 `Origin` 이 `PUBLIC_ORIGIN` 과 같고, `X-Requested-With: remote-gate`, `Content-Type: application/json` 이어야 합니다. 아니면 403.

`/api/state` 응답의 `stage` 는 `anonymous` / `otp` / `verified` 이고, `verified` 일 때 `room.state` 는 `waiting` / `connecting` / `open` / `retrying`, `room.controller` 는 `me` / `peer` 입니다.

## 5. 설계 결정과 지켜야 할 것

### 5.1 요청에 없었지만 넣은 것 (사용자에게 알렸음)

- **아이디·비밀번호 단계**: OTP 앞에 넣었습니다. 없으면 인터넷에 열린 주소에서 누구나 두 사람 휴대폰으로 문자를 보내게 할 수 있습니다.
- **클립보드·파일 전송·소리·영상·프린터 차단**: 화면과 키보드·마우스만 오갑니다. 사용자가 복사·붙여넣기를 원하면 열어야 하는데, 그때는 양방향 필터(`protocol.js`)를 둘 다 고쳐야 합니다.
- **화면 크기 고정**: 기본 1600×900. 브라우저가 크기를 정하지 못하게 했습니다.
- **메모리 전용 상태, 서버 1대**: 재시작하면 모두 다시 인증합니다. 인스턴스를 늘리면 두 사람이 서로 다른 서버에 붙어 영원히 열리지 않습니다.

### 5.2 바꾸면 안 되는 보안 불변 조건

1. **두 사람 규칙은 서버가 강제한다.** `room.maybeStart()` 는 두 사람의 연결이 모두 붙어 있고 두 세션이 모두 `verified` 일 때만 Guacamole 에 접속합니다. 한쪽이 빠지면(`remove()`) 터널을 닫습니다. 브라우저 코드는 표시만 합니다.
2. **Guacamole 계정·토큰은 브라우저로 나가지 않는다.** 서버가 `POST {GUAC_URL}/api/tokens` 로 로그인하고, 끝나면 `DELETE /api/tokens/{토큰}` 으로 폐기합니다.
3. **브라우저 → Guacamole 은 허용 목록.** `readClientInstruction()` 을 통과한 `key`, `mouse` 만, 그것도 조작 권한자의 것만, 검증한 숫자로 **서버가 다시 만들어** 보냅니다. 받은 문자열을 그대로 넘기지 않습니다.
4. **Guacamole → 브라우저도 허용 목록.** `createUpstreamFilter()` 가 그리기 명령만 통과시키고, 값이 `[A-Za-z0-9+/=._-]` 로만 이루어졌는지 확인한 뒤 다시 만들어 보냅니다. 값을 ASCII 로 제한한 이유는 Guacamole 구현마다 길이를 세는 방식(코드 포인트 / UTF-16)이 달라서, 서버와 브라우저가 명령 경계를 다르게 읽는 일을 원천 차단하기 위해서입니다. `nest` 명령은 안에 다른 명령을 숨길 수 있어 반드시 막아야 합니다.
5. **인증 실패는 닫힌 쪽으로.** 설정 오류, 프로토콜 오류, 응답 없는 연결은 모두 연결 종료로 처리합니다.
6. **운영 기준 강제.** `PUBLIC_ORIGIN` 이 localhost 가 아니면 `NODE_ENV` 와 상관없이 https, 실제 문자 서비스, https Guacamole 주소를 요구합니다.
7. **기록에 비밀을 남기지 않는다.** 인증번호, 비밀번호, 세션 값, 사용자가 입력한 아이디 원문(아이디 칸에 비밀번호를 넣는 실수 때문)은 기록하지 않습니다.

### 5.3 Guacamole 터널을 다루는 방법 (라이브러리 소스에서 확인한 사실)

브라우저는 표준 `Guacamole.WebSocketTunnel` + `Guacamole.Client` 를 그대로 쓰고, 서버가 Guacamole 웹앱인 척합니다.

- 브라우저 터널은 첫 메시지로 내부 명령 `0.,36.<uuid>;` 를 기다립니다. `room.attach()` 가 바로 보냅니다.
- 브라우저는 0.5초마다 내부 ping(`0.,4.ping,<시각>;`)을 보내고, 15초 동안 아무것도 못 받으면 끊습니다. 서버가 ping 을 그대로 돌려줍니다.
- 내부 명령(opcode 가 빈 문자열)은 `Guacamole.Client` 까지 올라가지 않습니다. 그래서 서버가 "상태가 바뀌었다"를 알릴 때는 `4.gate,5.state;` 라는 자체 명령을 쓰고, `public/app.js` 가 `tunnel.oninstruction` 을 감싸 가로챕니다.
- 실제 Guacamole 쪽으로는 서버가 5초마다 `3.nop;` 을 보냅니다 (guacd 는 한동안 아무것도 못 받으면 끊음). 연결 생존 확인은 WebSocket ping/pong 으로 합니다.
- `sync` 는 두 브라우저가 모두 응답한 시각까지만(느린 쪽 기준) Guacamole 에 한 번 전달합니다.
- 두 브라우저는 터널이 열리기 **전에** 이미 붙어 있으므로 화면 상태가 같습니다. 중간 합류는 지원하지 않습니다. 그래서 터널이 닫히면 화면을 받은 브라우저 연결도 모두 닫고(코드 4000), 브라우저가 1.5초 뒤 새로 연결합니다.
- 보기 전용인 사람에게는 조작자의 마우스 위치를 `mouse,x,y` 명령으로 따로 보내 줍니다 (Guacamole 은 사용자가 한 명이라고 알고 있어서 알려 주지 않음).
- 조작 권한을 넘길 때 누르고 있던 키와 마우스 버튼을 서버가 풀어 줍니다.
- Guacamole 터널 주소: `{GUAC_URL}/websocket-tunnel?token=…&GUAC_DATA_SOURCE=…&GUAC_ID=…&GUAC_TYPE=c&GUAC_WIDTH=…&GUAC_HEIGHT=…&GUAC_DPI=…&GUAC_IMAGE=image/png&GUAC_IMAGE=image/jpeg`. `GUAC_AUDIO`, `GUAC_VIDEO` 는 일부러 보내지 않습니다.

브라우저 쪽 연결을 닫는 코드: 4000 재시작, 4001 같은 사용자의 새 연결로 교체, 4002 너무 느림, 4003 세션 종료, 4004 잘못된 입력.

### 5.4 제한값 (코드 상수)

| 항목 | 값 | 위치 |
| --- | --- | --- |
| 인증번호 | 6자리, 3분(`OTP_TTL_SECONDS`), 번호당 5번 입력, 로그인당 3개, 다시 받기 30초 대기 | `auth.js` |
| 문자 | 사용자당 10분에 5통 | `auth.js` |
| 계정 잠금 | 비밀번호·인증번호 실패 15분에 10번 → 창이 끝날 때까지 | `auth.js` |
| IP 제한 | 로그인 10분에 20번, 인증번호 확인 10분에 40번, 전체 로그인 분당 120번 | `auth.js` |
| 세션 | 떠난 뒤 120초, 최대 120분, 인증 대기 단계 최대 10분, 사용자당 1개 | `auth.js`, `config.js` |
| 요청 본문 | 2048바이트 | `gate.js` |
| 브라우저 → 서버 메시지 | 8192바이트, 초당 명령 2000개 | `gate.js`, `room.js` |
| 브라우저 송신 대기 | 8MB 넘으면 그 사람을 끊음 | `room.js` |
| Guacamole 연결 실패 시 재시도 | 5초에서 시작해 두 배씩, 최대 60초 | `room.js` |

## 6. 확인한 것과 못 한 것

**확인함**
- 자동 시험 47개: 프로토콜 읽기와 필터, 설정 검사, 로그인·OTP·잠금·만료, 다른 사이트 요청 거부, 한 명일 때 Guacamole 미접속, 두 명일 때 같은 화면, 조작 권한자 입력만 전달, 클립보드·파일 등 차단과 거절 응답, 권한 넘기기, 한 명 이탈 시 종료와 토큰 폐기, 연결 실패 시 재시도 간격.
- 실제 브라우저에서 실제 `guacamole-common-js` 로 로그인 → 인증번호 → 화면 표시 → 마우스 조작 → 권한 넘기기 → 보기 전용 화면. 상대는 `scripts/mock-guacamole.js` (가짜 서버). 콘텐츠 보안 정책 위반 없음.
- `src/server.js` 직접 실행: 개발 설정으로 시작됨, 안전하지 않은 운영 설정은 이유를 출력하고 종료.

**확인 못 함**
- **실제 Guacamole**: 개발 PC 의 Docker 가 꺼져 있었습니다. REST 응답 형식, 터널 주소 매개변수, 내부 명령 처리는 Guacamole 1.5 동작에 대한 지식과 라이브러리 소스를 근거로 맞췄을 뿐입니다. 첫 연결에서 조정이 필요할 수 있습니다.
- **실제 문자 발송**: `solapi`, `sens`, `twilio` 연결부는 각 서비스 API 규격대로 작성했지만 한 통도 보내 보지 못했습니다. 서명 방식이나 필드 이름이 틀렸을 가능성을 열어 두세요.
- **Docker 이미지 빌드**: `Dockerfile` 은 작성만 했습니다.
- **비밀번호 입력 가리기**: `hash-password.js` 는 파이프 입력으로만 시험했습니다. 실제 터미널에서 글자가 안 보이는지는 못 봤습니다.
- **한글 입력기**, 모바일 브라우저, Safari.

## 7. 남은 일 (우선순위 순)

1. **실제 Guacamole 연결 시험.** Docker 로 `guacamole/guacd` + `guacamole/guacamole` + DB 를 띄우고 RDP 또는 VNC 대상을 연결해 확인. 볼 것: 로그인 응답, 터널이 열리는지, 화면이 두 브라우저에 같게 나오는지, RDP 에서 `img`/`blob` 스트림과 커서가 정상인지, 클립보드 차단 시 Guacamole 이 거절 응답(`ack` 256)을 문제없이 받는지, 오래 켜 두어도 끊기지 않는지.
2. **문자 서비스 확정과 실제 발송 시험.** 사용자가 서비스를 정하면 그 연결부만 남기고 나머지는 지워도 됩니다.
3. **호스팅 선정과 배포.** 조건: 항상 켜진 인스턴스 1개, WebSocket, HTTPS. Vercel 같은 서버리스는 불가. Guacamole 로 가는 길은 게이트 서버만 통과하도록 제한(고정 IP 허용 또는 `GUAC_EXTRA_HEADERS` 로 터널 서비스 토큰).
4. **사용자 결정이 필요한 것**: 복사·붙여넣기 허용 여부, 화면 크기, 세션 최대 시간, 처음 조작 권한자.
5. (선택) 문자 OTP 를 인증 앱(TOTP)이나 보안 키로 교체 — 문자 방식의 약점(유심 복제 등)을 없애려면.
6. (선택) 보기 전용인 사람이 조작 권한을 요청하는 기능, 연결 기록 화면.

"보안 이슈가 전혀 없다"는 보장은 할 수 없다고 사용자에게 이미 말했고, 운영 전 사내 보안 검토를 권했습니다. 남는 한계는 `README.md` 의 "알아 둘 한계" 에 있습니다.

## 8. 작업할 때 걸리기 쉬운 것

- **`node --test test/` 로 돌리지 마세요.** Node 20 은 폴더 안의 모든 `.js` 를 시험으로 실행합니다. 그래서 가짜 Guacamole 을 `scripts/` 로 옮겼고, `npm test` 는 파일 이름을 직접 나열합니다. 시험 파일을 추가하면 `package.json` 의 `test` 스크립트에도 추가해야 합니다.
- Node 20.13 에서는 `describe` 밖의 최상위 `before()` 가 시험보다 먼저 끝난다는 보장이 없습니다. 최상위 `await` 를 쓰세요 (`test/config.test.js` 참고).
- 시험은 `overrides.now` 로 시계를 앞당깁니다. 문자 한도(10분 5통)와 IP 한도가 같은 `describe` 안에서 누적되므로, 로그인을 여러 번 하는 시험을 추가할 때는 `stack.clock.skew` 를 11분 이상 밀어야 할 수 있습니다. 반대로 시계를 밀면 기존 세션이 만료(120초)된다는 점도 기억하세요.
- 시험에서 깨진 입력을 만들 때 주의: `5.mouse,3.1;2;` 는 값 `1;2` 로 **정상 해석**됩니다. 길이가 모자란 `5.mouse,9.1;` 같은 것이 진짜 깨진 입력입니다.
- `gate.js` 는 시작할 때 정적 파일을 메모리에 읽습니다. `public/` 을 고치면 서버를 다시 시작해야 합니다 (`npm run dev` 는 `--watch` 지만 `src/` 에서 import 하지 않는 `public/` 변경은 감지하지 못할 수 있음).
- 콘텐츠 보안 정책이 `script-src 'self'; style-src 'self'` 입니다. HTML 에 인라인 `<script>`, `<style>`, `style="..."` 를 쓰면 막힙니다. 자바스크립트로 `element.style.x = …` 를 바꾸는 것은 됩니다.
- 쿠키 이름은 https 에서 `__Host-gate`, 로컬 http 에서 `gate` 입니다.
- 요청의 `Host` 헤더가 `PUBLIC_ORIGIN` 의 호스트와 다르면 400 입니다. 호스팅 서비스의 프록시가 `Host` 를 바꾸면 접속이 안 되니 그때는 이 검사를 조정해야 합니다.
- `TRUST_PROXY` 를 실제 프록시 단계 수보다 크게 주면 `X-Forwarded-For` 를 꾸며 IP 제한을 피할 수 있습니다.
- 키보드는 원격 화면 영역(`#stage`)에 포커스가 있을 때만 전달됩니다. `Guacamole.Keyboard` 는 떼어 내는 기능이 없어서 페이지에 하나만 만들어 계속 씁니다.

## 9. 사용자와 일하는 방식

- 대화는 한국어. 단순한 것을 선호하고, 전문 용어보다 쉬운 설명을 원합니다.
- **커밋과 푸시는 사용자가 직접 합니다.** 대신 하지 마세요.
- 비밀 값(비밀번호, API 키, 토큰)은 채팅에 붙여 달라고 하지 말고, 코드나 저장소에도 적지 마세요. `.env`(깃 제외) 또는 호스팅 서비스의 시크릿 메뉴에 사용자가 직접 넣습니다.
- 사용자의 개발 PC 는 Windows + PowerShell 입니다. 같은 PC 에서 다른 프로젝트의 개발 서버(보통 3000번)가 떠 있을 수 있으니 포트를 쓰기 전에 확인하고, 직접 띄운 프로세스는 끝난 뒤 정리하세요.
