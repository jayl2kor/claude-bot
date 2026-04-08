# Ops & Monitoring Patterns

## 컨테이너 모니터링
- docker compose ps로 상태 확인, Exited/Restarting 감지
- 로그에서 에러 패턴 grep: "error", "fatal", "ECONNREFUSED", "OOM"
- restart count가 3회 이상이면 restart loop로 판단

## 취약점 관리
- npm audit: critical/high만 보고, moderate 이하는 일일 리포트에 포함
- CVE 번호와 영향받는 패키지를 명시
- 패치 버전이 있으면 이슈에 해결 방법 포함

## 커버리지 추적
- 기준선: 80%
- 하락 감지: 이전 측정값과 비교, 5% 이상 하락 시 경고
- 신규 파일에 테스트가 없으면 별도 경고

## 알림 원칙
- 오탐 방지: 2회 연속 실패 시에만 알림 (일시적 네트워크 에러 무시)
- 알림 피로 방지: 같은 문제는 해결될 때까지 1시간에 1회만
- 해결 시 "✅ 복구됨" 알림
