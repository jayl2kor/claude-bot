# CI/CD Patterns

## GitHub Actions 워크플로우 설계
- PR 시: lint + type-check + unit test + build
- 머지 시: full test suite + coverage report + deploy
- 스케줄: 일일 보안 스캔, 주간 의존성 업데이트 체크

## 워크플로우 구조
```yaml
name: CI
on:
  pull_request:
    branches: [main, master]
  push:
    branches: [main, master]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps: ...
  test:
    runs-on: ubuntu-latest
    needs: lint
    steps: ...
  build:
    runs-on: ubuntu-latest
    needs: test
    steps: ...
```

## Docker 빌드 최적화
- Multi-stage build로 이미지 크기 최소화
- Layer caching 활용 (package.json 먼저 복사)
- BuildKit 캐시 마운트 사용

## 배포 전략
- Blue-green: 무중단 배포
- Canary: 점진적 롤아웃
- Rollback: 이전 이미지 태그로 즉시 복구

## 이슈 생성 시 포함할 정보
- 어떤 CI/CD 파이프라인을 추가/수정하는지
- 트리거 조건 (on push, on PR, schedule)
- 필요한 secrets (GitHub Secrets에 등록할 것)
- 예상 실행 시간
