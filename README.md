# 그릿마인드랩 문제은행 (Firebase + GitHub Pages)

## 폴더 구성
```
question-bank/
├── index.html          # 관리자 페이지 (로그인 + 목록 + 상세 + 업로드)
├── app.js              # Firebase 연동 로직 (Firestore/Storage/Auth)
├── firebase-config.js  # 본인 Firebase 프로젝트 설정 (직접 채워야 함)
├── firestore.rules     # Firestore 보안 규칙
├── storage.rules       # Storage 보안 규칙 (이미지)
├── seed-questions.json # 수도공고 50문항 초기 데이터
└── README.md
```

## 1. Firebase 준비

기존 NCS-CBT와 같은 Firebase 프로젝트를 재사용해도 되고, 새 프로젝트를 만들어도 됩니다.
(재사용 시 컬렉션 이름만 겹치지 않으면 문제 없음 — 여기서는 `questions` 컬렉션 사용)

1. https://console.firebase.google.com 접속 → 프로젝트 선택(또는 새로 생성)
2. **Firestore Database** 활성화 (프로덕션 모드로 시작해도 됨, 규칙은 아래에서 직접 지정)
3. **Storage** 활성화 (이미지 저장용)
4. **Authentication** → Sign-in method → **이메일/비밀번호** 활성화
5. Authentication → Users → 팀원 계정을 직접 추가 (예: 규비님, 방지혜 대표님 이메일/비밀번호)
   - 회원가입 화면은 따로 만들지 않았습니다. 계정은 콘솔에서 관리자가 추가하는 방식입니다.

## 2. firebase-config.js 채우기

Firebase 콘솔 → 프로젝트 설정(⚙️) → "내 앱" → 웹 앱 설정에서 나오는 값을 그대로 붙여넣으세요.

```js
export const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

## 3. 보안 규칙 배포

Firebase CLI가 있다면:
```bash
npm install -g firebase-tools
firebase login
firebase init firestore storage   # 기존 프로젝트 선택, rules 파일 경로는 이 폴더의 파일 지정
firebase deploy --only firestore:rules,storage:rules
```

CLI 없이 콘솔에서 직접 붙여넣어도 됩니다:
- Firestore → 규칙 탭 → `firestore.rules` 내용 붙여넣고 게시
- Storage → 규칙 탭 → `storage.rules` 내용 붙여넣고 게시

규칙 요지: **로그인한 사용자만 읽기/쓰기 가능**. 예전처럼 test-mode 만료로 막히는 일이 없습니다.

## 4. GitHub Pages에 배포

기존 `gritgyubi.github.io` 저장소를 쓰신다면:
```bash
# 저장소 안에 새 폴더로 추가
cp -r question-bank/ /path/to/gritgyubi.github.io/question-bank
cd /path/to/gritgyubi.github.io
git add question-bank
git commit -m "add question bank admin"
git push
```
그러면 `https://gritgyubi.github.io/question-bank/` 에서 접속 가능합니다.

완전히 새 저장소로 만들고 싶다면, 저장소 설정 → Pages → Branch를 `main`으로 지정하면 됩니다.

## 5. 초기 데이터 가져오기

배포 후 로그인하면 상단에 **"초기 데이터 가져오기"** 버튼이 보입니다.
클릭하면 `seed-questions.json`의 수도공고 50문항이 Firestore에 한 번만 등록됩니다(이미 등록된 ID는 건너뜀).

## 사용법 요약

- **＋ 문제 추가**: 문제 1개씩 입력 (이미지 첨부 가능)
- **일괄 붙여넣기**: 템플릿 복사 → 여러 문제를 `=====` 로 구분해서 붙여넣기 → 분석 → 중복 아닌 것만 일괄 등록
- 문제+지문 유사도가 **70% 이상**이면 자동으로 등록이 막히고, "고도화 버전으로 교체" 또는 "그래도 등록"을 선택
- 목록에서 편집/삭제 가능, 모든 변경은 Firestore를 통해 **팀원 전체에게 실시간 반영**

## 참고 / 한계

- 유사도 검사는 전체 문항을 브라우저로 불러와 계산하는 방식이라, 문항 수가 수천 개 이상으로 많아지면 느려질 수 있습니다. 그 시점엔 서버 사이드(Cloud Functions) 검색으로 옮기는 걸 권장드려요.
- 이미지 업로드는 Firebase Storage 무료 티어 용량(5GB)을 넘지 않도록 주기적으로 확인하시는 게 좋아요.
