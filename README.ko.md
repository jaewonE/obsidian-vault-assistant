# Obsidian Vault Assistant

[ [English](https://github.com/jaewonE/obsidian-vault-assistant) | [한국어](https://github.com/jaewonE/obsidian-vault-assistant/blob/master/README.ko.md) ]

Version: `0.11.1`

Obsidian Desktop 커뮤니티 플러그인으로, 전역 설치된 `notebooklm-mcp-cli` 실행 파일을 통해 Google NotebookLM과 연동합니다.

- `notebooklm-mcp`: MCP 서버
- `nlm`: 로그인 및 진단용 CLI

이 플러그인은 오른쪽 사이드바 채팅 워크플로를 제공합니다.

1. Vault 노트에 대한 선택적 BM25 검색
2. `@` / `@@` / `$`를 통한 선택적 명시 소스 지정
3. NotebookLM 소스 준비, 업로드, 재사용
4. 제한된 소스 범위로 NotebookLM 질의
5. 후속 질의를 위한 대화 및 소스 메타데이터 저장

## 기능

- 오른쪽 사이드바 채팅 뷰
- 사용자 질문 말풍선 및 Markdown으로 렌더링되는 NotebookLM 답변
- 각 질문과 답변의 복사 아이콘으로 원문 메시지 텍스트를 클립보드에 복사
- NotebookLM 답변의 인용문은 클릭할 수 있습니다. 해석 가능한 각 `[N]` 또는 묶음 `[N,M,...]` 인용문은 source ID와 NotebookLM이 반환한 인용 구절을 보존하며, 이미지·문서·검색 아이콘과 함께 각 대응 소스를 새 탭으로 엽니다.
- 검색 소스 인용문은 저장된 URL을 Obsidian 내장 Web viewer에서 엽니다.
- 질문 처리용 검색 -> 업로드 -> 응답 3단계 진행 상태 UI
- Anki 생성용 소스 선택 -> 업로드 -> 카드 생성 -> Anki 동기화 4단계 진행 상태 UI
- 질의 처리 중에도 입력, mention 검색, chip 조작, `Search vault` 토글 사용 가능
- composer에서 명시 소스 선택:
  - `@`: Markdown 파일/경로 검색
  - `@@`: 모든 파일/경로 검색
  - 입력 중 실시간 검색, 키보드/마우스 선택, 공백 및 underscore-to-space 검색 지원
  - 선택한 파일/경로는 선택 직후 순차 업로드 시작
- composer에서 YAML 계층 문서 선택:
  - `$`를 입력하면 `@`와 동일한 Markdown 문서 목록을 검색
  - 문서를 선택하면 선택 문서와, 설정한 YAML 속성으로 해당 문서를 부모로 연결한 모든 하위 문서를 단계별로 포함
  - `parents: ["[[Kafka]]"]` 같은 wikilink 문자열 또는 목록을 지원하며, frontmatter나 설정한 속성이 없는 문서는 제외
  - 순환 및 중복 연결이 있어도 각 문서는 한 번만 추가
  - 문서 제한값은 선택 문서를 포함한 전체 추가 문서 수에 적용되며 `-1`은 모든 하위 문서를 포함
  - YAML 속성 설정이 비어 있거나 선택 문서에 해당 속성이 없으면 선택을 추가하지 않음
- composer slash command 자동완성:
  - `/source`, `/create`, `/setting`, `/research`, `/anki`
  - `/source add`, `/source get`, `/research links`, `/research deep`, `/anki flashcards`, `/anki quiz`
- `/Anki` 명령 실행(명령 원문과 한국어 성공/실패 요약을 채팅 기록에 추가):
  - `/Anki flashcards`: 현재 composer source chip만 대상으로 한국어 플래시카드를 생성한 뒤 Anki `Basic(Front, Back)` 노트로 업로드하고 검증
  - `/Anki quiz`: 현재 composer source chip만 대상으로 한국어 객관식 퀴즈 카드를 생성한 뒤 Anki `Basic(Front, Back)` 노트로 업로드하고 검증
  - 로컬 `@` / `@@` / `$` chip은 생성 전에 준비하며, 활성 research chip도 현재 소스로 포함
  - NotebookLM artifact 생성 전에 AnkiConnect를 검사하고, 실패 내용은 Obsidian 개발자 콘솔과 알림에 함께 표시하며 실패한 진행 단계에도 오류 상세를 유지
  - artifact 종류 뒤에 선택 인자를 공백으로 구분해 붙일 수 있고, 작은따옴표/큰따옴표로 묶인 값은 하나의 문자열로 처리(예: `/Anki quiz deck="hello world"`)
    - `max-counts=<양의 정수>`(기본 `30`): `max-count`, `count`, `counts`도 별칭으로 허용
    - `anki-deck=<덱 이름>`(`deck` 별칭): 이 전체 Anki 덱 이름을 직접 사용
    - `deck-root=<상위 덱>`(`root` 별칭): 생성된 덱 이름을 해당 상위 덱의 child deck으로 생성
    - `invalid-source-ratio=<0..1 또는 백분율>`(기본 `0.01`): 이 비율보다 적은 stale source ID만 무시
  - `max-counts`는 상한입니다. 생성 시 이 수에 최대한 가깝게 만들도록 지시하지만, 소스 근거·범위·비반복성이 억지로 수를 채우는 것보다 우선합니다. quiz에는 같은 값이 `--count`로도 전달됩니다.
  - key 없는 숫자 한 개는 `max-counts`, 문자열 한 개는 `deck-root`, 숫자 하나와 문자열 하나는 순서와 관계없이 둘 다로 해석합니다. 그 밖의 개수/형태인 단순 값은 무시합니다.
  - 알 수 없는 인자는 무시합니다. 명시형 `key=value`는 단순 값보다 우선하며, 같은 옵션의 명시형 값이 여러 개면 별칭 여부와 관계없이 마지막 값을 사용합니다.
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
- 질의 timeout은 질의와 소스 업로드/교체 흐름에 적용됩니다. 플러그인 시작 시 NotebookLM MCP 작업은 백그라운드로 시작하며, 별도 15초 요청 제한을 사용하므로 Obsidian의 플러그인 로드 완료를 지연시키지 않습니다.
- `/Anki flashcards`와 `/Anki quiz`는 일반 질의 timeout과 별개로 NotebookLM artifact 생성을 최대 10분까지 기다립니다. studio 생성은 일반 질문 응답보다 오래 걸릴 수 있습니다.
- 저장된 NotebookLM notebook ID가 더 이상 존재하지 않으면 readiness 단계에서 새 notebook을 생성하고 저장합니다.

## 요구사항

- Obsidian Desktop 1.8.0 이상(인용된 검색 소스를 열기 위한 내장 Web viewer 포함)
- Node.js 18+
- 전역 설치된 `notebooklm-mcp-cli`(Obsidian GUI의 `PATH`에 없더라도 pipx 기본 경로인 `~/.local/bin`을 함께 탐색)
- Anki Desktop 앱, 활성화된 AnkiConnect 애드온, 그리고 `Front`, `Back` 필드만 가진 표준 `Basic` 노트 타입

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
6. 필요하면 전송 전에 `@` / `@@`로 명시 소스를 추가하거나 `$`로 YAML 문서 트리를 추가합니다.
7. 필요하면 `/` command 자동완성(`/source`, `/create`, `/setting`, `/research`, `/anki` 및 하위 명령)을 사용합니다.
8. `/research` 명령으로 NotebookLM-only 소스를 준비합니다.
9. 현재 source chip을 하나 이상 선택한 뒤 `/Anki flashcards` 또는 `/Anki quiz`를 실행해 Anki 카드를 생성하고 검증합니다. History에는 입력한 명령 원문과 소스·카드 수·덱 결과 요약이 남습니다. 예: `/Anki flashcards count=30 deck=root`, `/Anki quiz "Study Deck" 10`.
10. composer 위 chip을 유지하거나 제거해 후속 질의의 source scope를 제어합니다.
11. `Search vault` 토글로 BM25 포함 여부를 제어합니다.
12. 답변의 이미지·문서·검색 `[N]` 또는 `[N,M,...]` 인용문을 클릭하면 대응 소스를 새 탭으로 엽니다. 묶음 인용문에서는 각 번호를 독립적으로 클릭할 수 있습니다. 검색 인용문은 **Web viewer** 코어 플러그인을 활성화해야 합니다.

## 명령과 Hotkeys

- `Open NotebookLM chat`

기본 hotkey는 지정하지 않습니다. 사용자는 Obsidian **Settings -> Hotkeys**에서 단축키를 직접 지정할 수 있습니다.

## 설정

- `Debug mode`
- `Refresh Auth`
- Hierarchical source selection:
  - `Enable $ hierarchical selection` (기본값: enabled)
  - `YAML parent property` (기본값: 빈 문자열, 한 단어만 허용). 입력 완료 시 추가 단어를 제거하고 경고를 표시합니다.
  - `Hierarchical document limit` (기본값: `-1`). 선택 문서를 포함한 전체 문서 수를 제한하며 `-1`은 모든 하위 문서를 포함합니다.
- BM25 parameters:
  - `Top N`
  - `cutoff ratio`
  - `min K`
  - `k1`
  - `b`
- `Query timeout (seconds)` (default `300`)

## Privacy and Network Access

- 이 플러그인은 NotebookLM 연동을 위해 로컬에서 실행되는 `notebooklm-mcp-cli` 및 Google NotebookLM에 네트워크 요청을 사용합니다. Anki 업로드는 로컬 AnkiConnect 엔드포인트 `http://127.0.0.1:8765`에만 전송됩니다.
- vault 외부 파일을 읽지 않습니다.
- 플러그인 설정, 대화 기록, 소스 메타데이터는 Obsidian 플러그인 데이터(`data.json`)에 저장됩니다. 여기에는 인용 번호와 source ID의 매핑 및 NotebookLM이 반환한 인용 구절도 포함됩니다.
- raw research source content는 명시적으로 가져오지 않는 한 로컬에 저장하지 않습니다.

## Desktop support

이 플러그인은 `notebooklm-mcp-cli` 실행 파일, NotebookLM Desktop 연동 흐름, 로컬 AnkiConnect 서비스 및 검색 인용문용 Obsidian 데스크톱 Web viewer에 의존하므로 `isDesktopOnly`가 `true`입니다.

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
- `src/plugin/ExplicitSourceSelectionService.ts`: `@` / `@@` / `$` 검색 및 selection
- `src/plugin/hierarchicalSelection.ts`: YAML 부모 링크 graph expansion, 순환 및 제한 처리
- `src/plugin/SourcePreparationService.ts`: source upload/reuse/replace/eviction service
- `src/plugin/explicitSelectionMerge.ts`: BM25 + explicit merge utilities
- `src/plugin/historySourceIds.ts`: bounded history source carry-over logic
- `src/mcp/NotebookLMMcpClient.ts`: MCP subprocess/client wrapper
- `src/anki/`: 독립된 NotebookLM artifact 계획/생성 및 AnkiConnect import service
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

Anki 업로드 연결 실패:

1. Anki Desktop을 열고 AnkiConnect 애드온을 활성화합니다.
2. `Basic` 노트 타입이 정확히 `Front`, `Back` 필드만 가지는지 확인합니다.

## License

0-BSD
