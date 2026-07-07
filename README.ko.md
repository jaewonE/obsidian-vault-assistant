# Obsidian Vault Assistant

[ [English](https://github.com/jaewonE/obsidian-vault-assistant) | [한국어](https://github.com/jaewonE/obsidian-vault-assistant/blob/master/README.ko.md) ]

Version: `0.7.0`

Obsidian Desktop 커뮤니티 플러그인으로, 전역 설치된 `notebooklm-mcp-cli` 실행 파일을 통해 Google NotebookLM과 연동합니다.

- `notebooklm-mcp`: MCP 서버
- `nlm`: 로그인 및 진단용 CLI

이 플러그인은 오른쪽 사이드바 채팅 워크플로를 제공합니다.

1. Vault 노트에 대한 선택적 BM25 검색
2. `@` / `@@`를 통한 선택적 명시 소스 지정
3. NotebookLM 소스 준비, 업로드, 재사용
4. 제한된 소스 범위로 NotebookLM 질의
5. 후속 질의를 위한 대화 및 소스 메타데이터 저장

## 기능

- 오른쪽 사이드바 채팅 뷰
- 사용자 질문 말풍선 및 Markdown으로 렌더링되는 NotebookLM 답변
- 각 질문과 답변의 복사 아이콘으로 원문 메시지 텍스트를 클립보드에 복사
- 검색 -> 업로드 -> 응답 3단계 진행 상태 UI
- 질의 처리 중에도 입력, mention 검색, chip 조작, `Search vault` 토글 사용 가능
- composer에서 명시 소스 선택:
  - `@`: Markdown 파일/경로 검색
  - `@@`: 모든 파일/경로 검색
  - 입력 중 실시간 검색, 키보드/마우스 선택, 공백 및 underscore-to-space 검색 지원
  - 선택한 파일/경로는 선택 직후 순차 업로드 시작
- composer slash command 자동완성:
  - `/source`, `/create`, `/setting`, `/research`
  - `/source add`, `/source get`, `/research links`, `/research deep`
- `/research` 명령 실행:
  - URL 또는 YouTube 링크를 NotebookLM 소스로 추가
  - 여러 링크를 순차 추가
  - 빠른 research 또는 deep research 실행
  - NotebookLM 소스 ID, 제목, URL, 질의/리포트 메타데이터 저장
- research chip 및 assistant 소스 목록 클릭 동작:
  - 단일 link는 기본 브라우저로 열기
  - 여러 link 및 빠른 research는 선택 모달 열기
  - deep research는 Markdown 리포트 모달 열기
- 확장자 인식 소스 업로드:
  - `.md`, `.txt`: text source
  - 허용된 비텍스트/미디어 확장자: file source
  - 허용되지 않는 확장자는 안내 후 제외
- `Search vault` composer 토글:
  - 기본값 enabled
  - `data.json`에 저장
  - enabled: BM25 + 명시 선택
  - disabled: 명시 선택 + 대화에서 이어진 소스만 사용
- 같은 탭/세션의 후속 질문에서 소스 재사용
- `New`로 새 대화 컨텍스트 시작
- `History` 모달로 이전 대화 불러오기

## Timeout behavior

- `Query timeout (seconds)` 기본값은 `300`입니다.
- 이 설정은 NotebookLM 질의 인자와 MCP 요청 timeout에 사용됩니다.
- timeout 처리는 질의, 소스 업로드/교체, 시작 시 notebook readiness 호출에 적용됩니다.
- 저장된 NotebookLM notebook ID가 더 이상 존재하지 않으면 readiness 단계에서 새 notebook을 생성하고 저장합니다.

## 요구사항

- Obsidian Desktop
- Node.js 18+
- 전역 설치된 `notebooklm-mcp-cli`

설치 예시:

```bash
pip install notebooklm-mcp-cli
# or
uv tool install notebooklm-mcp-cli
# or
pipx install notebooklm-mcp-cli
```

사용 전 NotebookLM 인증을 완료합니다.

```bash
nlm login
nlm login --check
```

## 사용법

1. 플러그인을 빌드합니다.
2. `main.js`, `manifest.json`, `styles.css`를 `<Vault>/.obsidian/plugins/obsidian-vault-assistant/`에 복사합니다.
3. Obsidian **Settings -> Community plugins**에서 플러그인을 활성화합니다.
4. `Open NotebookLM chat` 명령을 실행합니다.
5. 오른쪽 사이드바 채팅 뷰에서 질문합니다.
6. 필요하면 전송 전에 `@` / `@@`로 명시 소스를 추가합니다.
7. 필요하면 `/` command 자동완성을 사용합니다.
8. `/research` 명령으로 NotebookLM-only 소스를 준비합니다.
9. composer 위 chip을 유지하거나 제거해 후속 질의의 source scope를 제어합니다.
10. `Search vault` 토글로 BM25 포함 여부를 제어합니다.

## 명령과 Hotkeys

- `Open NotebookLM chat`

기본 hotkey는 지정하지 않습니다. 사용자는 Obsidian **Settings -> Hotkeys**에서 단축키를 직접 지정할 수 있습니다.

## 설정

- `Debug mode`
- `Refresh Auth`
- BM25 parameters:
  - `Top N`
  - `cutoff ratio`
  - `min K`
  - `k1`
  - `b`
- `Query timeout (seconds)` (default `300`)

## Privacy and Network Access

- 이 플러그인은 NotebookLM 연동을 위해 로컬에서 실행되는 `notebooklm-mcp-cli` 및 Google NotebookLM에 네트워크 요청을 사용합니다.
- vault 외부 파일을 읽지 않습니다.
- 플러그인 설정, 대화 기록, 소스 메타데이터는 Obsidian 플러그인 데이터(`data.json`)에 저장됩니다.
- raw research source content는 명시적으로 가져오지 않는 한 로컬에 저장하지 않습니다.

## Desktop support

이 플러그인은 `notebooklm-mcp-cli` 실행 파일과 NotebookLM Desktop 연동 흐름에 의존하므로 `isDesktopOnly`가 `true`입니다.

## 개발

의존성 설치:

```bash
npm install
```

watch build:

```bash
npm run dev
```

production build:

```bash
npm run build
```

tests:

```bash
npm test
```

## 저장소 구조

- `src/main.ts`: 최소 entrypoint
- `src/plugin/NotebookLMPlugin.ts`: plugin lifecycle 및 orchestration
- `src/plugin/ExplicitSourceSelectionService.ts`: `@` / `@@` 검색 및 path expansion
- `src/plugin/SourcePreparationService.ts`: source upload/reuse/replace/eviction service
- `src/plugin/explicitSelectionMerge.ts`: BM25 + explicit merge utilities
- `src/plugin/historySourceIds.ts`: bounded history source carry-over logic
- `src/mcp/NotebookLMMcpClient.ts`: MCP subprocess/client wrapper
- `src/search/BM25.ts`: BM25 indexing/search
- `src/storage/PluginDataStore.ts`: settings/history/source registry 저장
- `src/ui/`: chat view, mention parser, history modal, settings tab

## 알고리즘 문서

- `Docs/BM25_NOTEBOOKLM_ALGORITHMS.md`
- `Docs/BM25_NOTEBOOKLM_PIPELINE.md`

## 문제 해결

`notebooklm-mcp` 또는 `nlm`을 찾을 수 없는 경우:

```bash
which notebooklm-mcp
which nlm
```

인증 문제:

```bash
nlm login
nlm login --check
```

일반 진단:

```bash
nlm doctor --verbose
```

## License

0-BSD
