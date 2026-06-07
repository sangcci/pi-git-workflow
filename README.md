# pi-git-workflow

`pi-git-workflow`는 Pi에서 작업할 때 Git 상태를 계속 보고, 위험한 Git 작업을 한 번 더 멈춰 세우고, 커밋 전 점검을 쉽게 하려고 만든 확장입니다.

코딩 워크플로를 새로 만드는 도구라기보다는, 작업 중인 Git 상태를 실시간으로 추적하고 관리하는 편의 도구에 가깝습니다. 에이전트가 파일을 고친 뒤에 working tree가 어떻게 바뀌었는지, 지금 체크를 돌려야 하는지, 커밋하기 전에 히스토리를 정리해야 하는지 같은 판단을 돕습니다.

특히 에이전트와 긴 세션으로 작업할 때는 Git 상태를 놓치기 쉽습니다. 파일이 조금씩 쌓이다 보면 어느 순간 diff가 커지고, 커밋하려고 보니 서로 다른 변경이 섞여 있는 경우가 생깁니다. 이 확장은 그 지점에서 바로 커밋을 만들어 버리지 않고, 먼저 상태를 보여주고 다음 행동을 고르게 합니다.

본 extension은 gpt-5.5 model + pi agent와 함께 만들었습니다.

## 하는 일

이 확장이 하는 일은 크게 이 정도입니다.

- 현재 브랜치, dirty 파일 수, diff stat, 최근 커밋을 확인합니다.
- 에이전트에게 짧은 Git 문맥을 주입합니다.
- 위험한 Git 명령을 감지해서 막거나 확인을 받습니다.
- 작업이 끝난 뒤 dirty 상태를 보고 decision UI를 띄웁니다.
- 작업 장부를 `.pi/moonpi/git-task.md`에 기록합니다.
- 체크 명령을 실행합니다.
- commitlint로 커밋 메시지 초안을 검증할 수 있게 합니다.
- 커밋 전에 현재 상태가 준비됐는지 보여줍니다.
- 최근 커밋과 diff를 보고 히스토리 정리가 필요한지 검토합니다.

하지 않는 일도 분명합니다.

- 커밋을 자동으로 만들지 않습니다.
- PR 같은 외부 작업을 자동으로 만들지 않습니다.
- 히스토리를 자동으로 고치지 않습니다.
- force push를 자동으로 하지 않습니다.
- 모든 저장소에 하나의 규칙을 강제하지 않습니다.
- 프로젝트의 test/lint 도구를 대체하지 않습니다.

## 설치와 실행

이 확장은 Pi package 형식입니다. 저장소를 clone한 뒤 `pi install`로 설치하면 됩니다.

```bash
git clone https://github.com/sangcci/pi-git-workflow.git
cd pi-git-workflow
pi install .
```

설치가 끝나면 Pi 설정에 package가 등록되고, 이후 Pi를 실행할 때 자동으로 로드됩니다. 설치된 package 목록은 다음 명령으로 확인할 수 있습니다.

```bash
pi list
```

더 이상 쓰지 않을 때는 remove로 빼면 됩니다.

```bash
pi remove ./pi-git-workflow
```

Pi는 이 저장소의 `package.json`에 있는 extension entry를 읽어서 확장을 로드합니다.

```json
{
  "pi": {
    "extensions": ["./extensions/git-workflow/index.ts"]
  }
}
```

(optional) moonpi extension과 같이 사용하는 것을 권장합니다. moonpi는 coding agent에 필요한 기능들만 넣어놓은 minimal extension입니다.

```bash
pi install npm:moonpi
pi install .
```


## 저장소 모드
처음 Git 저장소에서 실행하면 저장소 모드를 고르게 됩니다. 선택한 값은 `.pi/git-workflow.json`에 저장됩니다. 이후부터는 이 설정을 기준으로 Git context 주입, 위험 명령 보호, 체크 실행, 작업 장부 기록이 동작합니다.

저장소별 설정은 아래 파일에 저장됩니다.

```text
.pi/git-workflow.json
```

처음 실행했을 때 UI가 있으면 저장소 모드를 고릅니다.

- `direct`
  - 기본 브랜치에서도 작업을 허용합니다.
  - 위험한 Git 명령은 계속 확인합니다.
  - 개인 도구, dotfiles, 메모 저장소처럼 main에서 바로 작업하는 곳에 맞습니다.

- `branch`
  - 기능 브랜치나 worktree 사용을 전제로 합니다.
  - 기본 브랜치에서 파일 수정이나 repository 변경 명령을 막습니다.
  - 팀 저장소나 PR 기반 저장소에 맞습니다.

- `observe`
  - Git 상태와 최근 커밋 스타일만 주입합니다.
  - 워크플로를 강하게 강제하지 않습니다.
  - Git 인지만 필요할 때 씁니다.

- `disabled`
  - 이 저장소에서는 확장이 아무것도 하지 않습니다.

설정 예시)

```json
{
  "mode": "direct",
  "protectDestructiveGit": true,
  "protectDefaultBranchWrites": false,
  "requireChecksBeforeCommit": true,
  "taskLedger": true,
  "checks": []
}
```

`checks`를 비워 두면 `package.json`에서 자주 쓰는 script를 찾아 실행합니다.

## Git 문맥 주입

에이전트가 작업을 시작하기 전에 확장은 짧은 Git 문맥을 system prompt 뒤에 붙입니다.

포함되는 내용은 다음과 같습니다.

- 현재 브랜치
- 기본 브랜치 추정값
- 기본 브랜치에서 작업 중인지 여부
- dirty 파일 수
- `git status --short`
- `git diff --stat`
- 최근 커밋 10개
- 작업 장부 존재 여부

이 문맥은 에이전트가 지금 저장소 상태를 잊지 않게 하려는 용도입니다. 최근 커밋 스타일을 보고 커밋 메시지 톤을 맞추거나, 현재 diff가 너무 커졌는지 알아차리는 데 도움이 됩니다.

다만 이 확장이 코딩 방식까지 지시하려고 하지는 않습니다. moonpi와 같이 쓸 때도 moonpi의 Plan/Act 지시가 우선이고, Git 문맥은 어디까지나 상태 정보에 가깝게 유지하는 쪽을 지향합니다.

## 작업 뒤 decision UI

작업이 끝났고 working tree에 변경이 있으면, 확장이 다음 행동을 고르는 UI를 띄웁니다.

현재 선택지는 다음과 같습니다.

- `Record task state only`
  - 현재 Git 상태를 작업 장부에 기록합니다.
  - 체크나 커밋 준비는 하지 않습니다.

- `Run checks`
  - 설정된 체크나 package.json에서 추론한 체크를 실행합니다.
  - 결과를 작업 장부에 기록합니다.

- `Prepare commit`
  - 커밋 가능한 상태인지 점검합니다.
  - 브랜치 정책, 작업 장부, 체크 결과, 최근 커밋 스타일, diff stat을 보여줍니다.
  - 준비 상태가 통과하면 모델에게 커밋 계획과 메시지 초안 작성을 넘길지 묻습니다.
  - 추가 메시지를 입력해 커밋 초안에 반영할 수도 있습니다.
  - 실제 커밋은 사용자 확인 없이 만들지 않습니다.

- `Review history cleanup`
  - 최근 커밋과 현재 diff를 읽기 전용으로 보여줍니다.
  - amend나 squash가 필요해 보이는지 판단하는 데 도움을 줍니다.
  - rebase, reset, amend 같은 명령은 실행하지 않습니다.

- `Continue coding`
  - 아무 기록도 확정하지 않고 다음 작업을 계속합니다.

- `Ignore for now`
  - 같은 dirty 상태에 대해 이번 세션에서는 다시 묻지 않습니다.

같은 상태에서 계속 물어보면 귀찮기 때문에, branch/status/diff stat으로 fingerprint를 만들고 이미 처리했거나 무시한 상태는 다시 묻지 않습니다.

## task.md

해야할 일 리스트는 `.pi` 내부에 위치합니다.

```text
.pi/moonpi/git-task.md
```

이 파일은 TODO를 대체하지 않습니다. 현재 세션의 TODO는 moonpi가 관리하고, 이 파일은 Git 작업 기록을 남기는 용도입니다. 긴 세션이 compaction되거나 나중에 다시 열렸을 때 “이 변경이 왜 생겼고, 어떤 커밋 후보였는지”를 보기 위한 기록에 가깝습니다.

장부에는 이런 내용이 들어갑니다.

- 현재 목표
- 변경 파일
- diff stat
- 체크 결과
- 커밋 계획
- 열린 질문
- 상태

명령은 다음과 같습니다.

```text
/git-task init <title>
/git-task status
/git-task update
/git-task done
```

`/git-task update`는 현재 Git 상태를 읽어서 변경 파일과 커밋 후보를 다시 씁니다. 목적은 한 diff 안에 관련 없는 작업이 너무 많이 섞이지 않게 하는 것입니다.

## 체크 실행

`/git-checks`는 설정된 체크를 실행합니다.

`.pi/git-workflow.json`에 `checks`가 있으면 그 명령을 순서대로 실행합니다. 없으면 `package.json`에서 다음 script를 찾아 실행합니다.

```text
lint
typecheck
test
format:check
check
commitlint
lint:commit
commit:lint
commitlint:check
```

처음 실패한 명령에서 멈춥니다. 작업 장부가 켜져 있으면 결과를 `.pi/moonpi/git-task.md`에 기록합니다.

## commitlint 처리

commitlint는 일반 체크와 조금 다릅니다. lint나 test는 코드만 있으면 실행할 수 있지만, commitlint는 보통 커밋 메시지가 있어야 제대로 검증할 수 있습니다.

그래서 두 가지 흐름을 둡니다.

첫 번째는 `/git-checks`입니다. 프로젝트에 `commitlint`, `lint:commit`, `commit:lint`, `commitlint:check` 같은 script가 있으면 일반 체크 목록에 포함해서 실행합니다. 이 방식은 프로젝트 script가 알아서 메시지 파일이나 기본 입력을 처리하는 경우에 맞습니다.

두 번째는 커밋 메시지 초안 검증입니다.

```text
/git-commitlint-draft "feat(scope): message"
```

이 명령은 package.json에서 commitlint 계열 script를 찾고, 메시지 초안을 stdin으로 넘겨 검증합니다. 실패하면 출력된 에러를 보여줍니다.

중요한 점은 이 확장이 커밋 규칙을 새로 만들지 않는다는 것입니다. commitlint 설정이 없으면 최근 커밋 스타일을 보여줄 수는 있어도, 규칙을 강제로 만들어내지는 않습니다.

## 커밋 준비

`/git-commit-ready`는 커밋을 만들기 전에 현재 상태를 정리해서 보여주는 명령입니다.

확인하는 내용은 다음과 같습니다.

- working tree에 변경이 있는지
- 브랜치 정책을 만족하는지
- 작업 장부가 필요한 모드에서 장부가 있는지
- 설정된 체크가 통과했는지
- 최근 커밋 스타일은 어떤지
- 현재 diff stat은 어떤지

이 명령은 준비 상태를 먼저 보여줍니다. 준비 상태가 통과하면 모델에게 현재 diff, 변경 파일, 최근 커밋 스타일을 넘겨 커밋 계획과 메시지 초안을 작성하게 할 수 있습니다. 모델은 그대로 커밋하지 않고, 파일 그룹과 메시지를 제안한 뒤 사용자 확인을 받아야 합니다.

## 히스토리 검토

`/git-history-review`는 최근 커밋과 현재 diff를 보고 히스토리 정리가 필요한지 판단하는 명령입니다.

보여주는 내용은 다음과 같습니다.

- 현재 브랜치
- dirty 파일 수
- cleanup threshold 상태
- 최근 커밋
- unstaged diff stat
- staged diff stat
- 변경된 파일 목록
- amend/squash/fixup/rework 관련 안내

현재는 최근 커밋이 5개 이상 보이거나, `fixup!`, `squash!`, `wip` 같은 커밋 메시지가 있으면 review를 권장하는 식으로 단순하게 판단합니다.

이 명령은 읽기 전용입니다. rebase, reset, amend, push를 실행하지 않습니다. 그런 작업은 사용자가 직접 요청하고, 위험을 확인한 뒤에만 실행되어야 합니다.

## 위험한 Git 명령 보호

확장은 `bash` tool로 실행되는 Git 명령 중 위험한 명령을 감지합니다.

확인 대상 예시는 다음과 같습니다.

- `git reset --hard`
- 이전 커밋으로 되돌리는 `git reset`
- 강제 삭제가 들어간 `git clean`
- `git push --force`, `git push -f`, `--force-with-lease`
- `git branch -d`, `git branch -D`
- `git rebase`
- `git commit --amend`
- 강제 `git checkout`, `git switch`
- worktree 파일을 되돌리는 `git restore`

위험한 명령은 UI가 있으면 확인을 묻습니다. UI가 없는 환경에서는 안전하게 막습니다.

`branch` 모드에서는 기본 브랜치에서 repository를 변경하는 Git 명령도 막습니다. 예를 들면 `git add`, `git commit`, `git merge`, `git pull`, `git cherry-pick`, `git revert`, `git stash pop` 같은 명령입니다.

또한 `branch` 모드에서 기본 브랜치에 있을 때 `write`나 `edit` 같은 파일 변경 tool도 확인 대상이 됩니다.

## 명령 목록

```text
/git-workflow-status
```

현재 확장이 에이전트에게 주입하는 Git 문맥을 보여줍니다.

```text
/git-checks
```

설정된 체크나 package.json에서 추론한 체크를 실행합니다.

```text
/git-history-review
```

최근 커밋과 현재 diff를 읽기 전용으로 검토합니다.

```text
/git-commit-ready
```

커밋 전에 브랜치 정책, 변경 상태, 체크 결과, 최근 커밋 스타일을 확인합니다.

```text
/git-commitlint-draft "feat(scope): message"
```

커밋 메시지 초안을 commitlint 계열 script로 검증합니다.

```text
/git-task init <title>
/git-task status
/git-task update
/git-task done
```

`.pi/moonpi/git-task.md` 작업 장부를 관리합니다.

## 추천 흐름

혼자 쓸 때도, 팀 저장소에서 쓸 때도 기본 흐름은 비슷합니다.

```text
# code with pi or moonpi
# 작업 뒤 decision UI에서 필요한 선택
/git-checks
/git-history-review
/git-commit-ready
/git-commitlint-draft "feat(scope): message"
```

moonpi를 같이 쓰면 조금 더 자연스럽습니다. moonpi가 작업 단계를 나눠 주고, 이 확장이 작업 뒤 Git 상태를 정리해 주는 식으로 역할이 나뉩니다.

## 하지 않는 일

이 확장은 일부러 하지 않는 일이 있습니다.

- 커밋을 자동으로 만들지 않습니다.
- PR 같은 외부 작업을 자동으로 만들지 않습니다.
- force push나 히스토리 재작성을 자동으로 하지 않습니다.
- 모든 저장소에 하나의 규칙을 강제하지 않습니다.
- 프로젝트의 test/lint 도구를 대체하지 않습니다.

Git workflow는 팀마다 다르고, 개인 저장소에서도 상황마다 다릅니다. 그래서 이 확장은 정답을 하나로 고정하기보다, 안전하게 멈추고 확인할 지점을 만들어 두는 쪽을 택합니다.
