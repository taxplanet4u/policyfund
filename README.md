# 정책자금 지원사업 매칭센터

기업마당(bizinfo.go.kr) 공공데이터를 활용한 정책자금 지원사업 매칭 랜딩페이지.

- 배포 주소: https://taxplanet4u.github.io/policyfund/
- `index.html` — B안 (공고 매칭형, 메인)
- `a.html` — A안 (한도 자가진단형, A/B 테스트용)

---

## ⚠️ 배포 시 가장 흔한 실수

**`index.html` 하나만 올리면 공고가 하나도 표시되지 않습니다.**

페이지는 공고 목록을 `data/` 폴더의 JSON 파일에서 읽어옵니다.
이 폴더가 없으면 화면에 "공고 데이터 파일을 찾을 수 없습니다(404)" 가 뜨고
조건 검색을 해도 결과가 0건입니다.

배포에 **반드시 포함**되어야 하는 것:

```
index.html                     메인 페이지 (B안)
a.html                         A/B 테스트용 (A안)
.nojekyll                      GitHub Pages의 Jekyll 처리 비활성화
data/programs-initial.json     첫 로드용 공고 100건   ← 없으면 아무것도 안 나옴
data/programs-full.json        전체 공고 약 1,500건   ← 없으면 100건만 나옴
.github/workflows/             매일 자동 갱신 워크플로
scripts/                       공고 수집 스크립트
```

GitHub 웹페이지에서 파일을 끌어다 놓는 방식은 폴더가 누락되기 쉽습니다.
아래 Git 명령으로 **폴더째** 올리세요.

---

## 처음 배포하기

```bash
git init -b main
git add .
git status --short          # .env 가 목록에 없는지 반드시 확인
git commit -m "feat: 정책자금 지원사업 매칭 랜딩페이지"
git remote add origin https://github.com/taxplanet4u/policyfund.git
git push -u origin main --force
```

> `.env` 에는 API 인증키가 들어 있습니다. `.gitignore` 로 제외되어 있지만
> 커밋 전에 `git status` 로 한 번 더 확인하세요.

푸시 후 저장소 설정 3가지:

| 설정 | 경로 | 값 |
|---|---|---|
| 인증키 | Settings → Secrets and variables → Actions | `BIZINFO_KEY` = 발급받은 키 |
| 쓰기 권한 | Settings → Actions → General → Workflow permissions | Read and write permissions |
| 페이지 | Settings → Pages → Source | Deploy from a branch → `main` / `(root)` |

---

## 공고 데이터 갱신

### 자동 (권장)

`.github/workflows/update-bizinfo.yml` 이 **매일 06:00(KST)** 실행되어
공고를 다시 받아 커밋합니다. Actions 탭에서 수동 실행도 가능합니다.

수집 건수가 100건 미만이거나 JSON 이 손상된 경우
**커밋하지 않고 중단**하므로 기존 데이터가 손상되지 않습니다.

### 수동

```bash
node scripts/fetch-bizinfo.mjs        # data/*.json 재생성
git add data && git commit -m "chore(data): 공고 갱신" && git push
```

인증키는 `.env` 파일에 둡니다 (`.env.example` 참고).

```
BIZINFO_KEY=발급받은키
```

주요 옵션:

| 옵션 | 설명 |
|---|---|
| `--probe` | API 응답 구조만 출력 (필드명 확인용) |
| `--split 150` | 첫 로드에 담을 건수 (기본 100) |
| `--field 01` | 특정 분야만 수집 (01 금융 ~ 09 기타) |
| `--dry-file <경로>` | 저장된 응답으로 매핑만 검증 (API 호출 없음) |

---

## 로컬에서 확인하기

**HTML 파일을 더블클릭해서 열면 공고가 표시되지 않습니다.**
브라우저 보안 정책(`file://`)이 같은 폴더의 JSON 읽기를 차단하기 때문입니다.
반드시 웹 서버로 실행하세요.

```bash
npx serve -l 5177 .
```

그 뒤 http://localhost:5177 접속.

---

## 배포 전 교체해야 할 값

`index.html` 과 `a.html` 상단의 `CONFIG` 블록:

```js
endpoint : 'https://formspree.io/f/xojvgggb'   // 리드 수신 엔드포인트
phone    : '010-4481-5821'                     // 표시용 전화번호
phoneTel : '01044815821'                       // tel: 링크용 (숫자만)
kakao    : 'https://pf.kakao.com/_xxxxxxx/chat'
ga4      : ''                                  // GA4 측정 ID
metaPixel: ''                                  // Meta 픽셀 ID
```

`index.html` 의 `CONFIG.company` — 상호·대표·사업자등록번호·주소·이메일
(전자상거래법상 표시 의무 사항입니다. `a.html` 은 푸터에 직접 기재)

공유 미리보기 이미지가 필요하면 `og.png` (1200×630) 를 루트에 추가하세요.

---

## 법적 고지

본 사이트는 경영컨설팅 사업자가 운영하며 **세무사 사무소가 아닙니다.**
세무 대리 업무를 수행하지 않고, 세무사를 소개·알선하지 않으며,
자격사로부터 어떠한 대가도 수수하지 않습니다 (「세무사법」 제2조의2 준수).

공고 정보는 기업마당 공공데이터를 가공한 것으로 당사가 보증하지 않으며,
신청 자격·기간은 소관 기관 공식 공고가 기준입니다.

관련 문구를 수정할 때는 `index.html` 의 `CONFIG` 상단 주석에 있는
**금지 문구 체크리스트**를 먼저 확인하세요.
