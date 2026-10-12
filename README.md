# perplexity-session-mcp

내 Perplexity 계정으로 로그인한 **브라우저 세션**을 저장해 쓰는 MCP 서버입니다. API 키가 필요 없습니다.
Pro 요금제라면 Pro Search·Deep Research 할당량을 그대로 씁니다.

- **로그인 세션 저장**: 브라우저 창에서 직접 로그인(이메일 코드·Google·Apple·SSO 모두 가능) → 세션 쿠키를 암호화해 저장하고 계속 재사용합니다. 쓰는 동안 갱신된 쿠키도 자동으로 다시 저장합니다.
- **검색**: 출처 번호가 달린 웹 답변. 유료 요금제면 Pro Search, 모델 지정·학술/소셜 소스·기간 필터·후속 질문 지원.
- **딥리서치**: 수 분 걸리는 장문 보고서. 진행률 알림을 보내고, 대기 시간을 넘기면 `job_id`를 돌려줘 나중에 받아볼 수 있습니다.
- **응답 검색·활용**: 모든 답변을 로컬에 저장(JSON + Markdown)하고 전문 검색합니다. 웹/앱에서 만든 Perplexity 라이브러리 스레드도 검색·불러오기 할 수 있고, 저장된 답변에 이어서 후속 질문을 할 수 있습니다.

## 요구 사항

- Node.js **22.18 이상** (TypeScript 소스를 빌드 없이 바로 실행합니다)
- Google Chrome (없으면 Edge, 그것도 없으면 `npx patchright install chromium`)

## 설치

```bash
npm install
```

## 로그인

```bash
npm run login
```

Chrome 창이 열리면 Perplexity에 로그인합니다. 로그인이 감지되면 창이 자동으로 닫히고 세션이 저장됩니다.
MCP 클라이언트 안에서는 `perplexity_login` 도구를 부르면 같은 창이 열립니다.

```bash
npm run status
```

로그인 계정, 요금제, 남은 Pro Search·Research 횟수를 보여 줍니다.

## MCP 클라이언트 등록

경로는 이 저장소 위치로 바꿔 주세요.

**Claude Code**

```bash
claude mcp add perplexity-session -s user -- node C:/Users/<you>/repo/Perplexity-MCP/src/index.ts
```

딥리서치는 몇 분 걸립니다. `perplexity_research`는 기본 600초(`wait_seconds`)까지 기다리고, 그 안에 끝나지 않으면 `job_id`를 돌려줍니다. 클라이언트의 도구 타임아웃이 그보다 짧다면 `wait_seconds`를 줄이거나 타임아웃을 늘리세요(Claude Code는 `MCP_TOOL_TIMEOUT`, 밀리초). 호출이 중간에 끊겨도 작업은 계속되며, `perplexity_research_status`(job_id 없이 부르면 작업 목록)로 이어 받습니다. 같은 질문을 다시 보내면 새로 시작하지 않고 실행 중인 작업에 붙습니다.

**Cursor** (`~/.cursor/mcp.json`) / **Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "perplexity-session": {
      "command": "node",
      "args": ["C:/Users/<you>/repo/Perplexity-MCP/src/index.ts"]
    }
  }
}
```

## 도구

| 도구 | 하는 일 |
| --- | --- |
| `perplexity_login` | 브라우저 창을 열어 로그인하고 세션을 저장 |
| `perplexity_logout` | 저장된 세션 삭제 (옵션: 로그인 브라우저 프로필·암호화 키까지 초기화) |
| `perplexity_account` | 로그인 계정·요금제·남은 할당량 |
| `perplexity_models` | `model` 인자로 쓸 수 있는 모델 id 목록 |
| `perplexity_search` | 검색 답변 + 출처. `style`(auto/fast/pro), `model`, `sources`(web/scholar/social), `recency`, `follow_up_id`, `max_chars` |
| `perplexity_research` | 딥리서치. 결과는 **보고서 전문**(Markdown)과 요약. `wait_seconds` 안에 끝나지 않으면 `job_id` 반환 |
| `perplexity_research_status` | 딥리서치 진행 상황 / 완료 보고서. 서버 재시작·스트림 끊김으로 놓친 작업도 Perplexity 스레드에서 복구 |
| `perplexity_history_search` | 저장된 답변 전문 검색 (한국어 부분 일치, "따옴표 구문", 종류·날짜 필터) |
| `perplexity_history_get` | 저장된 답변 전체 보기 (긴 보고서는 `offset`으로 이어 읽기, `sources_only`로 전체 출처 목록) |
| `perplexity_library_search` | perplexity.ai 라이브러리(웹·앱에서 만든 스레드 포함) 검색 |
| `perplexity_thread_get` | 라이브러리 스레드 전체 불러오기(딥리서치는 보고서 전문) + 로컬 히스토리에 저장 |

리소스 `perplexity-history://{id}`로 저장된 답변을 Markdown으로 첨부할 수도 있습니다.

긴 응답은 클라이언트 출력 한도(Claude Code 기본 약 25k 토큰)에 맞게 한 페이지(약 16k 토큰, 한글은 글자당 1토큰으로 계산)로 나뉘고, 끝에 이어 읽을 `perplexity_history_get(id, offset)` 호출이 적혀 나옵니다. 출처가 많은 딥리서치는 본문에 인용된 출처만 원래 번호로 보여 줍니다.

### 후속 질문

모든 답변 끝에 `history_id`가 붙습니다. `perplexity_search`/`perplexity_research`에 `follow_up_id`로 넘기면
같은 Perplexity 스레드에서 이어서 묻습니다. 라이브러리 스레드 URL이나 slug를 넘겨도 됩니다.

## CLI

```bash
node src/index.ts search "질문"
node src/index.ts research "조사 주제"
node src/index.ts history "검색어"
node src/index.ts logout [--wipe]
```

## 데이터와 보안

모든 데이터는 `~/.perplexity-session-mcp/`(환경 변수 `PPLX_MCP_HOME`으로 변경)에 있습니다.

| 경로 | 내용 |
| --- | --- |
| `session.enc` | 세션 쿠키. AES-256-GCM 암호화 |
| `master.key` | 암호화 키. Windows에서는 DPAPI(현재 사용자)로 보호되어 다른 계정·PC에서는 풀 수 없습니다. 그 밖의 OS에서는 0600 파일입니다 |
| `login-profile/` | 로그인 창 전용 브라우저 프로필 (재로그인을 빠르게) |
| `history/` | `index.jsonl`, `entries/<id>.json`, `md/<id>.md` (사람이 읽는 사본) |
| `jobs/` | 딥리서치 작업 상태 (서버가 재시작돼도 Perplexity 스레드에서 결과를 복구) |
| `account.json` | 요금제·모델 목록 캐시 |

## 동작 원리

Perplexity 웹 API(`/rest/sse/perplexity_ask` 등)는 Cloudflare 뒤에 있어 일반 HTTP 요청은 막힙니다.
그래서 [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)로 실제 Chrome을 헤드리스로 띄우고, 저장된 쿠키를 넣은 perplexity.ai 페이지 **안에서** `fetch`를 호출합니다.
스트리밍 응답은 페이지 안에 쌓고 Node 쪽에서 주기적으로 가져와 진행률을 보고합니다. 응답의 블록·JSON Patch(`diff_block`)를 그대로 적용해 웹 화면과 같은 답변을 복원합니다.
브라우저는 첫 호출 때 뜨고, 10분간 쓰지 않으면 닫힙니다.

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PPLX_MCP_HOME` | `~/.perplexity-session-mcp` | 데이터 폴더 |
| `PPLX_HEADLESS` | `1` | `0`이면 작업용 브라우저를 화면 밖 창으로 띄움 (Cloudflare가 헤드리스를 막을 때) |
| `PPLX_BROWSER_PATH` | | 브라우저 실행 파일 직접 지정 |
| `PPLX_IDLE_CLOSE_MS` | `600000` | 유휴 시 브라우저 종료까지 시간 (0이면 유지) |
| `PPLX_LANGUAGE` | `en-US` | Perplexity에 보내는 로캘 |
| `PPLX_SEARCH_MODEL` | `pplx_pro` | 유료 요금제 기본 검색 모델 |
| `PPLX_RESEARCH_MODEL` | `pplx_alpha` | 딥리서치 모델 |
| `PPLX_ASK_TIMEOUT_MS` | `2400000` | 딥리서치 한 건의 최대 스트림 대기 시간 (검색은 5분과 이 값 중 작은 쪽) |
| `PPLX_MAX_OUTPUT_TOKENS` | `16000` | 한 번에 돌려주는 답변 분량(대략의 토큰 수) |
| `PPLX_DEBUG` | | `1`이면 원본 SSE를 `debug/`에 저장 |

## 테스트

```bash
npm test          # 파서·스트림 복구·히스토리·포맷 단위 테스트
npm run typecheck
node scripts/smoke-client.mjs '[["perplexity_account",{}]]'   # 실제 MCP 클라이언트처럼 호출
```

## 주의

Perplexity의 공개 API가 아닌 웹 앱 내부 API를 씁니다. 사이트가 바뀌면 깨질 수 있고, 사용은 Perplexity 이용 약관의 범위 안에서 본인 계정으로만 하세요.
