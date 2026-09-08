# T3 검토 반영 인계 기록

> 최종 상태: **이번 T3 보완 A–F 및 필수 로컬 회귀 검증 완료**.
> 실제 30분 A 종료 0, 최종 ID 정합 성공. 커밋/푸시/브랜치 조작 없음.
> 최종 증거 요약: `sender/outbox-data/t3-followup-20260908/final-evidence.json`.

## 인수 기준 (2026-09-08)

- 작업 루트: `/Users/ljm/Desktop/logStack`; 브랜치 `main`.
- HEAD: `258629cf59592caf34d2509036106ff2b2ea76de` (origin/main보다 3커밋 앞).
- staged 없음. 기존 수정: `.gitignore`, `AGENTS.md`, `docs/decisions.md`,
  `package.json`, `scripts/generate-events.ts`, `scripts/send-events.ts`, `tsconfig.build.json`.
- `sender/` 전체는 기존 untracked 구현. 작성자는 단정하지 않는다.
- 인수 지문/변경 목록: `sender/outbox-data/t3-followup-20260908/baseline.json`.
  이 ignored 경로 아래에 이번 실행 로그를 보존한다.
- 기존 Claude PID 56374와 자식 56389/56390 확인: 자식은 bkit MCP 서버이며
  sender/통합/소크 실행이 아니다. 기존 프로젝트 sender/소크 실행은 발견되지 않았다.
- 기존 Docker receiver(3000) 및 PostgreSQL(5432)은 유지한다. 이번 검증은
  loopback PostgreSQL에 새 `sender_int_*` DB, 별도 receiver 포트/outbox/log/dist 복사본을 사용한다.
  공유 `gamelogs` DB 초기화, 컨테이너 정지 및 볼륨 삭제는 하지 않는다.
- 사용자 요청의 이번 한정 구현 예외를 적용했다. Claude backend-developer 정의는
  읽어 참고했으며 Codex에 등록/호출했다고 주장하지 않는다. 규칙 파일은 수정하지 않는다.

## 인수 시 A–F 분류

| 항목 | 상태 | 근거 및 남은 작업 |
| --- | --- | --- |
| A 공용 스크립트 회귀 | 구현됨·미검증 | 공용 ACK/배칭 변경 존재, 최종 seed/demo 증거 없음 |
| B ID 집합 검증 | 부분 완료 | A는 컴팩션 시 집합 검증 생략, D/E도 저널 의존 |
| C 경고 제한 | 부분 완료 | 단일 시각 제한은 있으나 첫 발생/사유별 경계 테스트 없음 |
| D 실패 ID 상한 | 미착수 | 무제한 Set, 폴백은 미구현 한계 주석뿐 |
| E 고정 창 설명 | 부분 완료 | 재시작 횟수 조건 없는 2배 주장, 429와 무유실 혼동 |
| F 최종 30분 | 미검증 | 실제 최종 코드 30분 완료 증거 없음 |

## 이번 보완 (최종 검증 완료)

- `sender/src/failed-journal.ts`, `outbox.ts`: 캐시 기본 100,000개. 초과 후 miss는
  실패 저널을 동기 순차 조회한다. 재시작에도 상한 적용. 파일 전체 readFile/배열/
  대체 무제한 Set 없이 64KiB 블록과 한 JSON 라인만 유지한다. tail 복구도 역방향 블록 읽기.
  캐시 밖 조회 O(저널 바이트), 재시작 고유 수의 정확한 복원은 overflow prefix 재조회로
  최악 O(N²) I/O다. 초대형 실패 저널에서는 느리며 단일 작성자 전제다.
  쓰기/fsync 실패 후 캐시 불확실 상태에서는 추가 격리를 거부하고 재개방을 요구한다.
  격리 fsync 후 체크포인트 전진 순서는 유지한다.
- `log-gate.ts`, `daemon.ts`: 유한한 사유 키에 초당 1회 경고 제한. 첫 발생은 즉시 출력.
  backpressure 임계치/생성 중지/재시도 정책은 변경하지 않는다.
- `sender/test/integration/observed-daemon.ts`: 테스트 전용 관측자. 실제 append+fsync
  반환 후 기대 ID를 별도 파일에 기록/fsync한다. DB/ACK로 기대 집합을 만들지 않는다.
  이 관측 경로의 실패는 테스트 실패이며 SIGKILL 원자성 증명으로 쓰지 않는다.
  B는 기존의 SIGKILL 직후 비변경 raw journal 캡처를 유지한다.
- `identity.ts`, 통합 하네스: A/D/E에서 G=D∪F, D∩F=∅, raw/unique 중복,
  missing/unexpected/overlap을 확인한다. 정상 시나리오 F=0, pending=0도 필수다.
  컴팩션 생략 경로를 제거했다. 생성 시도와 기록 성공/미기록을 별도로 기록한다.
- `throttle.ts` 주석 및 `design-aws.md` §4: sender/receiver는 각 Date.now의 epoch
  60초 정렬 창이다. 정상 시계·단일 sender 조건에서 재시작 없음은 창당 L,
  같은 창 k회 재시작은 (k+1)L. 재시작 횟수 무제한이면 120회 상한은 없다.
  429 복구와 sender 한도 준수/최종 무유실 검증은 별개다. 알고리즘은 변경하지 않았다.

## 공용 스크립트 변경 보고 정정

인수 diff에서 `scripts/send-events.ts`는 +153/-22이며 **export 추가만이 아니다**.
실제 요청 envelope/쉼표 포함 바이트 계산, serializeBatch 공용화, ACK 파싱/검증의
단일 구현화가 포함된다. sendEvents는 seed/demo에서 호출되며 sender ACK 모듈도
같은 검증기를 사용한다. 기존 batch_id/카운트 불변식 외에 정수·비음수·실제 전송
건수·rejected 배열 길이/index 중복·범위/event_id 및 오류 항목 형태까지 검사한다.
공용 스크립트는 검증 실패 시 예외를 던져 호출을 실패시키고, 데몬은 재전송으로 처리한다.
이번에는 공용 스크립트 파일을 재수정하지 않았다. seed/demo 실측은 아래에 후속 기록한다.

## 실행 기록 (중간)

- 초기 sender 단위: 84개 중 79 성공/5 실패, 종료 1. 신규 오류 주입 테스트에서
  namespace import의 재정의 불가 속성에 spy를 적용한 테스트 구현 문제였다.
  파일 시스템 기본 import로 수정했으며 기대값/기존 픽스처는 변경하지 않았다.
- 초기 타입 검사: 통과. 초기 lint: 신규 테스트 파일 2건 실패(변수 const/정규식 공백).
  해당 허용 파일만 명시적으로 수정. 자동 --fix는 사용하지 않았다.
- 위 초기 실패는 수정 후 재검증했다. 최종 통과 결과는 아래와 같다.

## 완료한 회귀 검증

최종 코드(실행 중 소스 지문 불변) 회귀 묶음: `run-SICLVm/run.jsonl`,
2026-09-08 12:32:06–12:32:27 UTC. 명령별 원본 로그는 같은 디렉터리에 있다.

| 명령 | 실제 결과 | 종료 코드 |
| --- | --- | --- |
| `npm run lint` | 성공, --fix 없음 | 0 |
| `npm run build` | 성공 | 0 |
| `npm run sender:test` | 12 스위트, 87 성공 / 0 실패 / 0 skip | 0 |
| `npm test -- --runInBand` | 3 스위트, 12 성공 / 0 실패 / 0 skip | 0 |
| `node node_modules/typescript/bin/tsc --noEmit --incremental false` | sender 포함 타입 검사 성공 | 0 |
| `npm run test:e2e` | 별도 신규 임시 DB, 4 스위트, 50 성공 / 0 실패 / 0 skip | 0 |

sender 별도 lint/build 명령은 package.json에 없으므로 루트 lint 및 전체 noEmit
타입 검사로 포함했다. 루트 build의 기존 sender 제외 설정은 수정하지 않았다.

### seed/demo 공용 스크립트 실측

`npm run sender:integration -- seed-demo`가 신규 DB 생성+기존 마이그레이션 적용 후
그 DB의 전용 receiver에 `npm run seed` → `npm run demo`를 실제 실행했다.
기존 공유 DB에는 DELETE/TRUNCATE를 수행하지 않았다.

- 증거: `run-FCrfuK/{run.jsonl,seed.log,demo.log,code-hashes.json}`.
- 2026-09-08 12:30:51–12:30:52 UTC, 두 명령 및 하네스 모두 종료 0.
- seed: received 12, accepted 12, stored **11**, duplicate **1**, rejected **0**.
- demo: 재적재 stored 0, duplicate 12, rejected 0. 원래 기대값으로 DAU,
  매출/ARPU, 결제 전환율, 리텐션, 참여율 **5종 PASS** (추가 적재 불변식도 PASS).
- 이 실행 후 테스트 하네스/회귀 단언만 보강했다. seed/demo 및 공용 스크립트,
  서버 소스는 같은 지문이며 이 최종 공용 코드의 실제 실행 증거를 재사용한다.

### 단기 A 예비 점검 (30분 대체 아님)

`A_DURATION_MS=5000 npm run sender:integration -- a`, `run-GCFeL6/run.jsonl`.
실제 생성 5,003ms, G raw/unique 60/60, D 60/60, F 0/0,
missing/unexpected/overlap 모두 0, 최종 pending 0, 최대 적체 18건, 종료 0.
30분 판정에는 사용하지 않는다.

### C 완료

`npm run sender:integration -- c`, `run-HwJjVk/run.jsonl`, 종료 0.
사전 적재 5,000건 모두 저장, 500건 × 10배치, startup drain **357ms**.
병행 신규 생성 포함 G/D raw 및 unique 각각 **5,056**, F=0, 집합 정합,
최종 pending=0. 최대 적체는 원본 stats 기준 **5,000건**이다.
생성 중지 직후 18건은 별도 drain으로 소화했다.
두 정렬 창을 걸쳐 실행돼 창별 최대 요청은 8회였다.
§2.2의 4,500건/9배치(1 req/s면 9초)와 같은 배치 계산이다. 여기서는 시작
잔량 5,000건/10배치를 고정 창 60슬롯 안에서 응답 순차로 즉시 처리하므로
1초 간격을 강제하는 10초 계산보다 짧다. AWS 실측으로 해석하지 않는다.

### B/D/E 완료

모두 `npm run sender:integration -- <b|d|e>`로 기본 실제 대기 시간을 적용했다.
실행별 소스 지문 불변, 하네스 종료 0. 각 임시 DB는 판정 후 해당 DB만 정리했다.
원본 outbox/기대 ID/로그는 유지한다.

| 시나리오 | G/D (각 raw=unique) | F / missing / unexpected / overlap / 최종 pending | 최대 적체 | 복구·drain 실측 | 증거 |
| --- | ---: | --- | ---: | --- | --- |
| B SIGKILL 후 재시작 | 591 / 591 | 모두 0 | 591건 | 재시작 후 drain 406ms | `run-uwOV9u/run.jsonl` |
| D receiver 60초 정지 | 1,269 / 1,269 | 모두 0 | 956건 | health 회복 후 1,933ms에 pending≤30 | `run-AfI0T3/run.jsonl` |
| E 서버 10회/분, 429 | 1,429 / 1,429 | 모두 0 | 546건 | 최종 drain 320ms | `run-UiC034/run.jsonl` |

- B는 강제 종료 직후 복구 코드 실행 전 raw journal에서 완전 라인 591개를 캡처.
  DB는 당시 0건, 불완전 tail 없음. 재시작에서는 생성 비활성화, 같은 591 ID 복구.
- D: 생성 시도=기록 성공 1,269, 미기록 0. outage 중 관측값 870건,
  전체 실행 최대 적체 956건. `recovery_ms_after_up`는 신규 생성 병행하므로
  pending≤30을 정상 수준으로 정의한다. 생성 중지 시 13건은 최종 drain 후 0.
- E: 생성 시도=기록 성공 1,429, 미기록 0. 429 2회 발생. 첫 Retry-After 36초에
  다음 실제 요청 시작까지 **36,126ms**(jitter 포함)를 확인했다. 두 번째 대기 중
  생성/프로세스 종료로 다음 전송이 없어 대기 완료 비교 대상은 1회다. 종료 후
  동일 임시 DB의 receiver 한도를 120으로 복원해 남은 546건을 별도 drain했다.
  최초 sender의 정렬 창별 최대 요청 11회로 자체 한도 60 이내다.
- 최대 적체는 이벤트 수다. daemon은 매 성공 append 시 `max_pending`을 갱신하고
  5초 stats 및 최종 stop stats로 출력하므로 단순 5초 순간 샘플의 최댓값이 아니다.

## F 실제 30분 소크

`A_DURATION_MS=1800000 npm run sender:integration -- a` 실제 실행을 완료했다.
해당 run 디렉터리의 `run.jsonl`에는 PID/시각/30초 진행 상태/
최종 결과/종료 코드, `code-hashes.json`에는 실행 소스 지문을 저장한다.
시작 전에 별도 receiver 빌드 복사본을 만들며 실행 중 소스/build는 수정하지 않는다.
최종 수치와 정확한 실행 경로는 다음과 같다.

- 실행 디렉터리: `sender/outbox-data/t3-followup-20260908/run-RAw1eE/`.
- 하네스 PID 93649 (실행 핸들 54304), receiver PID 93678/포트 58266,
  sender PID 93682. 별도 DB `sender_int_a_93649_dc3813f572`.
- outbox/원본 로그: `run-RAw1eE/outbox-a-JzuDuZ/daemon-93682.jsonl`.
- sender 생성 시작: `2026-09-08T12:35:57.790Z`; 설정 1,800,000ms.
- 진행 확인: `tail -n 3 sender/outbox-data/t3-followup-20260908/run-RAw1eE/run.jsonl`.
  종료 0 및 `source_unchanged: true` 확인. 2026-09-08 13:06 UTC 후속 확인에서
  이번 시나리오 PID는 모두 종료됐고 `sender_int_*` 임시 DB 잔여도 0이었다.

### A 실제 30분 실측

| 항목 | 실제 결과 |
| --- | --- |
| 생성 시작 (UTC) | 2026-09-08 12:35:57.790 |
| 생성 종료 (UTC) | 2026-09-08 13:05:57.798 |
| 실제 생성 가동 | **1,800,008ms** (설정 1,800,000ms) |
| 진행 중 응답 처리 및 sender 종료 | 13:05:57.842 UTC |
| 최종 drain 완료 관측 시각 | 13:05:57.962 UTC |
| 생성 시도 / 기록 성공 / 미기록 | **27,205 / 27,205 / 0** |
| G 기록 성공 raw / unique | **27,205 / 27,205** |
| D game_events 원본 raw / unique | **27,205 / 27,205** |
| F 내구성 실패 저널 raw / unique | **0 / 0** |
| G = D ∪ F, D ∩ F = ∅ | **성공** |
| missing / unexpected / overlap | **0 / 0 / 0** (원본 결과 배열 모두 비어 있음) |
| 유실 / 최종 미확정 outbox | **0 / 0** |
| 최대 적체 | **34 이벤트** |
| 생성 중지·응답 처리 후 잔량 / 추가 drain | **0건 / 0ms** (drain-only 프로세스 불필요) |
| 전송 요청 / 확인 배치 | **1,479 / 1,479** |
| 정렬 고정 창의 실제 최대 요청 | **50회** (설정 60회 이내) |
| 재시도 / 429 / rejected | **0 / 0 / 0** |
| 컴팩션 누적 제거 | **23,410건**, 집합 검증 생략 없음 |
| 종료 상태 / 실행 중 소스 지문 | **0 / 불변** |

생성 총건수는 기존 `generated` 의미인 append+fsync 성공 건수다. 이번에 추가한
`generation_attempted`도 같았고 미기록 0이었다. G는 DB/ACK가 아닌 성공 경로의
별도 `recorded-ids.txt`이며, `identity-result.json`에 raw/unique 및 차집합 판정을
보존했다. 테스트 관측자의 추가 fsync 비용을 포함한 로컬 결과이며 AWS 실측이 아니다.
최대 적체는 매 append 시 갱신한 누적 최댓값(200ms 생성 틱, 5초 및 종료 stats 출력)이다.
마지막 정상 배치 처리로 잔량이 이미 0이어서 추가 drain 시간은 0ms이며,
생성 종료부터 sender 종료까지의 44ms와 혼동하지 않는다.

단기 실행 합산이나 10분 환산을 쓰지 않았다. 동일 프로세스의 연속 가동과 30초
진행 로그, 시작/종료 시각 및 종료 코드로 실제 30분을 확인했다.

## 범위 점검 (최종)

2026-09-08 12:36:39 UTC 인수 지문 비교: src/ 39파일 변경 0.
이번에 수정한 기존 파일은 sender의 daemon/outbox/throttle/daemon-ack 테스트/
통합 run 및 docs/design-aws.md뿐이다. 신규 파일은 failed-journal/log-gate 및
관련 sender 테스트/관측 하네스/identity 검증, 이 보고서다.
인수 때 이미 수정된 루트 규칙·설정·scripts·ADR은 이번 작업에서 건드리지 않았다.

최종 인수 지문 비교에서도 **src/ 39파일 신규 변경 0**, 루트 test/·infra/·규칙·
package/lock·API·가정·ADR 신규 변경 0이다. `git diff --check` 성공(출력 없음),
staged 없음, main/HEAD는 인수 때와 동일하다.

최종 git 상태의 tracked diff는 8파일 +190/-34지만 이 중 대부분은 인수 당시
변경이다. git diff에 잡히지 않는 기존 untracked sender/도 지문 비교에 포함했다.
이번 차이는 기존 파일 6개 및 신규 파일 8개로, 상세 목록은 final-evidence.json에 있다.
기존 수정 6개: `sender/src/{daemon,outbox,throttle}.ts`,
`sender/test/daemon-ack.spec.ts`, `sender/test/integration/run.ts`, `docs/design-aws.md`.
신규 8개: 이 보고서, `sender/src/{failed-journal,log-gate}.ts`,
`sender/test/{failed-cache,identity,log-gate}.spec.ts`,
`sender/test/integration/{identity,observed-daemon}.ts`.

## 잔여 상태 / 재현 명령

- 이번 요청의 필수 미검증/미해결 항목 없음. 실패 캐시 폴백의 최악 O(N²) 재시작 I/O,
  단일 작성자 전제, 고정 창/재시작 버스트 한계는 위에 명시한 운영 제한이다.
- 이번 테스트가 만든 receiver/sender/하네스는 모두 종료. 생성한 임시 DB만 정리했으며
  해당 DB 데이터 자체는 삭제됐다. 원본 outbox/기대 ID/판정/명령 로그는 ignored 경로에
  보존했다. 기존 `logstack-app-1`(3000), `logstack-db-1`(5432, healthy)는 유지됐다.
- 원래 있던 Claude/bkit 프로세스는 임의 종료하지 않았다. AWS/T4/infra 실행 없음.
- 이어서 해야 할 필수 명령은 없다. 별도 재검증이 필요할 때만 아래 명령을 사용한다
  (실행 전 같은 프로젝트의 활성 테스트가 없는지 확인; 로컬 PostgreSQL 필요).

```sh
npm run sender:integration -- regression
npm run sender:integration -- seed-demo
npm run sender:integration -- b
npm run sender:integration -- c
npm run sender:integration -- d
npm run sender:integration -- e
A_DURATION_MS=1800000 npm run sender:integration -- a
```

첫 명령은 비수정 lint/build/sender 단위/서버 단위/타입 검사 및 새 임시 DB의 서버 e2e를
실행한다. 이후 각 명령도 새 DB·포트·outbox·로그·빌드 복사본으로 격리하며 정상 종료 시
자기 임시 DB만 정리한다. `git commit`/push 및 브랜치 생성·전환은 수행하지 않았다.
