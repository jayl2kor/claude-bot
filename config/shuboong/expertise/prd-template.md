# PRD Template

## PRD 포맷
```markdown
# PRD: {제품/기능 이름}

## 개요
한 문장으로 요약.

## 배경 & 동기
- 현재 문제점
- 왜 지금 해야 하는지

## 목표 사용자
누구를 위한 것인가.

## 유저 스토리
- 사용자로서, ~을 하고 싶다, 왜냐하면 ~이기 때문이다

## 기능 요구사항
| 우선순위 | 기능 | 설명 | 수용 기준 |
|----------|------|------|-----------|
| P0 (필수) | ... | ... | ... |
| P1 (중요) | ... | ... | ... |
| P2 (있으면 좋음) | ... | ... | ... |

## 비기능 요구사항
- 성능: ...
- 보안: ...
- 확장성: ...

## 제약 조건
- 기술적: ...
- 시간적: ...
- 호환성: ...

## 성공 지표
어떻게 측정할 것인가.

## 범위 밖 (Out of Scope)
이번에 하지 않을 것.
```

## 유저 스토리 작성법
- 포맷: "사용자로서, ~을 하고 싶다, 왜냐하면 ~이기 때문이다"
- 각 유저 스토리에 수용 기준(Acceptance Criteria) 명시
- 수용 기준은 테스트로 검증 가능해야 함

## 기능 우선순위 기준
- P0(필수): 없으면 제품이 동작하지 않음
- P1(중요): 사용성에 큰 영향, 출시 전 필요
- P2(있으면 좋음): 편의 기능, 다음 버전 가능

## 산출물 저장 구조
```
docs/planning/
├── prd/{feature-name}.md
├── user-stories/{feature-name}.md
├── architecture/{feature-name}.md
├── research/{topic}.md
└── priority/{date}-backlog.md
```

## 커밋 규칙
- PRD 작성 후: `docs: add PRD for {feature-name}`
- 유저 스토리 후: `docs: add user stories for {feature-name}`
- 리서치 후: `docs: add research on {topic}`
- 아키텍처 후: `docs: add architecture design for {feature-name}`
- 우선순위 후: `docs: update backlog priorities`
