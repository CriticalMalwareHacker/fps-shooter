# PulseStrike Arena

Browser multiplayer FPS made with Next.js + Three.js + Firebase Realtime Database.

## Features

- Room codes to create/join matches with friends.
- Real-time position sync, combat hits, kills, deaths, and scoreboard.
- Pointer-lock FPS controls (`WASD`, `Space`, left click).
- Kill feed + respawn loop.
- Deploy-ready on Vercel.

## 1) Firebase Setup

Create a Firebase project and a Realtime Database instance.

1. In Firebase Console, create or select your project.
2. Enable **Realtime Database**.
3. In Project Settings -> General, create a **Web App** and copy config values.
4. Copy `.env.example` to `.env.local` and fill all `NEXT_PUBLIC_FIREBASE_*` values.

### Suggested Realtime Database Rules (prototype)

Use open rules for quick friend testing:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

For production, add auth + stricter room-scoped rules.

## 2) Local Run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## 3) Deploy to Vercel

1. Push this repo to GitHub/GitLab/Bitbucket.
2. Import into Vercel.
3. Add the same `NEXT_PUBLIC_FIREBASE_*` env vars in Vercel Project Settings.
4. Deploy.

Share your deployed URL + room code with friends.

## Controls

- `WASD`: Move
- `Space`: Jump
- `Left Click`: Shoot
- `Esc`: Unlock pointer

## Stack

- Next.js 16 (App Router)
- React 19
- Three.js
- Firebase Realtime Database
