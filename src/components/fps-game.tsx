"use client";

import {
  DataSnapshot,
  DatabaseReference,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { canInitializeFirebase, getMissingFirebaseEnv, getRealtimeDatabase } from "@/lib/firebase";

type MatchPhase = "menu" | "connecting" | "playing" | "error";

type PlayerSnapshot = {
  id: string;
  name: string;
  color: string;
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

type RemoteAvatar = {
  group: THREE.Group;
  body: THREE.Mesh;
  targetPosition: THREE.Vector3;
  targetYaw: number;
};

const ARENA_LIMIT = 58;
const PLAYER_EYE_HEIGHT = 1.7;
const PLAYER_RADIUS = 0.45;
const PLAYER_SPEED = 8.3;
const GRAVITY = 24;
const JUMP_FORCE = 8.8;
const SHOOT_COOLDOWN_MS = 170;
const RESPAWN_MS = 3000;
const NETWORK_TICK_MS = 60;
const LOOK_SENSITIVITY = 0.002;

const SPAWN_POINTS = [
  new THREE.Vector3(-32, PLAYER_EYE_HEIGHT, -24),
  new THREE.Vector3(30, PLAYER_EYE_HEIGHT, -20),
  new THREE.Vector3(-24, PLAYER_EYE_HEIGHT, 32),
  new THREE.Vector3(28, PLAYER_EYE_HEIGHT, 26),
  new THREE.Vector3(0, PLAYER_EYE_HEIGHT, 0),
];

const OBSTACLES: Obstacle[] = [
  { x: 0, z: 0, w: 16, d: 3, h: 3.5 },
  { x: -16, z: 14, w: 4, d: 18, h: 4.2 },
  { x: 16, z: -14, w: 4, d: 18, h: 4.2 },
  { x: 20, z: 20, w: 8, d: 8, h: 4.8 },
  { x: -22, z: -18, w: 12, d: 5, h: 2.8 },
  { x: 5, z: -28, w: 7, d: 7, h: 3.8 },
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

function getPlayerColor(playerId: string): string {
  let hash = 0;
  for (let i = 0; i < playerId.length; i += 1) {
    hash = (hash << 5) - hash + playerId.charCodeAt(i);
    hash |= 0;
  }

  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 70% 58%)`;
}

function randomSpawnPoint(): THREE.Vector3 {
  const base = SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
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
    players[id] = {
      id,
      name: typeof player.name === "string" ? player.name : "Player",
      color: typeof player.color === "string" ? player.color : "#88c0ff",
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

function readRoomFromQuery(): string {
  if (typeof window === "undefined") {
    return "";
  }

  const fromQuery = new URLSearchParams(window.location.search).get("room");
  return fromQuery ? sanitizeRoom(fromQuery) : "";
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

  const playersRef = useRef<Record<string, PlayerSnapshot>>({});
  const sessionRef = useRef<Session | null>(null);
  const localRef = useRef<LocalPlayerState>({
    position: randomSpawnPoint(),
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
      const color = getPlayerColor(playerId);
      const spawn = randomSpawnPoint();

      const roomPlayersRef = ref(db, `rooms/${roomId}/players`);
      const localPlayerRef = ref(db, `rooms/${roomId}/players/${playerId}`);
      const roomEventsRef = ref(db, `rooms/${roomId}/events`);
      const disconnectRef = onDisconnect(localPlayerRef);

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
        color,
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
      setActiveRoom(roomId);
      setRoomInput(roomId);
      setHudFromLocal();
      window.history.replaceState({}, "", `/?room=${roomId}`);
      setPhase("playing");
    },
    [handleEvent, nickname, setHudFromLocal],
  );

  const leaveMatch = useCallback(async () => {
    await stopSession();
    setActiveRoom("");
    setPhase("menu");
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
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

    for (const obstacle of OBSTACLES) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(obstacle.w, obstacle.h, obstacle.d),
        obstacleMaterial,
      );
      mesh.position.set(obstacle.x, obstacle.h / 2, obstacle.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }

    const remoteAvatars = new Map<string, RemoteAvatar>();
    const rayTargets: THREE.Object3D[] = [];

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
      visor.position.set(0, 2.12, 0.11);
      visor.userData.playerId = player.id;

      const rifle = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.16, 0.95),
        new THREE.MeshStandardMaterial({ color: "#2f3746", roughness: 0.55, metalness: 0.3 }),
      );
      rifle.position.set(0.21, 1.48, -0.5);
      rifle.userData.playerId = player.id;

      group.add(body, visor, rifle);
      group.position.set(player.x, 0, player.z);
      group.rotation.y = player.yaw;

      scene.add(group);
      rayTargets.push(body, visor, rifle);

      return {
        group,
        body,
        targetPosition: new THREE.Vector3(player.x, 0, player.z),
        targetYaw: player.yaw,
      };
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

    const pointerElement = renderer.domElement;

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

    const getPlayerIdFromHit = (object: THREE.Object3D | null): string | null => {
      let current: THREE.Object3D | null = object;
      while (current) {
        if (typeof current.userData.playerId === "string") {
          return current.userData.playerId;
        }
        current = current.parent;
      }
      return null;
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

      shotRay.setFromCamera(cameraVector, camera);
      const hitResults = shotRay.intersectObjects(rayTargets, true);
      const target = hitResults.find((candidate) => {
        const id = getPlayerIdFromHit(candidate.object);
        return id && id !== session.playerId;
      });
      if (!target) {
        return;
      }

      const targetId = getPlayerIdFromHit(target.object);
      if (!targetId) {
        return;
      }

      const targetName = playersRef.current[targetId]?.name ?? "Enemy";
      await session.sendHit(targetId, targetName, 34);
      flashHitMarker();
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      if (document.pointerLockElement !== pointerElement) {
        void pointerElement.requestPointerLock();
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

    const collidesObstacle = (x: number, z: number): boolean => {
      return OBSTACLES.some((obstacle) => {
        return (
          x > obstacle.x - obstacle.w / 2 - PLAYER_RADIUS &&
          x < obstacle.x + obstacle.w / 2 + PLAYER_RADIUS &&
          z > obstacle.z - obstacle.d / 2 - PLAYER_RADIUS &&
          z < obstacle.z + obstacle.d / 2 + PLAYER_RADIUS
        );
      });
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
        const spawn = randomSpawnPoint();
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
      if (isAlive) {
        movement.set(0, 0, 0);
        forward.set(Math.sin(localRef.current.yaw), 0, -Math.cos(localRef.current.yaw));
        strafe.set(Math.cos(localRef.current.yaw), 0, Math.sin(localRef.current.yaw));

        if (controls.has("KeyW")) movement.add(forward);
        if (controls.has("KeyS")) movement.sub(forward);
        if (controls.has("KeyD")) movement.add(strafe);
        if (controls.has("KeyA")) movement.sub(strafe);

        if (movement.lengthSq() > 0) {
          movement.normalize().multiplyScalar(PLAYER_SPEED * delta);
        }

        const prevZ = localRef.current.position.z;
        const maybeX = THREE.MathUtils.clamp(
          localRef.current.position.x + movement.x,
          -ARENA_LIMIT,
          ARENA_LIMIT,
        );
        if (!collidesObstacle(maybeX, prevZ)) {
          localRef.current.position.x = maybeX;
        }

        const maybeZ = THREE.MathUtils.clamp(
          localRef.current.position.z + movement.z,
          -ARENA_LIMIT,
          ARENA_LIMIT,
        );
        if (!collidesObstacle(localRef.current.position.x, maybeZ)) {
          localRef.current.position.z = maybeZ;
        }

        if (controls.has("Space") && localRef.current.position.y <= PLAYER_EYE_HEIGHT + 0.01) {
          verticalVelocityRef.value = JUMP_FORCE;
        }
      }

      verticalVelocityRef.value -= GRAVITY * delta;
      localRef.current.position.y += verticalVelocityRef.value * delta;
      if (localRef.current.position.y <= PLAYER_EYE_HEIGHT) {
        localRef.current.position.y = PLAYER_EYE_HEIGHT;
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
            <p className="font-mono">Controls: `WASD` move, `Space` jump, `LMB` shoot, `Esc` unlock mouse.</p>
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
          <p className="font-mono text-xs uppercase tracking-[0.26em] text-cyan-200">Scoreboard</p>
          <div className="mt-2 space-y-1 text-sm">
            {sortedPlayers.map((player) => {
              const isYou = player.id === selfPlayerId;
              return (
                <div
                  key={player.id}
                  className={`flex items-center justify-between rounded px-2 py-1 ${isYou ? "bg-cyan-400/16" : "bg-black/20"}`}
                >
                  <span className="truncate pr-2" style={{ color: player.color }}>
                    {isYou ? `${player.name} (you)` : player.name}
                  </span>
                  <span className="font-mono">{player.kills}/{player.deaths}</span>
                </div>
              );
            })}
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
