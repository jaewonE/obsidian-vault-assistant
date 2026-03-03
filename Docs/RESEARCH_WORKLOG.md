# Research Feature Worklog (v0.6.0)

Date: 2026-03-03  
Repository: `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant`

## 1. Objective

Obsidian plugin에 `/research` 계열 기능(`link`, `links`, `research fast`, `research deep`)을 추가하고, NotebookLM 기반 원격 소스를 로컬 파일 소스와 동일한 UX로 다루되 **원문 콘텐츠는 로컬에 저장하지 않는 정책**을 구현했다.

## 2. Delivered Scope

### 2.1 Slash command and execution

- `/research <arg>`
  - 단일 HTTP URL이면 `link` 처리
  - 단일 URL이 아니면 `research fast` 처리
- `/research links <url...>`
  - 여러 링크 순차 업로드
- `/research deep <query>`
  - deep research 수행
- `/research` 실행 결과는 채팅 메시지 히스토리에 남기지 않고, 별도 research metadata로 저장

### 2.2 Research tracking and import

- `research_start -> research_status polling -> research_import` 파이프라인 구현
- deep mode에서 `task_id` 변동을 추적하고, polling 시 `task_id + query`를 함께 사용
- import 정책:
  - fast: 반환된 인덱스 전체 import
  - deep: `web` + non-empty URL 항목만 import

### 2.3 NotebookLM-only source lifecycle

- 로컬 저장: source metadata만 저장 (`source_id`, title, url, query/report/task 정보)
- 로컬 미저장: source 원문 content
- query 포함 조건:
  - chip이 활성 상태
  - `status=ready`
  - `source_id`가 현재 remote source set에 존재

### 2.4 Source validation/deletion policy

fast/deep import 이후 뿐 아니라 link/links 경로까지 포함해 동일 정책 적용:

- imported source를 즉시 사용하지 않고 `source_get_content` 검증
- 검증 스케줄: `10s -> 20s -> 30s` (총 3회)
- 3회 후에도 `content` empty 이고 `char_count <= 0`이면 unusable로 판단
- unusable source는 사용자 확인 없이 `source_delete` 자동 수행
- 삭제된 source는 query source_ids에서 제외
- 단, 링크 자체는 modal에서 계속 노출하고 브라우저로 이동 가능

## 3. MCP Guide Alignment

## 3.1 link_mcp_guide.md 반영

- YouTube 링크 포함 모든 링크 업로드를 `source_type: "url"`로 처리
  - 기존 youtube-first/fallback 분기를 제거
- `wait: true`로 deterministic add 흐름 유지
- source 유효성 검증은 `source_get_content` 기준으로 수행

## 3.2 research_mcp_guide.md 반영

- deep research에서 mutable `task_id` 추적
- polling에 `query` fallback key 포함
- polling cadence:
  - fast: first `1s`, then `5s`
  - deep: first `2s`, then `20s -> 10s -> 5s` (error backoff 포함)
- 상태 처리: `in_progress`, `completed`, `no_research`, `error`

## 4. UI/UX Changes

### 4.1 Research chips

- 5개 아이콘 분리:
  - link(url), link(youtube), links, research-fast, research-deep
- label 규칙:
  - link: link title
  - links: first link title + `(count)`
  - fast/deep: query + `(count)`
- loading UI:
  - link/fast/deep: circle progress
  - links: circle progress + percent
- loading 중 `x` 클릭:
  - 작업 cancel 아님
  - UI/query scope에서만 제외
- `error/no_research`는 light-red chip으로 표시, source로 사용 불가

### 4.2 Click behavior

- link: default browser로 즉시 오픈
- links/fast: 링크 선택 modal 오픈
- deep: deep report modal 오픈 (`MarkdownRenderer.render`)

### 4.3 Modal UI adjustments

- 상/하 패딩 및 항목 간격 확장
- 실패 링크는 light-red background + border 유지
- title/url은 줄바꿈 대신 ellipsis(`...`) 처리
- 실패 항목의 title은 링크 문자열 대신 상태 메시지 표시
  - `"Failed to fetch source from NotebookLM (openable link)"`

## 5. Root-Cause and Fix Notes (Modal text invisible issue)

문제: 이전 수정 시 일부 테마/버튼 기본 스타일과 결합되어 modal title/url 텍스트가 사실상 보이지 않는 케이스가 발생.

대응:

- 텍스트 영역에 `display`, `width/min-width/max-width`, `overflow`, `text-overflow`, `color`를 명시해 렌더링 안정화
- 실패 item title 생성 로직을 `ChatView.buildResearchLinksModalItems`에서 명시적으로 치환

## 6. Test Summary

### 6.1 Automated

- `npm run build --silent`: pass
- `npm test --silent`: pass (`91/91`)

### 6.2 Manual E2E (NotebookLM)

- 새 Notebook 생성 후 fast research 수행
- query: `Measuring Democratic Backsliding에 대한 논문 조사`
- SSRN 링크가 `source_id`를 받았지만 content empty/char_count 0인 케이스 재현 확인
- 정책대로 `10s -> 20s -> 30s` 검증 후 자동 삭제 확인
- 삭제 후 source list에서 제외됨 확인

## 7. Major Files Updated

- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/plugin/NotebookLMPlugin.ts`
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/plugin/researchTracking.ts`
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/plugin/researchQuery.ts`
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/ui/ChatView.ts`
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/ui/ResearchLinksModal.ts`
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/ui/DeepResearchReportModal.ts`
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/ui/researchCommands.ts`
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/styles.css`
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/storage/PluginDataStore.ts`
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/types.ts`
- tests (`test/plugin/*`, `test/ui/*`, `test/storage/*`)

## 8. Policy State (Current)

- 실패 source는 source id를 query source로 사용하지 않음
- 실패 source가 NotebookLM에 남아있으면 자동 삭제 대상
- modal에서는 실패 링크를 명시(light-red + 상태 메시지)하되 링크 이동 가능
- source 원문은 NotebookLM에만 존재, 로컬에는 metadata만 저장
