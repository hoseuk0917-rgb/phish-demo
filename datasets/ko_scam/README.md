# ko_scam dataset (v1)

한국어 피싱/스캠 **대화 시나리오 골드셋**을 JSONL(1줄=1시나리오)로 관리합니다.  
룰 기반 엔진(점수/리스크/스테이지/트리거)을 **자동 테스트로 회귀 검증**하면서 확장하는 용도입니다.

---

## 원칙(중요)

### 1) 실제 데이터 금지(필수)
- **실제 대화 캡처/원문/개인정보/실제 계좌·전화번호·주소·주민번호·이메일 금지**
- 실존 개인/피해자 식별 가능 요소 금지

### 2) 실제 “수법/흐름” 참고는 허용(권장)
- 보도자료/언론/기관 공지에서 **수법·전개·요구 패턴**을 참고해도 됨
- 단, 문장/표현은 **완전히 새로 작성(복붙/부분 인용 금지)**

### 3) 안전한 더미값 규칙(권장)
- 금액: `12만`, `98,000원`처럼 임의값 사용(현실감 OK)
- 전화번호: `010-0000-0000`, `02-000-0000` 같은 더미만
- 계좌: `000-000-000000` 같은 더미만
- 링크: 원칙적으로 `https://example.com/...` 권장  
  - 단축URL 테스트가 필요하면 `https://t.co/abc123`처럼 **가짜 경로**를 쓰되, 실제 클릭 유도 문구는 최소화

---

## 파일

- `scenarios_ko_v1.jsonl` : 1줄 = 1 시나리오(JSON 객체)
- `schema.json` : JSON Schema(간단 검증/에디터 힌트)
- `README.md` : 작성 규칙/카테고리/운영 규칙

---

## JSONL 작성 규칙

- 한 줄에 JSON 객체 1개만 작성
- 배열([])로 감싸지 않음
- 줄 끝에 쉼표(,) 금지
- UTF-8 저장 권장

---

## 필드

### 최소 필드(권장)
- `id` (string) : 고유 ID (예: `KO-0001`)
- `category` (string) : 카테고리(아래 목록)
- `label` (string) : `low | medium | high` (사람이 보는 라벨)
- `thread` (string) : 대화 본문 (`S:`/`R:` 프리픽스 권장)

### 확장 필드(선택)
- `length_bucket` : `S | M | L`
- `expected` : 자동 테스트 기대값
  - `expected.riskLevel` : `low|medium|high`
  - `expected.score_min` : number(최소 점수)
  - `expected.stage_peak` : `info|verify|install|payment`
- `should_trigger` : 기대 트리거(룰/시그널 id 기반) 예: `["otp","remote","link","transfer"]`
- `callChecks` : 통화/상황 플래그(옵션)
- `notes` : 사람이 보는 메모(배경/참고 수법/의도)

---

## 길이 버킷 기준(권장)

- `S` : 2~4 블록
- `M` : 5~9 블록
- `L` : 10~20+ 블록

> “블록”은 일반적으로 `\n`으로 구분되는 메시지 단위(예: `S: ...`, `R: ...`)를 의미.

---

## 스테이지 정의(권장)

- `info` : 첫 접근/안내/관심 유도(링크만 던지기 포함)
- `verify` : 본인확인/로그인/인증번호/개인정보 요구, 링크 클릭 후 입력 유도
- `install` : 앱 설치/원격제어(AnyDesk/TeamViewer 등)/파일 실행 유도
- `payment` : 송금/결제/수수료/안전계좌/상품권·기프티콘 전송 유도

---

## 데이터셋 구성 규칙(품질/대회용)

- 각 카테고리에서 **S/M/L 길이 골고루**
- 각 카테고리에서 **low/medium/high 섞기**
- `safe_case`(정상)와 `gray_zone`(경계) 비중을 반드시 확보(오탐 억제용)
- “요구(demand) → 수락/이행(comply)” 연쇄가 나타나는 케이스를 일부 포함(맥락 강화용)
- 같은 의미의 변형(오탈자/약어/띄어쓰기)도 점진적으로 추가  
  - 예: `OTP/오티피/인증번호/인증코드`, `팀뷰어/애니데스크/원격`, `송금/이체/입금/결제`

---

## 카테고리(권장 17)

1. `bank_impersonation`
2. `prosecutor_police_impersonation`
3. `delivery_phishing`
4. `government_subsidy`
5. `loan_scam`
6. `card_issue`
7. `account_seizure`
8. `remote_app_install`
9. `otp_takeover`
10. `family_emergency`
11. `romance_investment`
12. `job_highpay_abroad`
13. `gifticon_market`
14. `invoice_tax`
15. `service_account`
16. `safe_case`
17. `gray_zone`

---

## 자동 테스트(권장)

- 목표: `expected`(risk/score_min/stage_peak)와 `should_trigger` 충족 여부를 회귀 검증
- 실행 예시(프로젝트 스크립트 기준):
  - `npm run test:dataset`
  - `npm run test:dataset:quick`

---

## 편집 추천

- VS Code/Cursor 권장(UTF-8, JSONL 라인별 편집/검색 편함)
- 줄 길이가 길어도 “한 줄=한 JSON” 원칙 유지
