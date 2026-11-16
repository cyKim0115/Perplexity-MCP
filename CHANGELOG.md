# 변경 기록

npm 패키지 [`perplexity-session-mcp`](https://www.npmjs.com/package/perplexity-session-mcp)의 버전별 변경 내용입니다.

## 0.2.0 — 2026-11-16

- `pplx setup` 추가: 이 PC의 MCP 클라이언트(Claude Code·Codex·Cursor·Claude Desktop)를 찾아 서버를 등록하고, 저장된 로그인이 없으면 로그인 창을 엽니다.
  - 이미 등록된 곳은 건드리지 않고, JSON 설정은 고치기 전에 `.bak` 백업을 남깁니다.
  - `--dry-run`으로 바꿀 곳만 미리 보고, `--no-login`으로 로그인을 건너뜁니다.
  - `npx`로 실행해도 `@latest`가 아니라 실행한 버전으로 고정해 등록합니다.
- 로그인이 필요하다는 오류 메시지가 `npm run login` 대신 `pplx login`을 안내합니다.
- README에 터미널 명령 표, `pplx setup`이 바꾸는 파일, 문제 해결, 제거 방법을 추가했습니다.

## 0.1.0 — 2026-11-13

- npm 첫 배포. `npm install -g perplexity-session-mcp`로 설치합니다.
- 어디서든 쓰는 `pplx` 명령(`perplexity-session-mcp`도 같은 명령): `login`·`logout`·`status`·`search`·`research`·`history`·`-v`. 인자 없이 실행하면 MCP 서버(stdio)로 동작합니다.
- 클론에서 `npm link`로 연결하면 TypeScript 소스를 바로 실행하고, npm 패키지는 컴파일된 `dist/`를 실행합니다.
- MCP 서버가 알리는 버전을 package.json에서 읽습니다.
