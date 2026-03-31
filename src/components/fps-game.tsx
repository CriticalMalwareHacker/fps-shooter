"use client";

import {
  DataSnapshot,
  DatabaseReference,
  get,
  limitToLast,
  onChildAdded,
  onDisconnect,
  onValue,
  push,
  query,
  ref,
  remove,
  set,
  update,
} from "firebase/database";
import NextImage from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { canInitializeFirebase, getMissingFirebaseEnv, getRealtimeDatabase } from "@/lib/firebase";

type MatchPhase = "menu" | "connecting" | "playing" | "error";
type Team = "blue" | "red";
type TeamPreference = Team | "auto";

type PlayerSnapshot = {
  id: string;
  name: string;
  team: Team;
  color: string;
  faceTexture: string | null;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  hp: number;
  kills: number;
  deaths: number;
  respawnUntil: number | null;
  updatedAt: number;
};

type HitEvent = {
  type: "hit";
  from: string;
  to: string;
  damage: number;
  fromName: string;
  toName: string;
  at: number;
};

type KillEvent = {
  type: "kill";
  from: string;
  to: string;
  fromName: string;
  toName: string;
  at: number;
};

type RoomEvent = HitEvent | KillEvent;

type LocalPlayerState = {
  position: THREE.Vector3;
  yaw: number;
  pitch: number;
  hp: number;
  kills: number;
  deaths: number;
  respawnUntil: number | null;
};

type Session = {
  roomId: string;
  playerId: string;
  playerName: string;
  team: Team;
  localRef: DatabaseReference;
  eventsRef: DatabaseReference;
  joinedAt: number;
  writeLocal: (patch: Partial<PlayerSnapshot>) => void;
  sendHit: (targetId: string, targetName: string, damage: number) => Promise<void>;
  sendKill: (targetId: string, targetName: string) => Promise<void>;
  close: () => Promise<void>;
};

type KillFeedEntry = {
  id: string;
  text: string;
};

type Obstacle = {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
};

type WalkSurface = {
  x: number;
  z: number;
  w: number;
  d: number;
  top: number;
};

type HitZone = "head" | "body";

type RemoteAvatar = {
  group: THREE.Group;
  body: THREE.Mesh;
  faceDecal: THREE.Mesh;
  hpFill: THREE.Mesh;
  gunMount: THREE.Group;
  targetPosition: THREE.Vector3;
  targetYaw: number;
  appliedFaceTexture: string | null;
};

type ShotTracer = {
  line: THREE.Line;
  expiresAt: number;
};

const ARENA_LIMIT = 58;
const PLAYER_EYE_HEIGHT = 1.7;
const PLAYER_RADIUS = 0.45;
const PLAYER_SPEED = 8.3;
const SPRINT_SPEED = 10.8;
const SLIDE_SPEED = 14.2;
const SLIDE_DURATION_SECONDS = 0.45;
const MAX_STEP_UP = 1.12;
const GRAVITY = 24;
const JUMP_FORCE = 8.8;
const SHOOT_COOLDOWN_MS = 170;
const RESPAWN_MS = 3000;
const NETWORK_TICK_MS = 60;
const LOOK_SENSITIVITY = 0.002;
const TRACER_DURATION_MS = 110;
const FACE_TEXTURE_SIZE = 160;
const MAX_FACE_DATA_URL_LENGTH = 820_000;

const TEAM_COLORS: Record<Team, string> = {
  blue: "#3ea7ff",
  red: "#ff5f66",
};

const TEAM_SPAWN_POINTS: Record<Team, THREE.Vector3[]> = {
  blue: [
    new THREE.Vector3(-50, PLAYER_EYE_HEIGHT, -46),
    new THREE.Vector3(-40, PLAYER_EYE_HEIGHT, -36),
    new THREE.Vector3(-47, PLAYER_EYE_HEIGHT, -24),
  ],
  red: [
    new THREE.Vector3(50, PLAYER_EYE_HEIGHT, 46),
    new THREE.Vector3(40, PLAYER_EYE_HEIGHT, 36),
    new THREE.Vector3(47, PLAYER_EYE_HEIGHT, 24),
  ],
};

const NEUTRAL_SPAWN_POINTS = [
  new THREE.Vector3(-32, PLAYER_EYE_HEIGHT, -24),
  new THREE.Vector3(30, PLAYER_EYE_HEIGHT, -20),
  new THREE.Vector3(-24, PLAYER_EYE_HEIGHT, 32),
  new THREE.Vector3(-44, PLAYER_EYE_HEIGHT, -36),
  new THREE.Vector3(42, PLAYER_EYE_HEIGHT, -38),
];

const BLOCKERS: Obstacle[] = [
  { x: 0, z: 0, w: 16, d: 3, h: 3.5 },
  { x: -16, z: 14, w: 4, d: 18, h: 4.2 },
  { x: 16, z: -14, w: 4, d: 18, h: 4.2 },
  { x: 20, z: 20, w: 8, d: 8, h: 4.8 },
  { x: -22, z: -18, w: 12, d: 5, h: 2.8 },
  { x: 5, z: -28, w: 7, d: 7, h: 3.8 },
  { x: -40, z: 30, w: 2.2, d: 2.2, h: 18 },
  { x: -30, z: 30, w: 2.2, d: 2.2, h: 18 },
  { x: -40, z: 40, w: 2.2, d: 2.2, h: 18 },
  { x: -30, z: 40, w: 2.2, d: 2.2, h: 18 },
  { x: 30, z: 26, w: 18, d: 8, h: 6.5 },
  { x: 30, z: 42, w: 18, d: 8, h: 6.5 },
];

const WALK_SURFACES: WalkSurface[] = [
  { x: -35, z: 35, w: 13, d: 13, top: 8 },
  { x: -35, z: 35, w: 7, d: 7, top: 14 },
  { x: 30, z: 26, w: 18, d: 8, top: 6.5 },
  { x: 30, z: 42, w: 18, d: 8, top: 6.5 },
];

const TOWER_STEPS: WalkSurface[] = [
  { x: -27.5, z: 20.5, w: 3.5, d: 3.2, top: 1.1 },
  { x: -28.5, z: 23.5, w: 3.5, d: 3.2, top: 2.2 },
  { x: -29.5, z: 26.5, w: 3.5, d: 3.2, top: 3.3 },
  { x: -30.5, z: 29.5, w: 3.5, d: 3.2, top: 4.4 },
  { x: -31.5, z: 32.5, w: 3.5, d: 3.2, top: 5.5 },
  { x: -32.5, z: 35.5, w: 3.5, d: 3.2, top: 6.6 },
  { x: -33.5, z: 38.5, w: 3.5, d: 3.2, top: 7.7 },
];

function safeNumber(input: unknown, fallback: number): number {
  return typeof input === "number" && Number.isFinite(input) ? input : fallback;
}

function sanitizeRoom(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function sanitizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, 16);
}

function generateRoomCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getOrCreatePlayerId(): string {
  const storageKey = "pulse-strike-player-id";
  const existing = window.localStorage.getItem(storageKey);
  if (existing) {
    return existing;
  }

  const newId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(storageKey, newId);
  return newId;
}

function getTeamColor(team: Team): string {
  return TEAM_COLORS[team];
}

function isTeam(input: unknown): input is Team {
  return input === "blue" || input === "red";
}

function pickTeam(
  preference: TeamPreference,
  players: Record<string, PlayerSnapshot>,
): Team {
  if (preference === "blue" || preference === "red") {
    return preference;
  }

  let blueCount = 0;
  let redCount = 0;
  for (const player of Object.values(players)) {
    if (player.team === "blue") blueCount += 1;
    if (player.team === "red") redCount += 1;
  }

  return blueCount <= redCount ? "blue" : "red";
}

function randomSpawnPoint(team: Team): THREE.Vector3 {
  const points = TEAM_SPAWN_POINTS[team] ?? NEUTRAL_SPAWN_POINTS;
  const base = points[Math.floor(Math.random() * points.length)];
  const spread = 2.8;
  return new THREE.Vector3(
    base.x + (Math.random() * 2 - 1) * spread,
    PLAYER_EYE_HEIGHT,
    base.z + (Math.random() * 2 - 1) * spread,
  );
}

function getEvent(snapshot: DataSnapshot): RoomEvent | null {
  const payload = snapshot.val() as Partial<RoomEvent> | null;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (
    payload.type === "hit" &&
    typeof payload.from === "string" &&
    typeof payload.to === "string"
  ) {
    return {
      type: "hit",
      from: payload.from,
      to: payload.to,
      fromName: typeof payload.fromName === "string" ? payload.fromName : "Unknown",
      toName: typeof payload.toName === "string" ? payload.toName : "Unknown",
      damage: Math.min(100, Math.max(1, safeNumber(payload.damage, 30))),
      at: safeNumber(payload.at, Date.now()),
    };
  }

  if (
    payload.type === "kill" &&
    typeof payload.from === "string" &&
    typeof payload.to === "string"
  ) {
    return {
      type: "kill",
      from: payload.from,
      to: payload.to,
      fromName: typeof payload.fromName === "string" ? payload.fromName : "Unknown",
      toName: typeof payload.toName === "string" ? payload.toName : "Unknown",
      at: safeNumber(payload.at, Date.now()),
    };
  }

  return null;
}

function readPlayers(snapshot: DataSnapshot): Record<string, PlayerSnapshot> {
  const raw = snapshot.val() as Record<string, Partial<PlayerSnapshot>> | null;
  if (!raw) {
    return {};
  }

  const players: Record<string, PlayerSnapshot> = {};
  for (const [id, player] of Object.entries(raw)) {
    const parsedTeam = isTeam(player.team)
      ? player.team
      : player.color === TEAM_COLORS.red
        ? "red"
        : "blue";
    players[id] = {
      id,
      name: typeof player.name === "string" ? player.name : "Player",
      team: parsedTeam,
      color:
        typeof player.color === "string"
          ? player.color
          : getTeamColor(parsedTeam),
      faceTexture:
        typeof player.faceTexture === "string" && player.faceTexture.startsWith("data:image/")
          ? player.faceTexture
          : null,
      x: safeNumber(player.x, 0),
      y: safeNumber(player.y, PLAYER_EYE_HEIGHT),
      z: safeNumber(player.z, 0),
      yaw: safeNumber(player.yaw, 0),
      pitch: safeNumber(player.pitch, 0),
      hp: Math.max(0, Math.min(100, safeNumber(player.hp, 100))),
      kills: Math.max(0, Math.floor(safeNumber(player.kills, 0))),
      deaths: Math.max(0, Math.floor(safeNumber(player.deaths, 0))),
      respawnUntil:
        typeof player.respawnUntil === "number" && Number.isFinite(player.respawnUntil)
          ? player.respawnUntil
          : null,
      updatedAt: safeNumber(player.updatedAt, 0),
    };
  }

  return players;
}

function toThreeColor(color: string): THREE.Color {
  try {
    return new THREE.Color(color);
  } catch {
    return new THREE.Color("#8ac0ff");
  }
}

function getHitMetadata(object: THREE.Object3D | null): { playerId: string | null; hitZone: HitZone } {
  let current: THREE.Object3D | null = object;
  let hitZone: HitZone = "body";

  while (current) {
    if (current.userData.hitZone === "head") {
      hitZone = "head";
    }
    if (typeof current.userData.playerId === "string") {
      return { playerId: current.userData.playerId, hitZone };
    }
    current = current.parent;
  }

  return { playerId: null, hitZone };
}

function readRoomFromQuery(): string {
  if (typeof window === "undefined") {
    return "";
  }

  const fromQuery = new URLSearchParams(window.location.search).get("room");
  return fromQuery ? sanitizeRoom(fromQuery) : "";
}

async function createFaceTextureDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Unable to load selected image."));
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = FACE_TEXTURE_SIZE;
    canvas.height = FACE_TEXTURE_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas is not available in this browser.");
    }

    const source = Math.min(image.width, image.height);
    const sx = (image.width - source) / 2;
    const sy = (image.height - source) / 2;
    ctx.drawImage(image, sx, sy, source, source, 0, 0, FACE_TEXTURE_SIZE, FACE_TEXTURE_SIZE);

    return canvas.toDataURL("image/jpeg", 0.84);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function FpsGame() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  const [phase, setPhase] = useState<MatchPhase>("menu");
  const [nickname, setNickname] = useState("Sharpshot");
  const [roomInput, setRoomInput] = useState(readRoomFromQuery);
  const [activeRoom, setActiveRoom] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPointerLocked, setIsPointerLocked] = useState(false);
  const [hitMarker, setHitMarker] = useState(false);
  const [players, setPlayers] = useState<Record<string, PlayerSnapshot>>({});
  const [killFeed, setKillFeed] = useState<KillFeedEntry[]>([]);
  const [hud, setHud] = useState({ hp: 100, kills: 0, deaths: 0, respawnSeconds: 0 });
  const [sessionNonce, setSessionNonce] = useState(0);
  const [selfPlayerId, setSelfPlayerId] = useState("");
  const [teamPreference, setTeamPreference] = useState<TeamPreference>("auto");
  const [selfTeam, setSelfTeam] = useState<Team>("blue");
  const [faceTextureData, setFaceTextureData] = useState<string | null>(null);
  const [faceFileName, setFaceFileName] = useState("");

  const playersRef = useRef<Record<string, PlayerSnapshot>>({});
  const sessionRef = useRef<Session | null>(null);
  const localRef = useRef<LocalPlayerState>({
    position: randomSpawnPoint("blue"),
    yaw: Math.PI,
    pitch: 0,
    hp: 100,
    kills: 0,
    deaths: 0,
    respawnUntil: null,
  });
  const processedEventIdsRef = useRef<Set<string>>(new Set());
  const countedKillEventsRef = useRef<Set<string>>(new Set());
  const hitMarkerTimeoutRef = useRef<number | null>(null);

  const missingFirebaseEnv = useMemo(() => getMissingFirebaseEnv(), []);

  const setHudFromLocal = useCallback(() => {
    const now = Date.now();
    const respawnSeconds =
      localRef.current.respawnUntil && localRef.current.respawnUntil > now
        ? Math.ceil((localRef.current.respawnUntil - now) / 1000)
        : 0;

    setHud({
      hp: Math.max(0, Math.round(localRef.current.hp)),
      kills: localRef.current.kills,
      deaths: localRef.current.deaths,
      respawnSeconds,
    });
  }, []);

  const addKillFeed = useCallback((text: string, id: string) => {
    setKillFeed((existing) => [{ id, text }, ...existing].slice(0, 5));
  }, []);

  const stopSession = useCallback(async () => {
    if (sessionRef.current) {
      await sessionRef.current.close();
      sessionRef.current = null;
    }

    processedEventIdsRef.current.clear();
    countedKillEventsRef.current.clear();
    playersRef.current = {};
    setPlayers({});
    setKillFeed([]);
    setSelfPlayerId("");
    setSelfTeam("blue");
    setIsPointerLocked(false);
  }, []);

  const handleEvent = useCallback(
    (snapshot: DataSnapshot) => {
      const session = sessionRef.current;
      if (!session || !snapshot.key) {
        return;
      }

      if (processedEventIdsRef.current.has(snapshot.key)) {
        return;
      }

      processedEventIdsRef.current.add(snapshot.key);
      const event = getEvent(snapshot);
      if (!event) {
        return;
      }

      const isCurrentSessionEvent = event.at >= session.joinedAt;

      if (event.type === "kill") {
        addKillFeed(`${event.fromName} eliminated ${event.toName}`, snapshot.key);

        if (
          isCurrentSessionEvent &&
          event.from === session.playerId &&
          event.to !== session.playerId &&
          !countedKillEventsRef.current.has(snapshot.key)
        ) {
          countedKillEventsRef.current.add(snapshot.key);
          localRef.current.kills += 1;
          session.writeLocal({ kills: localRef.current.kills });
          setHudFromLocal();
        }
        return;
      }

      if (!isCurrentSessionEvent || event.to !== session.playerId) {
        return;
      }

      const attacker = playersRef.current[event.from];
      if (attacker && attacker.team === session.team) {
        return;
      }

      const now = Date.now();
      if (localRef.current.respawnUntil && now < localRef.current.respawnUntil) {
        return;
      }

      localRef.current.hp = Math.max(0, localRef.current.hp - event.damage);
      if (localRef.current.hp > 0) {
        session.writeLocal({ hp: localRef.current.hp });
        setHudFromLocal();
        return;
      }

      localRef.current.hp = 0;
      localRef.current.deaths += 1;
      localRef.current.respawnUntil = now + RESPAWN_MS;
      session.writeLocal({
        hp: 0,
        deaths: localRef.current.deaths,
        respawnUntil: localRef.current.respawnUntil,
      });
      void session.sendKill(event.from, event.fromName);
      setHudFromLocal();
    },
    [addKillFeed, setHudFromLocal],
  );

  const joinMatch = useCallback(
    async (requestedRoom: string) => {
      const roomId = sanitizeRoom(requestedRoom || generateRoomCode());
      if (roomId.length < 4) {
        setErrorMessage("Room code must be at least 4 characters.");
        setPhase("error");
        return;
      }

      if (!canInitializeFirebase()) {
        setErrorMessage("Firebase env vars are missing. Fill .env.local before joining.");
        setPhase("error");
        return;
      }

      const db = getRealtimeDatabase();
      if (!db) {
        setErrorMessage("Unable to initialize Firebase Realtime Database.");
        setPhase("error");
        return;
      }

      setPhase("connecting");
      setErrorMessage(null);

      const playerId = getOrCreatePlayerId();
      const playerName = sanitizeName(nickname) || `Player-${playerId.slice(0, 4)}`;

      const roomPlayersRef = ref(db, `rooms/${roomId}/players`);
      const localPlayerRef = ref(db, `rooms/${roomId}/players/${playerId}`);
      const roomEventsRef = ref(db, `rooms/${roomId}/events`);
      const disconnectRef = onDisconnect(localPlayerRef);

      const existingPlayersSnapshot = await get(roomPlayersRef);
      const existingPlayers = readPlayers(existingPlayersSnapshot);
      const team = pickTeam(teamPreference, existingPlayers);
      const color = getTeamColor(team);
      const spawn = randomSpawnPoint(team);

      localRef.current = {
        position: spawn.clone(),
        yaw: Math.PI,
        pitch: 0,
        hp: 100,
        kills: 0,
        deaths: 0,
        respawnUntil: null,
      };

      await set(localPlayerRef, {
        name: playerName,
        team,
        color,
        faceTexture: faceTextureData,
        x: spawn.x,
        y: spawn.y,
        z: spawn.z,
        yaw: Math.PI,
        pitch: 0,
        hp: 100,
        kills: 0,
        deaths: 0,
        respawnUntil: null,
        updatedAt: Date.now(),
      });

      await disconnectRef.remove();

      const unsubscribePlayers = onValue(roomPlayersRef, (snapshot) => {
        const nextPlayers = readPlayers(snapshot);
        playersRef.current = nextPlayers;
        setPlayers(nextPlayers);
      });

      const unsubscribeEvents = onChildAdded(query(roomEventsRef, limitToLast(120)), handleEvent);

      const writeLocal = (patch: Partial<PlayerSnapshot>) => {
        void update(localPlayerRef, { ...patch, updatedAt: Date.now() });
      };

      const session: Session = {
        roomId,
        playerId,
        playerName,
        team,
        localRef: localPlayerRef,
        eventsRef: roomEventsRef,
        joinedAt: Date.now(),
        writeLocal,
        sendHit: async (targetId, targetName, damage) => {
          await push(roomEventsRef, {
            type: "hit",
            from: playerId,
            to: targetId,
            damage,
            fromName: playerName,
            toName: targetName,
            at: Date.now(),
          } satisfies HitEvent);
        },
        sendKill: async (killerId, killerName) => {
          await push(roomEventsRef, {
            type: "kill",
            from: killerId,
            to: playerId,
            fromName: killerName,
            toName: playerName,
            at: Date.now(),
          } satisfies KillEvent);
        },
        close: async () => {
          unsubscribePlayers();
          unsubscribeEvents();
          try {
            await disconnectRef.cancel();
          } catch {
            // Ignore network cleanup errors while closing the session.
          }
          try {
            await remove(localPlayerRef);
          } catch {
            // Ignore network cleanup errors while closing the session.
          }
        },
      };

      sessionRef.current = session;
      setSessionNonce((value) => value + 1);
      setSelfPlayerId(playerId);
      setSelfTeam(team);
      setActiveRoom(roomId);
      setRoomInput(roomId);
      setHudFromLocal();
      window.history.replaceState({}, "", `/?room=${roomId}`);
      setPhase("playing");
    },
    [faceTextureData, handleEvent, nickname, setHudFromLocal, teamPreference],
  );

  const handleFaceUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      setErrorMessage("Please choose a PNG or JPG image file.");
      return;
    }

    try {
      const dataUrl = await createFaceTextureDataUrl(file);
      if (dataUrl.length > MAX_FACE_DATA_URL_LENGTH) {
        setErrorMessage("Image is too large after compression. Try a smaller file.");
        return;
      }

      setFaceTextureData(dataUrl);
      setFaceFileName(file.name);
      setErrorMessage(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to process selected image.";
      setErrorMessage(message);
    } finally {
      event.target.value = "";
    }
  }, []);

  const leaveMatch = useCallback(async () => {
    await stopSession();
    setActiveRoom("");
    setPhase("menu");
    setFaceTextureData(null);
    setFaceFileName("");
    window.history.replaceState({}, "", "/");
  }, [stopSession]);

  useEffect(() => {
    if (phase !== "playing") {
      return;
    }

    const session = sessionRef.current;
    const mount = mountRef.current;
    if (!session || !mount) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#5aa4dd");
    scene.fog = new THREE.Fog("#75b6ed", 22, 155);

    const camera = new THREE.PerspectiveCamera(74, 16 / 9, 0.1, 260);
    camera.rotation.order = "YXZ";

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    mount.appendChild(renderer.domElement);

    const hemi = new THREE.HemisphereLight("#9fd5ff", "#6f7d57", 0.9);
    const sun = new THREE.DirectionalLight("#fff6e2", 1.0);
    sun.position.set(22, 30, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -90;
    sun.shadow.camera.right = 90;
    sun.shadow.camera.top = 90;
    sun.shadow.camera.bottom = -90;
    scene.add(hemi, sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(220, 220),
      new THREE.MeshStandardMaterial({
        color: "#4a6b47",
        roughness: 0.9,
        metalness: 0.1,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const grid = new THREE.GridHelper(180, 28, "#8fc9ff", "#74a5df");
    grid.position.y = 0.02;
    scene.add(grid);

    const wallMaterial = new THREE.MeshStandardMaterial({
      color: "#708eb3",
      roughness: 0.74,
      metalness: 0.22,
    });

    const worldWalls = [
      new THREE.Mesh(new THREE.BoxGeometry(120, 8, 2), wallMaterial),
      new THREE.Mesh(new THREE.BoxGeometry(120, 8, 2), wallMaterial),
      new THREE.Mesh(new THREE.BoxGeometry(2, 8, 120), wallMaterial),
      new THREE.Mesh(new THREE.BoxGeometry(2, 8, 120), wallMaterial),
    ];

    worldWalls[0].position.set(0, 4, -60);
    worldWalls[1].position.set(0, 4, 60);
    worldWalls[2].position.set(-60, 4, 0);
    worldWalls[3].position.set(60, 4, 0);
    for (const wall of worldWalls) {
      wall.castShadow = true;
      wall.receiveShadow = true;
      scene.add(wall);
    }

    const obstacleMaterial = new THREE.MeshStandardMaterial({
      color: "#8f6f5a",
      roughness: 0.8,
      metalness: 0.08,
    });

    for (const obstacle of BLOCKERS) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(obstacle.w, obstacle.h, obstacle.d),
        obstacleMaterial,
      );
      mesh.position.set(obstacle.x, obstacle.h / 2, obstacle.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }

    const platformMaterial = new THREE.MeshStandardMaterial({
      color: "#4b5769",
      roughness: 0.74,
      metalness: 0.18,
    });

    for (const surface of WALK_SURFACES) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(surface.w, 0.65, surface.d),
        platformMaterial,
      );
      mesh.position.set(surface.x, surface.top + 0.325, surface.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }

    for (const step of TOWER_STEPS) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(step.w, 0.36, step.d),
        new THREE.MeshStandardMaterial({
          color: "#a4785d",
          roughness: 0.78,
          metalness: 0.07,
        }),
      );
      mesh.position.set(step.x, step.top + 0.18, step.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }

    const remoteAvatars = new Map<string, RemoteAvatar>();
    const rayTargets: THREE.Object3D[] = [];
    const tracers: ShotTracer[] = [];
    const textureLoader = new THREE.TextureLoader();
    let gunTemplate: THREE.Group | null = null;

    const applyFaceTexture = (avatar: RemoteAvatar, faceTexture: string | null) => {
      const material = avatar.faceDecal.material;
      if (!(material instanceof THREE.MeshStandardMaterial)) {
        return;
      }

      if (!faceTexture) {
        if (material.map) {
          material.map.dispose();
        }
        material.map = null;
        material.color.set("#ecf2ff");
        material.needsUpdate = true;
        avatar.appliedFaceTexture = null;
        return;
      }

      textureLoader.load(
        faceTexture,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          if (material.map) {
            material.map.dispose();
          }
          material.map = texture;
          material.color.set("#ffffff");
          material.needsUpdate = true;
          avatar.appliedFaceTexture = faceTexture;
        },
        undefined,
        () => {
          avatar.appliedFaceTexture = null;
        },
      );
    };

    const attachGunToMount = (mount: THREE.Group) => {
      mount.clear();
      if (gunTemplate) {
        const clone = gunTemplate.clone(true);
        mount.add(clone);
        return;
      }

      const fallback = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.16, 0.95),
        new THREE.MeshStandardMaterial({
          color: "#2f3746",
          roughness: 0.55,
          metalness: 0.3,
          emissive: "#10131b",
          emissiveIntensity: 0.28,
        }),
      );
      mount.add(fallback);
    };

    const loadGunTemplate = () => {
      const mtlLoader = new MTLLoader();
      mtlLoader.setPath("/assets/gun/");
      mtlLoader.setResourcePath("/assets/gun/");

      mtlLoader.load(
        "Gun.mtl",
        (materials) => {
          materials.preload();
          const objLoader = new OBJLoader();
          objLoader.setMaterials(materials);
          objLoader.setPath("/assets/gun/");
          objLoader.load(
            "Gun.obj",
            (object) => {
              object.scale.setScalar(1.18);
              object.rotation.set(0, -Math.PI / 2, 0.08);
              object.position.set(0.03, -0.03, 0.02);
              object.traverse((node) => {
                if (node instanceof THREE.Mesh) {
                  node.castShadow = true;
                  node.receiveShadow = true;
                }
              });

              gunTemplate = new THREE.Group();
              gunTemplate.add(object);

              for (const avatar of remoteAvatars.values()) {
                attachGunToMount(avatar.gunMount);
              }
              attachGunToMount(viewGunMount);
            },
            undefined,
            () => {
              gunTemplate = null;
            },
          );
        },
        undefined,
        () => {
          gunTemplate = null;
        },
      );
    };

    loadGunTemplate();

    const addRemoteAvatar = (player: PlayerSnapshot): RemoteAvatar => {
      const group = new THREE.Group();
      const bodyMaterial = new THREE.MeshStandardMaterial({
        color: toThreeColor(player.color),
        roughness: 0.3,
        metalness: 0.2,
        transparent: true,
        opacity: player.hp <= 0 ? 0.28 : 1,
      });

      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 1.24, 5, 10), bodyMaterial);
      body.position.y = 1.28;
      body.castShadow = true;
      body.userData.playerId = player.id;
      body.userData.hitZone = "body";

      const visor = new THREE.Mesh(
        new THREE.SphereGeometry(0.26, 12, 12),
        new THREE.MeshStandardMaterial({
          color: "#f6f8ff",
          roughness: 0.2,
          metalness: 0.35,
          transparent: true,
          opacity: 0.8,
        }),
      );
      visor.position.set(0, 2.12, -0.1);
      visor.userData.playerId = player.id;
      visor.userData.hitZone = "head";

      const faceDecal = new THREE.Mesh(
        new THREE.PlaneGeometry(0.42, 0.42),
        new THREE.MeshStandardMaterial({
          color: "#ecf2ff",
          roughness: 0.45,
          metalness: 0.08,
          transparent: true,
          side: THREE.DoubleSide,
        }),
      );
      faceDecal.position.set(0, 2.1, -0.28);
      faceDecal.userData.playerId = player.id;
      faceDecal.userData.hitZone = "head";

      const hpBack = new THREE.Mesh(
        new THREE.PlaneGeometry(0.52, 0.08),
        new THREE.MeshBasicMaterial({
          color: "#11151e",
          transparent: true,
          opacity: 0.72,
          side: THREE.DoubleSide,
        }),
      );
      hpBack.position.set(0, 2.66, -0.46);

      const hpFill = new THREE.Mesh(
        new THREE.PlaneGeometry(0.48, 0.05),
        new THREE.MeshBasicMaterial({ color: "#58f58b", side: THREE.DoubleSide }),
      );
      hpFill.position.set(0, 2.66, -0.45);

      const gunMount = new THREE.Group();
      gunMount.position.set(0.3, 1.45, -0.34);
      attachGunToMount(gunMount);

      group.add(body, visor, faceDecal, hpBack, hpFill, gunMount);
      group.position.set(player.x, 0, player.z);
      group.rotation.y = player.yaw;

      scene.add(group);
      rayTargets.push(body, visor, faceDecal);

      const avatar: RemoteAvatar = {
        group,
        body,
        faceDecal,
        hpFill,
        gunMount,
        targetPosition: new THREE.Vector3(player.x, 0, player.z),
        targetYaw: player.yaw,
        appliedFaceTexture: null,
      };

      applyFaceTexture(avatar, player.faceTexture);

      return avatar;
    };

    const removeRemoteAvatar = (id: string) => {
      const existing = remoteAvatars.get(id);
      if (!existing) {
        return;
      }

      scene.remove(existing.group);
      const nextRayTargets = rayTargets.filter((entry) => {
        const owner = typeof entry.userData.playerId === "string" ? entry.userData.playerId : "";
        return owner !== id;
      });
      rayTargets.length = 0;
      rayTargets.push(...nextRayTargets);
      const faceMaterial = existing.faceDecal.material;
      if (faceMaterial instanceof THREE.MeshStandardMaterial && faceMaterial.map) {
        faceMaterial.map.dispose();
      }
      existing.gunMount.clear();
      remoteAvatars.delete(id);
    };

    const controls = new Set<string>();
    const shotRay = new THREE.Raycaster();
    const cameraVector = new THREE.Vector2(0, 0);
    const lastSyncRef = { value: 0 };
    const lastFrameRef = { value: performance.now() };
    const lastShotRef = { value: 0 };
    const verticalVelocityRef = { value: 0 };
    const hudTickRef = { value: 0 };
    const slideTimerRef = { value: 0 };
    const slideDirection = new THREE.Vector3(0, 0, 0);
    let audioContext: AudioContext | null = null;

    const pointerElement = renderer.domElement;
    const viewGunMount = new THREE.Group();
    viewGunMount.position.set(0.26, -0.24, -0.46);
    viewGunMount.rotation.set(-0.09, 0.02, -0.16);
    camera.add(viewGunMount);
    scene.add(camera);
    attachGunToMount(viewGunMount);

    const onResize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };

    const onPointerLockChange = () => {
      setIsPointerLocked(document.pointerLockElement === pointerElement);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"].includes(event.code)) {
        event.preventDefault();
      }
      controls.add(event.code);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      controls.delete(event.code);
    };

    const onMouseMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== pointerElement) {
        return;
      }

      localRef.current.yaw -= event.movementX * LOOK_SENSITIVITY;
      localRef.current.pitch = Math.max(
        -1.25,
        Math.min(1.25, localRef.current.pitch - event.movementY * LOOK_SENSITIVITY),
      );
    };

    const flashHitMarker = () => {
      setHitMarker(true);
      if (hitMarkerTimeoutRef.current) {
        window.clearTimeout(hitMarkerTimeoutRef.current);
      }
      hitMarkerTimeoutRef.current = window.setTimeout(() => {
        setHitMarker(false);
      }, 90);
    };

    const createTracer = (endPoint: THREE.Vector3) => {
      const startPoint = camera.position.clone();
      const geometry = new THREE.BufferGeometry().setFromPoints([startPoint, endPoint]);
      const material = new THREE.LineBasicMaterial({
        color: "#ffd36e",
        transparent: true,
        opacity: 0.95,
      });
      const line = new THREE.Line(geometry, material);
      scene.add(line);
      tracers.push({ line, expiresAt: performance.now() + TRACER_DURATION_MS });
    };

    const playShotSound = () => {
      try {
        if (!audioContext) {
          audioContext = new window.AudioContext();
        }

        if (audioContext.state === "suspended") {
          void audioContext.resume();
        }

        const nowTime = audioContext.currentTime;
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.type = "square";
        oscillator.frequency.setValueAtTime(760, nowTime);
        oscillator.frequency.exponentialRampToValueAtTime(230, nowTime + 0.08);

        gainNode.gain.setValueAtTime(0.0001, nowTime);
        gainNode.gain.exponentialRampToValueAtTime(0.11, nowTime + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, nowTime + 0.1);

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.start(nowTime);
        oscillator.stop(nowTime + 0.11);
      } catch {
        // Audio may be blocked by browser policy or unavailable.
      }
    };

    const shoot = async () => {
      if (document.pointerLockElement !== pointerElement) {
        return;
      }
      if (localRef.current.hp <= 0 || localRef.current.respawnUntil) {
        return;
      }

      const now = performance.now();
      if (now - lastShotRef.value < SHOOT_COOLDOWN_MS) {
        return;
      }
      lastShotRef.value = now;
      playShotSound();

      shotRay.setFromCamera(cameraVector, camera);
      const hitResults = shotRay.intersectObjects(rayTargets, true);
      const target = hitResults.find((candidate) => {
        const metadata = getHitMetadata(candidate.object);
        return metadata.playerId && metadata.playerId !== session.playerId;
      });
      const worldDirection = camera.getWorldDirection(new THREE.Vector3());
      const tracerEnd = target
        ? target.point.clone()
        : camera.position.clone().add(worldDirection.multiplyScalar(140));
      createTracer(tracerEnd);

      if (!target) {
        return;
      }

      const metadata = getHitMetadata(target.object);
      const targetId = metadata.playerId;
      if (!targetId) {
        return;
      }

      const targetPlayer = playersRef.current[targetId];
      if (targetPlayer?.team === session.team) {
        return;
      }

      const targetName = targetPlayer?.name ?? "Enemy";
      const damage = metadata.hitZone === "head" ? 40 : 10;
      await session.sendHit(targetId, targetName, damage);
      flashHitMarker();
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      if (document.pointerLockElement !== pointerElement) {
        pointerElement.requestPointerLock().catch(() => {
          // Ignore transient browser lock errors after manual unlock.
        });
        return;
      }

      void shoot();
    };

    window.addEventListener("resize", onResize);
    document.addEventListener("pointerlockchange", onPointerLockChange);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("mousemove", onMouseMove);
    pointerElement.addEventListener("mousedown", onMouseDown);

    onResize();

    const walkableSurfaces = [...WALK_SURFACES, ...TOWER_STEPS];

    const collidesObstacle = (x: number, z: number, feetY: number): boolean => {
      return BLOCKERS.some((obstacle) => {
        return (
          x > obstacle.x - obstacle.w / 2 - PLAYER_RADIUS &&
          x < obstacle.x + obstacle.w / 2 + PLAYER_RADIUS &&
          z > obstacle.z - obstacle.d / 2 - PLAYER_RADIUS &&
          z < obstacle.z + obstacle.d / 2 + PLAYER_RADIUS &&
          feetY < obstacle.h + 0.38
        );
      });
    };

    const getFloorHeight = (x: number, z: number, feetY: number): number => {
      let floorHeight = 0;
      for (const surface of walkableSurfaces) {
        const inside =
          x > surface.x - surface.w / 2 &&
          x < surface.x + surface.w / 2 &&
          z > surface.z - surface.d / 2 &&
          z < surface.z + surface.d / 2;

        if (!inside) {
          continue;
        }

        const canStepUp = surface.top - feetY <= MAX_STEP_UP;
        const alreadyAbove = feetY >= surface.top - 0.08;
        if ((canStepUp || alreadyAbove) && surface.top > floorHeight) {
          floorHeight = surface.top;
        }
      }
      return floorHeight;
    };

    const forward = new THREE.Vector3();
    const strafe = new THREE.Vector3();
    const movement = new THREE.Vector3();

    let animationFrame = 0;

    const loop = () => {
      animationFrame = window.requestAnimationFrame(loop);

      const now = performance.now();
      const delta = Math.min(0.045, (now - lastFrameRef.value) / 1000);
      lastFrameRef.value = now;

      if (localRef.current.respawnUntil && Date.now() >= localRef.current.respawnUntil) {
        const spawn = randomSpawnPoint(session.team);
        localRef.current.position.copy(spawn);
        localRef.current.hp = 100;
        localRef.current.respawnUntil = null;
        verticalVelocityRef.value = 0;
        session.writeLocal({
          x: spawn.x,
          y: spawn.y,
          z: spawn.z,
          hp: 100,
          respawnUntil: null,
        });
      }

      const isAlive = localRef.current.hp > 0 && !localRef.current.respawnUntil;
      const feetBeforeMove = localRef.current.position.y - PLAYER_EYE_HEIGHT;
      const floorBeforeMove = getFloorHeight(
        localRef.current.position.x,
        localRef.current.position.z,
        feetBeforeMove,
      );
      const onGround =
        Math.abs(feetBeforeMove - floorBeforeMove) <= 0.06 && verticalVelocityRef.value <= 0.001;

      if (isAlive) {
        movement.set(0, 0, 0);
        camera.getWorldDirection(forward);
        forward.y = 0;
        if (forward.lengthSq() <= 0.000001) {
          forward.set(0, 0, -1);
        }
        forward.normalize();
        strafe.set(-forward.z, 0, forward.x).normalize();

        if (controls.has("KeyW")) movement.add(forward);
        if (controls.has("KeyS")) movement.sub(forward);
        if (controls.has("KeyD")) movement.add(strafe);
        if (controls.has("KeyA")) movement.sub(strafe);

        const isShiftDown = controls.has("ShiftLeft") || controls.has("ShiftRight");
        if (onGround && isShiftDown && movement.lengthSq() > 0 && slideTimerRef.value <= 0) {
          slideTimerRef.value = SLIDE_DURATION_SECONDS;
          slideDirection.copy(movement).normalize();
        }

        if (slideTimerRef.value > 0) {
          slideTimerRef.value = Math.max(0, slideTimerRef.value - delta);
          movement.copy(slideDirection).multiplyScalar(SLIDE_SPEED * delta);
        } else if (movement.lengthSq() > 0) {
          const moveSpeed = isShiftDown ? SPRINT_SPEED : PLAYER_SPEED;
          movement.normalize().multiplyScalar(moveSpeed * delta);
        }

        const prevZ = localRef.current.position.z;
        const maybeX = THREE.MathUtils.clamp(
          localRef.current.position.x + movement.x,
          -ARENA_LIMIT,
          ARENA_LIMIT,
        );
        if (!collidesObstacle(maybeX, prevZ, feetBeforeMove)) {
          localRef.current.position.x = maybeX;
        }

        const maybeZ = THREE.MathUtils.clamp(
          localRef.current.position.z + movement.z,
          -ARENA_LIMIT,
          ARENA_LIMIT,
        );
        if (!collidesObstacle(localRef.current.position.x, maybeZ, feetBeforeMove)) {
          localRef.current.position.z = maybeZ;
        }

        if (controls.has("Space") && onGround) {
          verticalVelocityRef.value = JUMP_FORCE;
          slideTimerRef.value = 0;
        }
      }

      verticalVelocityRef.value -= GRAVITY * delta;
      localRef.current.position.y += verticalVelocityRef.value * delta;
      const floorAfterMove = getFloorHeight(
        localRef.current.position.x,
        localRef.current.position.z,
        localRef.current.position.y - PLAYER_EYE_HEIGHT,
      );
      const targetEyeY = floorAfterMove + PLAYER_EYE_HEIGHT;
      if (localRef.current.position.y <= targetEyeY) {
        localRef.current.position.y = targetEyeY;
        verticalVelocityRef.value = 0;
      }

      camera.position.copy(localRef.current.position);
      camera.rotation.y = localRef.current.yaw;
      camera.rotation.x = localRef.current.pitch;

      const snapshots = playersRef.current;
      for (const [id, player] of Object.entries(snapshots)) {
        if (id === session.playerId) {
          continue;
        }

        const existing = remoteAvatars.get(id) ?? addRemoteAvatar(player);
        remoteAvatars.set(id, existing);
        existing.targetPosition.set(player.x, 0, player.z);
        existing.targetYaw = player.yaw;
        if (existing.appliedFaceTexture !== player.faceTexture) {
          applyFaceTexture(existing, player.faceTexture);
        }

        const hpScale = Math.max(0.02, Math.min(1, player.hp / 100));
        existing.hpFill.scale.x = hpScale;
        existing.hpFill.position.x = 0.24 * (hpScale - 1);

        const material = existing.body.material;
        if (material instanceof THREE.MeshStandardMaterial) {
          material.opacity = player.hp <= 0 ? 0.28 : 1;
        }
      }

      for (const id of [...remoteAvatars.keys()]) {
        if (!snapshots[id]) {
          removeRemoteAvatar(id);
        }
      }

      for (const avatar of remoteAvatars.values()) {
        avatar.group.position.lerp(avatar.targetPosition, 0.25);
        avatar.group.rotation.y = THREE.MathUtils.lerp(
          avatar.group.rotation.y,
          avatar.targetYaw,
          0.25,
        );
      }

      for (let i = tracers.length - 1; i >= 0; i -= 1) {
        const tracer = tracers[i];
        if (now >= tracer.expiresAt) {
          scene.remove(tracer.line);
          tracer.line.geometry.dispose();
          const material = tracer.line.material;
          if (material instanceof THREE.LineBasicMaterial) {
            material.dispose();
          }
          tracers.splice(i, 1);
        }
      }

      if (now - lastSyncRef.value >= NETWORK_TICK_MS) {
        lastSyncRef.value = now;
        session.writeLocal({
          x: localRef.current.position.x,
          y: localRef.current.position.y,
          z: localRef.current.position.z,
          yaw: localRef.current.yaw,
          pitch: localRef.current.pitch,
          hp: localRef.current.hp,
          kills: localRef.current.kills,
          deaths: localRef.current.deaths,
          respawnUntil: localRef.current.respawnUntil,
        });
      }

      if (now - hudTickRef.value >= 120) {
        hudTickRef.value = now;
        setHudFromLocal();
      }

      renderer.render(scene, camera);
    };

    loop();

    return () => {
      window.cancelAnimationFrame(animationFrame);

      if (document.pointerLockElement === pointerElement) {
        document.exitPointerLock();
      }

      window.removeEventListener("resize", onResize);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("mousemove", onMouseMove);
      pointerElement.removeEventListener("mousedown", onMouseDown);
      setIsPointerLocked(false);

      for (const avatar of remoteAvatars.values()) {
        scene.remove(avatar.group);
      }
      for (const tracer of tracers) {
        scene.remove(tracer.line);
        tracer.line.geometry.dispose();
        const material = tracer.line.material;
        if (material instanceof THREE.LineBasicMaterial) {
          material.dispose();
        }
      }
      if (audioContext) {
        void audioContext.close();
      }

      mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, [phase, sessionNonce, setHudFromLocal]);

  useEffect(() => {
    return () => {
      if (hitMarkerTimeoutRef.current) {
        window.clearTimeout(hitMarkerTimeoutRef.current);
      }
      void stopSession();
    };
  }, [stopSession]);

  const sortedPlayers = useMemo(() => {
    return Object.values(players).sort((a, b) => {
      if (b.kills !== a.kills) return b.kills - a.kills;
      if (a.deaths !== b.deaths) return a.deaths - b.deaths;
      return a.name.localeCompare(b.name);
    });
  }, [players]);

  const teamStats = useMemo(() => {
    const stats = {
      blue: { kills: 0, players: 0 },
      red: { kills: 0, players: 0 },
    };

    for (const player of Object.values(players)) {
      stats[player.team].kills += player.kills;
      stats[player.team].players += 1;
    }

    return stats;
  }, [players]);

  const bluePlayers = useMemo(() => {
    return sortedPlayers.filter((player) => player.team === "blue");
  }, [sortedPlayers]);

  const redPlayers = useMemo(() => {
    return sortedPlayers.filter((player) => player.team === "red");
  }, [sortedPlayers]);

  if (phase === "menu" || phase === "connecting" || phase === "error") {
    return (
      <main className="min-h-screen w-full px-6 py-8 text-white">
        <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-5xl flex-col justify-between gap-6 rounded-3xl border border-white/20 bg-black/35 p-7 shadow-2xl shadow-cyan-900/20 sm:p-10">
          <section className="space-y-4">
            <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-200/90">
              PulseStrike Arena
            </p>
            <h1 className="max-w-2xl text-3xl font-semibold leading-tight text-white sm:text-5xl">
              Multiplayer browser FPS built for quick friend lobbies.
            </h1>
            <p className="max-w-2xl text-sm text-sky-100/90 sm:text-base">
              Click into the match to lock your mouse, strafe with WASD, jump with Space, and shoot with left click.
              Share your room code and your friends can join instantly.
            </p>
          </section>

          <section className="hud-panel scan-grid flex flex-col gap-4 rounded-2xl p-5 sm:p-7">
            <label className="space-y-2">
              <span className="block text-xs uppercase tracking-[0.28em] text-cyan-200">Nickname</span>
              <input
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                placeholder="Your callsign"
                className="w-full rounded-xl border border-slate-400/35 bg-slate-900/80 px-4 py-3 text-sm outline-none ring-cyan-300 transition focus:ring-2"
              />
            </label>

            <label className="space-y-2">
              <span className="block text-xs uppercase tracking-[0.28em] text-cyan-200">Room Code</span>
              <input
                value={roomInput}
                onChange={(event) => setRoomInput(sanitizeRoom(event.target.value))}
                placeholder="AB12CD"
                className="w-full rounded-xl border border-slate-400/35 bg-slate-900/80 px-4 py-3 text-sm uppercase outline-none ring-cyan-300 transition focus:ring-2"
              />
            </label>

            <div className="space-y-2">
              <span className="block text-xs uppercase tracking-[0.28em] text-cyan-200">Team</span>
              <div className="grid gap-2 sm:grid-cols-3">
                <button
                  type="button"
                  onClick={() => setTeamPreference("auto")}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold uppercase tracking-[0.2em] transition ${
                    teamPreference === "auto"
                      ? "border-cyan-300/60 bg-cyan-400/20 text-cyan-100"
                      : "border-slate-400/35 bg-slate-900/80 text-sky-100"
                  }`}
                >
                  Auto
                </button>
                <button
                  type="button"
                  onClick={() => setTeamPreference("blue")}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold uppercase tracking-[0.2em] transition ${
                    teamPreference === "blue"
                      ? "border-blue-300/65 bg-blue-500/20 text-blue-100"
                      : "border-slate-400/35 bg-slate-900/80 text-sky-100"
                  }`}
                >
                  Blue
                </button>
                <button
                  type="button"
                  onClick={() => setTeamPreference("red")}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold uppercase tracking-[0.2em] transition ${
                    teamPreference === "red"
                      ? "border-red-300/65 bg-red-500/20 text-red-100"
                      : "border-slate-400/35 bg-slate-900/80 text-sky-100"
                  }`}
                >
                  Red
                </button>
              </div>
              <p className="text-xs text-sky-100/75">
                {teamPreference === "auto"
                  ? "Auto balances teams using current players in the room."
                  : `You will join team ${teamPreference.toUpperCase()}.`}
              </p>
            </div>

            <div className="space-y-2">
              <span className="block text-xs uppercase tracking-[0.28em] text-cyan-200">Face Image (JPG/PNG)</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => void handleFaceUpload(event)}
                className="w-full rounded-xl border border-slate-400/35 bg-slate-900/80 px-3 py-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-cyan-500/20 file:px-3 file:py-1.5 file:text-cyan-100"
              />
              {faceTextureData ? (
                <div className="flex items-center justify-between rounded-xl border border-cyan-300/35 bg-cyan-500/10 px-3 py-2">
                  <div className="flex items-center gap-3">
                    <NextImage
                      src={faceTextureData}
                      alt="Face preview"
                      width={40}
                      height={40}
                      unoptimized
                      className="h-10 w-10 rounded-lg object-cover"
                    />
                    <span className="text-xs text-cyan-100">{faceFileName || "Custom face ready"}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setFaceTextureData(null);
                      setFaceFileName("");
                    }}
                    className="rounded-md border border-red-300/35 bg-red-500/15 px-2 py-1 text-xs text-red-100"
                  >
                    Clear
                  </button>
                </div>
              ) : (
                <p className="text-xs text-sky-100/70">Optional. Visible only during this match session.</p>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => void joinMatch(generateRoomCode())}
                disabled={phase === "connecting"}
                className="rounded-xl border border-cyan-300/60 bg-cyan-400/15 px-4 py-3 text-sm font-semibold uppercase tracking-[0.2em] transition hover:bg-cyan-400/25 disabled:opacity-45"
              >
                {phase === "connecting" ? "Connecting..." : "Create Room"}
              </button>
              <button
                type="button"
                onClick={() => void joinMatch(roomInput)}
                disabled={phase === "connecting"}
                className="rounded-xl border border-orange-300/55 bg-orange-400/10 px-4 py-3 text-sm font-semibold uppercase tracking-[0.2em] transition hover:bg-orange-400/20 disabled:opacity-45"
              >
                Join Room
              </button>
            </div>

            {errorMessage ? (
              <div className="rounded-xl border border-red-300/40 bg-red-500/12 px-4 py-3 text-sm text-red-200">
                {errorMessage}
              </div>
            ) : null}

            {!canInitializeFirebase() ? (
              <div className="rounded-xl border border-yellow-300/45 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-100">
                Missing Firebase env vars: <span className="font-mono">{missingFirebaseEnv.join(", ")}</span>
              </div>
            ) : null}
          </section>

          <section className="text-sm text-sky-100/90">
            <p className="font-mono">Controls: `WASD` move, hold `Shift` to slide/sprint, `Space` jump, `LMB` shoot, `Esc` unlock mouse.</p>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="relative h-screen w-full overflow-hidden bg-black text-white">
      <div ref={mountRef} className="h-full w-full" />

      <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="crosshair" />
      </div>

      {hitMarker ? (
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 translate-y-7">
          <span className="hit-marker">X</span>
        </div>
      ) : null}

      <div className="pointer-events-none absolute left-4 top-4 z-20 flex max-w-xs flex-col gap-3 text-sm">
        <div className="hud-panel rounded-xl px-4 py-3">
          <p className="font-mono text-xs uppercase tracking-[0.26em] text-cyan-200">Room</p>
          <p className="mt-1 text-xl font-semibold tracking-[0.2em]">{activeRoom}</p>
        </div>
        <div className="hud-panel rounded-xl px-4 py-3">
          <p className="font-mono text-xs uppercase tracking-[0.26em] text-cyan-200">Status</p>
          <p className="mt-1">
            Team{" "}
            <span className={selfTeam === "blue" ? "text-blue-200" : "text-red-200"}>
              {selfTeam.toUpperCase()}
            </span>
          </p>
          <p className="mt-1">HP {hud.hp}</p>
          <p>Kills {hud.kills}</p>
          <p>Deaths {hud.deaths}</p>
          {hud.respawnSeconds > 0 ? (
            <p className="mt-1 text-orange-200">Respawning in {hud.respawnSeconds}s</p>
          ) : null}
        </div>
        <div className="hud-panel rounded-xl px-4 py-3 text-xs text-sky-100/85">
          {isPointerLocked
            ? "Locked: Aim with mouse, shoot with left click."
            : "Click the arena to lock your cursor and start fighting."}
        </div>
      </div>

      <div className="pointer-events-none absolute right-4 top-4 z-20 w-72">
        <div className="hud-panel rounded-xl px-4 py-3">
          <p className="font-mono text-xs uppercase tracking-[0.26em] text-cyan-200">Team Score</p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-lg border border-blue-300/40 bg-blue-500/12 px-3 py-2">
              <p className="font-semibold uppercase tracking-[0.16em] text-blue-100">Blue</p>
              <p className="mt-1 font-mono text-blue-50">{teamStats.blue.kills} Kills</p>
              <p className="text-xs text-blue-100/80">{teamStats.blue.players} Players</p>
            </div>
            <div className="rounded-lg border border-red-300/40 bg-red-500/12 px-3 py-2">
              <p className="font-semibold uppercase tracking-[0.16em] text-red-100">Red</p>
              <p className="mt-1 font-mono text-red-50">{teamStats.red.kills} Kills</p>
              <p className="text-xs text-red-100/80">{teamStats.red.players} Players</p>
            </div>
          </div>
        </div>
        <div className="mt-3 hud-panel rounded-xl px-4 py-3">
          <p className="font-mono text-xs uppercase tracking-[0.26em] text-cyan-200">Scoreboard</p>
          <div className="mt-2 space-y-2 text-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-100">Blue Team</p>
            {bluePlayers.map((player) => {
              const isYou = player.id === selfPlayerId;
              return (
                <div
                  key={player.id}
                  className={`flex items-center justify-between rounded px-2 py-1 ${isYou ? "bg-cyan-400/16" : "bg-black/20"}`}
                >
                  <span className="truncate pr-2 text-blue-100">
                    {isYou ? `${player.name} (you)` : player.name}
                  </span>
                  <span className="font-mono">{player.kills}/{player.deaths} | {player.hp}hp</span>
                </div>
              );
            })}
            {bluePlayers.length === 0 ? <p className="text-xs text-sky-100/70">No blue players.</p> : null}
            <p className="pt-1 text-xs font-semibold uppercase tracking-[0.16em] text-red-100">Red Team</p>
            {redPlayers.map((player) => {
              const isYou = player.id === selfPlayerId;
              return (
                <div
                  key={player.id}
                  className={`flex items-center justify-between rounded px-2 py-1 ${isYou ? "bg-cyan-400/16" : "bg-black/20"}`}
                >
                  <span className="truncate pr-2 text-red-100">
                    {isYou ? `${player.name} (you)` : player.name}
                  </span>
                  <span className="font-mono">{player.kills}/{player.deaths} | {player.hp}hp</span>
                </div>
              );
            })}
            {redPlayers.length === 0 ? <p className="text-xs text-sky-100/70">No red players.</p> : null}
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute left-1/2 top-4 z-20 w-full max-w-lg -translate-x-1/2 px-4">
        <div className="space-y-2 text-center text-sm">
          {killFeed.map((entry) => (
            <p key={entry.id} className="hud-panel rounded-lg px-3 py-1.5">
              {entry.text}
            </p>
          ))}
        </div>
      </div>

      <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2">
        <button
          type="button"
          onClick={() => void leaveMatch()}
          className="hud-panel rounded-xl border border-red-200/40 bg-red-500/15 px-4 py-2 text-xs font-semibold uppercase tracking-[0.24em] text-red-100 transition hover:bg-red-500/25"
        >
          Leave Match
        </button>
      </div>
    </main>
  );
}
