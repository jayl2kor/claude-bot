---
name: add-pet
description: Add a new pet to the claude-pet system. Creates config files, env file, and updates docker-compose.yml.
user_invocable: true
---

# Add Pet

새 펫을 claude-pet 시스템에 추가합니다.

## Usage

```
/add-pet <pet-id> [display-name]
```

- `pet-id`: 영문 소문자 (docker service name, directory name으로 사용)
- `display-name`: 한글 이름 (persona.yaml의 name 필드). 생략하면 pet-id 사용.

## Steps

### 1. Validate Input

- pet-id가 영문 소문자+숫자+하이픈만 포함하는지 확인
- `config/{pet-id}/` 디렉토리가 이미 존재하면 에러

### 2. Create Config Directory

`config/seed/` 템플릿을 복사하고 플레이스홀더를 치환:

```bash
cp -r config/seed config/{pet-id}
```

치환할 플레이스홀더:
- `{{PET_ID}}` -> pet-id
- `{{PET_DISPLAY_NAME}}` -> display-name

파일별로 `sed` 또는 Edit 도구로 치환:
- `config/{pet-id}/persona.yaml`
- `config/{pet-id}/knowledge.md`

### 3. Create .env File

`.env.{pet-id}` 파일 생성:

```
DISCORD_BOT_TOKEN=<TODO: Discord Bot Token을 여기에 입력>

WORKSPACE_PATH=/Users/user/git/claude
```

### 4. Update docker-compose.yml

`docker-compose.yml`에 새 서비스와 볼륨 추가.

#### Service (services 섹션에 추가)

기존 패턴을 따라:

```yaml
  {pet-id}:
    <<: *pet-base
    env_file: .env.{pet-id}
    volumes:
      - ./config/{pet-id}:/app/config/{pet-id}:ro
      - {pet-id}-data:/app/data/{pet-id}
      - {pet-id}-workspace:/workspace
      - shared-tasks:/app/data/shared/tasks
      - shared-status:/app/data/shared/status
      - ${CLAUDE_AUTH_PATH:-${HOME}/.claude}:/root/.claude
    command: ["--pet", "{pet-id}"]
```

#### Volumes (volumes 섹션에 추가)

```yaml
  {pet-id}-data:
  {pet-id}-workspace:
```

### 5. Update Existing Pets' Knowledge (Optional)

사용자에게 물어보기: 기존 펫들의 `knowledge.md`에 새 펫 정보를 추가할지.

추가할 경우 각 기존 펫의 `config/{existing-pet}/knowledge.md`의 "서로 부르는 법" 섹션에 새 펫 멘션 방법 추가.

### 6. Summary

완료 후 출력:
- 생성된 파일 목록
- TODO 항목:
  1. `.env.{pet-id}`에 Discord Bot Token 설정
  2. (선택) `config/{pet-id}/persona.yaml`에서 성격 커스터마이징
  3. (선택) `config/{pet-id}/knowledge.md`에서 다른 펫 관계 추가
  4. `docker compose up -d {pet-id}` 로 시작
