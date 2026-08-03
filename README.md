# SER9 Web DApp

Monad Mainnet(`chainId=143`)용 SER9 스테이킹 DApp입니다.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

- 모바일/외부 지갑 연결이 필요하면 `.env`에 `VITE_WALLETCONNECT_PROJECT_ID`를 설정하세요.

## Build

```bash
npm run build
npm run preview
```

## Node.js 실행

```bash
npm run build
npm run start
```

- 기본 포트: `4173`
- 포트 변경: `PORT=8080 npm run start`

## Features

- 지갑 연결(브라우저 지갑, 선택적 WalletConnect) / 네트워크 전환 안내
- 사용자 기능: 스테이킹, 보상 청구
- 국문/영문 전환

## 관련 레포

- [SERIES9](https://github.com/PIXELZX0/SERIES9) — SER9 토큰 + 스테이킹 컨트랙트
- [SERIES9Identity](https://github.com/PIXELZX0/SERIES9Identity) — Identity NFT + 지갑 컨트랙트
- [SERIES9DEX](https://github.com/PIXELZX0/SERIES9DEX) — DEX 컨트랙트

`src/contracts/abi/`의 ABI는 위 컨트랙트 레포의 릴리즈 산출물에서 갱신합니다.
