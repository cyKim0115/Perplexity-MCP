# Perplexity Session MCP

[![npm](https://img.shields.io/npm/v/perplexity-session-mcp)](https://www.npmjs.com/package/perplexity-session-mcp)
[![CI](https://github.com/cyKim0115/Perplexity-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/cyKim0115/Perplexity-MCP/actions/workflows/ci.yml)
[![M8ven Score](https://m8ven.ai/badge/mcp/cykim0115-perplexity-mcp-18de73?v=be73b853882bdef9f8cdbf747e561172)](https://m8ven.ai/mcp/cykim0115-perplexity-mcp-18de73?s=readme)
[![License: MIT](https://img.shields.io/npm/l/perplexity-session-mcp)](LICENSE)
[![Node](https://img.shields.io/node/v/perplexity-session-mcp)](package.json)
![Windows · macOS · Linux](https://img.shields.io/badge/OS-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-20808d)
![MCP stdio](https://img.shields.io/badge/MCP-stdio-20808d)
![API key 불필요](https://img.shields.io/badge/API%20key-none-20808d)

내 Perplexity 계정에 로그인한 **브라우저 세션**으로 검색·딥리서치를 쓰는 MCP 서버입니다. API 키가 필요 없고, Pro 요금제라면 Pro Search·Deep Research 할당량을 그대로 씁니다.
Claude Code·Codex·Cursor·Claude Desktop 같은 MCP 클라이언트에 붙여 씁니다.

![perplexity_search 호출 결과 — 출처 번호가 달린 답변, 출처 목록, 후속 질문용 history_id](docs/screenshots/search.png)

*stdio MCP 클라이언트로 `perplexity_search`를 실제로 호출한 결과입니다(5.8초). 스레드 주소는 가렸습니다.*

[빠른 시작](#빠른-시작) · [터미널 명령](#터미널-명령-cli) · [로그인과 세션](#로그인과-세션) · [클라이언트 등록](#mcp-클라이언트-등록) · [도구](#도구) · [사용 예](#사용-예) · [데이터와 보안](#데이터와-보안) · [문제 해결](#문제-해결) · [제거](#제거) · [변경 기록](CHANGELOG.md)

> **비공식 도구입니다.** Perplexity 공식 API가 아니라 웹 앱이 쓰는 내부 API를 호출하므로 사이트가 바뀌면 깨질 수 있습니다.
> 이런 자동화 사용은 Perplexity 이용 약관에 어긋날 수 있으며, 계정 제한 등 사용에 따른 책임은 사용자 본인에게 있습니다.

---

## 주요 기능

- **로그인 세션 저장** — 브라우저 창에서 직접 로그인(이메일 코드·Google·Apple·SSO)하면 세션 쿠키를 암호화해 저장하고 계속 재사용합니다. 쓰는 동안 바뀐 쿠키도 다시 저장합니다.
- **검색** — 출처 번호가 달린 웹 답변. 유료 요금제면 Pro Search, 모델 지정·학술/소셜 소스·기간 필터·후속 질문을 지원합니다.
- **딥리서치** — 몇 분 걸리는 장문 보고서를 **전문 그대로**(요약이 아니라 보고서 원문) 받아 옵니다. 진행률을 알려 주고, 대기 시간을 넘기면 `job_id`를 돌려줘 나중에 받을 수 있습니다. 연결이 끊기거나 서버가 재시작돼도 Perplexity 스레드에서 결과를 복구합니다.
- **응답 검색·활용** — 모든 답변을 로컬에 저장(JSON + Markdown)하고 전문 검색합니다. 웹·앱에서 만든 Perplexity 라이브러리 스레드도 찾아 불러오고, 저장된 답변에 이어서 후속 질문을 합니다.
- **긴 응답 나눠 읽기** — 클라이언트 출력 한도에 맞춰 한 페이지씩 돌려주고, 다음 페이지를 읽는 호출을 끝에 적어 줍니다.

## 빠른 시작

준비물: [Node.js](https://nodejs.org/) **22.18 이상**, Google Chrome(없으면 Edge, 둘 다 없으면 `npx patchright install chromium`).

```bash
npm install -g perplexity-session-mcp
pplx setup
```

`pplx setup` 하나로 준비가 끝납니다.

1. 이 PC에 있는 MCP 클라이언트(Claude Code·Codex·Cursor·Claude Desktop)를 찾아 MCP 서버로 등록합니다. 이미 등록된 곳은 건드리지 않고, JSON 설정을 고치기 전에는 `.bak` 백업을 남깁니다.
2. 저장된 로그인이 없으면 Chrome 창을 엽니다. Perplexity에 로그인하면 창이 저절로 닫힙니다.
3. 등록된 클라이언트를 다시 시작하면(Claude Code는 `/mcp`로 다시 연결) 도구가 보입니다.

`pplx setup --dry-run`은 바꿀 내용만 보여 주고, `--no-login`은 로그인을 건너뜁니다. 직접 등록하려면 [클라이언트 등록](#mcp-클라이언트-등록)을 보세요.
로그인은 클라이언트 안에서 `perplexity_login` 도구로 해도 같은 창이 열립니다.

### 업데이트

```bash
npm install -g perplexity-session-mcp@latest
```

CLI는 바로 새 버전이 됩니다. 이미 떠 있는 MCP 서버는 클라이언트를 다시 시작하거나 Claude Code에서 `/mcp`로 다시 연결하면 바뀝니다. 로그인 세션은 그대로 유지됩니다.
무엇이 바뀌었는지는 [CHANGELOG.md](CHANGELOG.md)에 있습니다.

**git clone으로 쓰던 경우**: 클론 경로(`node …/src/index.ts`)로 등록해 둔 설정은 그대로 동작하니 바꾸지 않아도 됩니다. 클론에서 `npm link`를 한 번 실행하면 `pplx` 명령도 쓸 수 있습니다.
npm 설치로 옮기려면 각 클라이언트에서 기존 `perplexity-session` 등록을 지운 뒤(방법은 [제거](#제거)의 1단계) `pplx setup`을 실행하세요. setup은 이미 있는 등록을 고치지 않습니다.

### 소스에서 실행 (개발용)

```bash
git clone https://github.com/cyKim0115/Perplexity-MCP.git
cd Perplexity-MCP
npm install
npm link
```

`npm link`를 하면 `pplx`가 이 폴더의 TypeScript 소스를 빌드 없이 바로 실행합니다. 그래서 `git pull`만 해도 새 코드가 반영됩니다.

## 터미널 명령 (CLI)

MCP 클라이언트 없이 터미널에서 직접 실행합니다. AI를 거치지 않으므로 로그인·계정 확인은 여기서 하는 게 가장 빠릅니다.
Claude Code 입력창에서는 앞에 `!`를 붙이면(`! pplx status`) 셸에서 바로 실행됩니다.

| 명령 | 하는 일 |
| --- | --- |
| `pplx setup` | MCP 클라이언트 등록 + 로그인 (다시 실행해도 안전). `--dry-run`, `--no-login` |
| `pplx status` | 로그인 계정·요금제·남은 Pro Search·Research 횟수 |
| `pplx login` | 로그인 창을 열어 다시 로그인 (`--timeout <초>`, 기본 300) |
| `pplx logout` | 저장된 세션 삭제 (`--wipe`면 로그인 프로필·암호화 키까지) |
| `pplx search "질문"` | 검색 한 번 실행하고 답변 출력 |
| `pplx research "조사 주제"` | 딥리서치 한 번 실행하고 보고서 출력 (몇 분 걸림) |
| `pplx history "검색어"` | 저장된 답변 검색 |
| `pplx -v` | 설치된 버전 |
| `pplx help` | 명령 목록과 데이터 폴더 위치 |

`pplx`를 인자 없이 실행하면 MCP 서버(stdio)로 동작합니다. 클라이언트가 서버를 띄울 때 쓰는 방식이라 터미널에서 직접 실행할 일은 없습니다.

## 로그인과 세션

`pplx login`(또는 `perplexity_login`)을 실행하면 **확장도 북마크도 Google 로그인도 없는 Chrome 창**이 뜹니다.
게스트 창처럼 보이지만 Chrome 게스트 모드가 아니라, 이 도구 전용 프로필(`~/.perplexity-session-mcp/login-profile/`)로 띄운 실제 Chrome입니다.
평소 쓰는 Chrome 프로필이나 그 쿠키는 읽지 않습니다.

```mermaid
flowchart TB
  subgraph L["로그인 (처음 한 번)"]
    direction LR
    A["perplexity_login"] --> B["전용 프로필<br/>Chrome 창"]
    B -->|"사용자가 직접 로그인"| C["세션 쿠키 감지"]
    C --> D["perplexity.ai 쿠키만 골라<br/>AES-256-GCM 암호화"]
  end
  S[("session.enc + master.key (DPAPI)")]
  subgraph R["검색·딥리서치 (매번)"]
    direction LR
    F["MCP 도구 호출"] --> G["헤드리스 Chrome에<br/>저장된 쿠키 주입"]
    G --> H["perplexity.ai 페이지 안에서<br/>fetch로 API 호출"]
    H --> I["답변·출처를<br/>history/에 저장"]
  end
  L -- "저장" --> S
  S -- "불러오기" --> R
  R -. "갱신된 쿠키 다시 저장" .-> S
```

1. 로그인 창은 perplexity.ai가 Cloudflare 확인을 통과할 때까지 기다린 뒤 로그인을 기다립니다(기본 5분).
2. 세션 쿠키가 생기면 로그인 팝업까지 포함해 모든 perplexity.ai 탭에서 로그인된 계정을 확인합니다.
3. perplexity.ai 쿠키와 localStorage만 골라 암호화해 저장합니다. Cloudflare 쿠키(`cf_clearance` 등)는 그 브라우저 지문에 묶여 있어서 옮기지 않습니다.
4. 실제 검색은 별도의 헤드리스 Chrome이 저장된 쿠키로 합니다. 로그인 창의 프로필은 남겨 두므로 다음 재로그인은 대개 클릭 한 번입니다.

여러 클라이언트가 동시에 서버를 띄워도 세션 파일 하나를 함께 씁니다. 한쪽에서 다시 로그인하면 나머지가 다음 호출 때 새 쿠키로 바꿔 끼웁니다.
Windows에서 세션 파일은 DPAPI로 현재 사용자에게 묶여 있어 **다른 PC로 복사해도 풀리지 않습니다.** 새 PC에서는 `pplx login`을 한 번 실행하세요.

## MCP 클라이언트 등록

`pplx setup`이 아래 클라이언트를 자동으로 등록합니다. 이때 PATH에 기대지 않도록 node와 이 패키지 스크립트의 절대 경로를 적습니다.
직접 등록할 때는 `pplx`를 설치한 뒤 MCP 서버 명령으로 `pplx`를 씁니다. Windows에서는 `.cmd` 파일을 바로 실행하지 못하는 클라이언트가 많아서 `cmd /c pplx`로 띄웁니다.
[소스에서 실행](#소스에서-실행-개발용)할 때도 `npm link`를 했다면 똑같이 등록합니다.

**Claude Code**

```bash
claude mcp add perplexity-session -s user -- pplx           # macOS·Linux
claude mcp add perplexity-session -s user -- cmd /c pplx    # Windows
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.perplexity-session]
command = "pplx"          # Windows: command = "cmd", args = ["/c", "pplx"]
startup_timeout_sec = 60
tool_timeout_sec = 3700   # 딥리서치 대기(최대 3600초)보다 길게
```

**Cursor** (`~/.cursor/mcp.json`) / **Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "perplexity-session": {
      "command": "cmd",
      "args": ["/c", "pplx"]
    }
  }
}
```

위는 Windows 예시입니다. macOS·Linux에서는 `"command": "pplx"`만 적고 `args`는 뺍니다.
클라이언트가 `pplx`를 찾지 못하면(nvm 등) `npm prefix -g` 폴더에 있는 `pplx`의 절대 경로를 씁니다.

딥리서치는 몇 분 걸립니다. `perplexity_research`는 기본 600초(`wait_seconds`)까지 기다리고, 그 안에 끝나지 않으면 `job_id`를 돌려줍니다.
클라이언트의 도구 타임아웃이 더 짧다면 `wait_seconds`를 줄이거나 타임아웃을 늘리세요(Claude Code는 `MCP_TOOL_TIMEOUT`, 밀리초).
호출이 중간에 끊겨도 작업은 계속되며 `perplexity_research_status`(job_id 없이 부르면 작업 목록)로 이어 받습니다. 같은 질문을 다시 보내면 새로 시작하지 않고 실행 중인 작업에 붙습니다.

## 도구

| 도구 | 하는 일 |
| --- | --- |
| `perplexity_login` | 로그인 창을 열어 로그인하고 세션을 저장 |
| `perplexity_logout` | 저장된 세션 삭제 (옵션: 로그인 프로필·암호화 키까지 초기화) |
| `perplexity_account` | 로그인 계정·요금제·남은 할당량 |
| `perplexity_models` | `model` 인자로 쓸 수 있는 모델 id 목록 |
| `perplexity_search` | 검색 답변 + 출처. `style`(auto/fast/pro), `model`, `sources`(web/scholar/social), `recency`, `follow_up_id`, `max_chars` |
| `perplexity_research` | 딥리서치. 결과는 **보고서 전문**(Markdown)과 요약. `wait_seconds` 안에 끝나지 않으면 `job_id` 반환 |
| `perplexity_research_status` | 딥리서치 진행 상황·완료 보고서. 서버 재시작·스트림 끊김으로 놓친 작업도 Perplexity 스레드에서 복구 |
| `perplexity_history_search` | 저장된 답변 전문 검색 (한국어 부분 일치, "따옴표 구문", 종류·날짜 필터) |
| `perplexity_history_get` | 저장된 답변 전체 보기 (긴 보고서는 `offset`으로 이어 읽기, `sources_only`로 전체 출처 목록) |
| `perplexity_library_search` | perplexity.ai 라이브러리(웹·앱에서 만든 스레드 포함) 검색 |
| `perplexity_thread_get` | 라이브러리 스레드 전체 불러오기(딥리서치는 보고서 전문) + 로컬 히스토리에 저장 |

도구마다 MCP 힌트 4종(`readOnlyHint`·`destructiveHint`·`idempotentHint`·`openWorldHint`)을 모두 적어 두어, 클라이언트가 읽기 전용 도구와 지우는 도구를 구분할 수 있습니다.
지우는 도구는 로컬 세션 파일을 지우는 `perplexity_logout`뿐이고, `perplexity_history_*`와 `perplexity_logout`은 네트워크를 쓰지 않습니다.

리소스 `perplexity-history://{id}`로 저장된 답변을 Markdown 그대로 첨부할 수도 있습니다.

## 사용 예

### 딥리서치 보고서 이어 읽기

딥리서치 보고서(이 예는 12,110자·출처 109개)는 한 페이지씩 돌아오고, 끝에 다음 페이지를 읽는 호출이 적혀 있습니다.
출처가 많으면 본문에 인용된 출처만 원래 번호로 보여 주고, 전체 목록은 `sources_only`로 따로 받습니다.

![perplexity_history_get으로 딥리서치 보고서 첫 페이지를 읽은 결과 — 끝에 offset으로 이어 읽는 안내](docs/screenshots/research-report.png)

### 저장된 답변 검색

검색·딥리서치·불러온 스레드는 모두 로컬 히스토리에 쌓이고, 질문과 답변 본문에서 찾습니다. 모든 단어가 들어간 답변이 없으면 일부만 맞는 답변을 보여 줍니다.

![perplexity_history_search로 "MCP"를 찾은 결과 — 종류·모델·출처 수와 본문 발췌](docs/screenshots/history-search.png)

### 후속 질문

모든 답변 끝에 `history_id`가 붙습니다. `perplexity_search`/`perplexity_research`에 `follow_up_id`로 넘기면 같은 Perplexity 스레드에서 이어서 묻습니다.
라이브러리 스레드 URL이나 slug를 넘겨도 됩니다.

### 긴 응답

긴 응답은 클라이언트 출력 한도(Claude Code 기본 약 25k 토큰)에 맞게 한 페이지(약 16k 토큰, 한글은 글자당 1토큰으로 계산)로 나뉩니다. 분량은 `max_chars`나 `PPLX_MAX_OUTPUT_TOKENS`로 조절합니다.

## 데이터와 보안

모든 데이터는 `~/.perplexity-session-mcp/`(환경 변수 `PPLX_MCP_HOME`으로 변경)에 있습니다. 이 폴더는 저장소 밖이며 커밋되지 않습니다.
세션 쿠키는 이 PC에만 저장되고 perplexity.ai 페이지 안에서만 쓰입니다. 이 서버는 텔레메트리를 수집하지 않으며, 세션이나 답변 기록을 다른 서버로 보내지 않습니다.

| 경로 | 내용 |
| --- | --- |
| `session.enc` | 세션 쿠키. AES-256-GCM 암호화 |
| `master.key` | 암호화 키. Windows에서는 DPAPI(현재 사용자)로 보호되어 다른 계정·PC에서는 풀 수 없습니다. 그 밖의 OS에서는 0600 파일입니다 |
| `login-profile/` | 로그인 창 전용 브라우저 프로필. 이 안에도 로그인 상태가 남아 있습니다 |
| `history/` | `index.jsonl`, `entries/<id>.json`, `md/<id>.md`(사람이 읽는 사본) |
| `jobs/` | 딥리서치 작업 상태 (서버가 재시작돼도 결과를 복구) |
| `account.json` | 요금제·모델 목록 캐시 |

완전히 로그아웃하려면 `pplx logout --wipe`로 `login-profile/`과 `master.key`까지 지웁니다.

### `pplx setup`이 바꾸는 파일

`pplx setup`은 이 데이터 폴더 밖에 있는 **다른 앱의 설정 파일**에 서버 등록을 추가합니다. 실행 전에 `pplx setup --dry-run`으로 바꿀 곳을 먼저 볼 수 있습니다.

| 클라이언트 | 바꾸는 곳 | 방식 |
| --- | --- | --- |
| Claude Code | 사용자 설정(모든 프로젝트) | `claude mcp add -s user` 명령으로 추가 |
| Codex | `~/.codex/config.toml` (`CODEX_HOME`) | 파일 끝에 `[mcp_servers.perplexity-session]` 추가 |
| Cursor | `~/.cursor/mcp.json` | `mcpServers`에 항목 추가, 원본은 `mcp.json.bak` |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers`에 항목 추가, 원본은 `.bak` |

- 설정 폴더가 없는 클라이언트(설치하지 않은 앱)는 건너뜁니다.
- 이미 `perplexity-session`이 등록돼 있으면 그 파일은 건드리지 않습니다. JSON 형식이 깨진 파일도 고치지 않고 실패로만 알립니다.
- 등록하는 명령은 node 실행 파일과 설치된 `bin/pplx.js`의 절대 경로입니다. `npx`로 setup을 실행하면 `npx -y perplexity-session-mcp@<실행한 버전>`을 등록합니다.
  `@latest`로 등록하지 않는 이유는, 나중에 올라온 버전이 확인 없이 로그인 세션에 접근하며 실행되는 일을 막기 위해서입니다. 새 버전은 사용자가 업데이트할 때만 들어옵니다.

## 동작 원리

Perplexity 웹 API(`/rest/sse/perplexity_ask` 등)는 Cloudflare 뒤에 있어 일반 HTTP 요청은 막힙니다.
그래서 [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)로 실제 Chrome을 헤드리스로 띄우고, 저장된 쿠키를 넣은 perplexity.ai 페이지 **안에서** `fetch`를 호출합니다.

- 헤드리스 Chrome은 User-Agent의 `HeadlessChrome`을 일반 Chrome 표기로 바꿉니다. 그대로 두면 Cloudflare가 `/rest/*`를 계속 막습니다. 그래도 막히면 화면 밖 창으로 한 번 더 시도합니다.
- 스트리밍 응답은 페이지 안에 쌓고 Node 쪽에서 주기적으로 가져와 진행률을 보고합니다. 응답의 블록과 JSON Patch(`diff_block`)를 그대로 적용해 웹 화면과 같은 답변을 복원합니다.
- 딥리서치 보고서 전문은 스레드의 보고서 첨부(`RESEARCH_REPORT`)에서 받아 옵니다.
- 브라우저는 첫 호출 때 뜨고 10분간 쓰지 않으면 닫힙니다.

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PPLX_MCP_HOME` | `~/.perplexity-session-mcp` | 데이터 폴더 (세션·답변 기록·딥리서치 작업이 저장되는 곳) |
| `PPLX_HEADLESS` | `1` | `0`이면 작업용 브라우저를 화면 밖 창으로 띄움 (Cloudflare가 헤드리스를 막을 때) |
| `PPLX_BROWSER_PATH` | | 브라우저 실행 파일 직접 지정 |
| `PPLX_IDLE_CLOSE_MS` | `600000` | 유휴 시 브라우저 종료까지 시간 (0이면 유지) |
| `PPLX_LANGUAGE` | `en-US` | Perplexity에 보내는 로캘 |
| `PPLX_SEARCH_MODEL` | `pplx_pro` | 유료 요금제 기본 검색 모델 |
| `PPLX_RESEARCH_MODEL` | `pplx_alpha` | `perplexity_research`가 쓰는 딥리서치 모델 |
| `PPLX_ASK_TIMEOUT_MS` | `2400000` | 딥리서치 한 건의 최대 스트림 대기 시간 (검색은 5분과 이 값 중 작은 쪽) |
| `PPLX_MAX_OUTPUT_TOKENS` | `16000` | 한 번에 돌려주는 답변 분량(대략의 토큰 수) |
| `PPLX_DEBUG` | | `1`이면 원본 SSE를 `debug/`에 저장 |

## 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| `pplx`를 찾을 수 없다 | npm 전역 폴더가 PATH에 있어야 합니다. `npm prefix -g`로 위치를 보고, Windows는 그 폴더(보통 `%APPDATA%\npm`), macOS·Linux는 그 아래 `bin`을 PATH에 넣은 뒤 터미널을 새로 엽니다. |
| 설치·실행 중 문법 오류나 `EBADENGINE` 경고 | `node -v`가 22.18 이상인지 확인합니다. |
| 클라이언트에 도구가 보이지 않는다 | 클라이언트를 다시 시작합니다(Claude Code는 `/mcp`). `pplx setup --dry-run`이나 `claude mcp get perplexity-session`으로 등록 상태를 봅니다. |
| Node 버전을 바꾼 뒤(nvm 등) 서버가 뜨지 않는다 | setup은 실행할 때의 node 경로를 적습니다. 새 Node에서 `npm install -g perplexity-session-mcp`를 다시 하고, 기존 등록을 지운 뒤([제거](#제거) 1단계) `pplx setup`을 다시 실행합니다. |
| "Not logged in"이나 로그인이 풀렸다는 응답 | `pplx login`으로 다시 로그인합니다. 떠 있는 MCP 서버도 다음 호출부터 새 세션을 씁니다. |
| Cloudflare 확인에서 계속 막힌다 | `PPLX_HEADLESS=0`으로 작업용 브라우저를 화면 밖 창으로 띄워 봅니다. |
| 새 PC로 데이터 폴더를 옮겼더니 세션이 안 풀린다 | Windows 세션 파일은 그 PC 사용자에게 묶여 있습니다. 새 PC에서 `pplx login`을 한 번 실행합니다. |

## 제거

1. **클라이언트 등록 지우기**
   - Claude Code: `claude mcp remove perplexity-session -s user`
   - Codex: `~/.codex/config.toml`에서 `[mcp_servers.perplexity-session]` 블록을 지웁니다.
   - Cursor·Claude Desktop: `mcp.json`·`claude_desktop_config.json`의 `mcpServers` 안에서 `"perplexity-session"` 항목을 지웁니다.
2. **로그인 정보 지우기**: `pplx logout --wipe` (세션, 로그인 프로필, 암호화 키)
3. **프로그램 지우기**: `npm uninstall -g perplexity-session-mcp` (클론으로 썼다면 `npm unlink -g perplexity-session-mcp` 후 폴더 삭제)
4. **답변 기록까지 지우기**: 데이터 폴더 `~/.perplexity-session-mcp/`(Windows는 `%USERPROFILE%\.perplexity-session-mcp`)를 통째로 지웁니다.

## 개발

```bash
npm test             # 파서·스트림 복구·히스토리·포맷 + 도구 11개 MCP 호출 테스트 (브라우저·네트워크 없음)
npm run typecheck
node scripts/smoke-client.mjs '[["perplexity_account",{}]]'   # 실제 MCP 클라이언트처럼 stdio로 호출
node scripts/parse-sse.ts <capture.sse>                        # PPLX_DEBUG=1로 저장한 스트림 재해석
```

딥리서치는 하루 횟수가 적으니, 파서를 고칠 때는 새로 호출하기보다 저장해 둔 스트림으로 확인하세요.
push와 PR마다 GitHub Actions가 Node 22·24에서 타입체크·테스트·빌드를 돌립니다.

### 배포 (관리자)

npm 패키지에는 `bin/`과 컴파일된 `dist/`만 들어갑니다. Node가 `node_modules` 안의 `.ts`는 실행하지 않기 때문입니다. `npm publish`가 `prepack`에서 빌드를 먼저 돌립니다.

1. [CHANGELOG.md](CHANGELOG.md)에 이번 버전의 변경 내용과 날짜를 적고 커밋합니다.
2. `npm version <patch|minor|major>` — package.json 버전을 올리고 커밋과 `v<버전>` 태그를 만듭니다. 서버가 알리는 버전도 package.json에서 읽습니다.
3. `npm publish` — 브라우저 인증(2FA)을 요구하면 Enter를 눌러 승인합니다.
4. `npm view perplexity-session-mcp version`으로 새 버전이 보이면 `git push --follow-tags`로 커밋과 태그를 올립니다.

- 새 패키지를 처음 올릴 때는 npm 계정 **이메일 인증**이 필요합니다. 인증 전에 받은 로그인으로는 계속 403이 나므로, 인증 후 `npm logout` → `npm login`을 다시 합니다.
- 배포 직후 1~2분은 "being processed" 상태라 `npm view`에 이전 버전이나 임시 버전(`0.0.0-stage`)이 보일 수 있습니다.
- README는 npm 배포가 끝난 뒤에 push합니다. 배포 전에 push하면 GitHub에는 아직 없는 기능의 설치 안내가 보입니다.

## 주의

Perplexity 이용 약관의 범위 안에서 **본인 계정으로만** 쓰세요. 세션 파일·키·로그인 프로필은 남에게 넘기거나 공유하지 마세요.

## 라이선스

[MIT](LICENSE)
