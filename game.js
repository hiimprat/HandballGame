import * as THREE from "three";

const canvas = document.querySelector("#gameCanvas");
const playerScoreEl = document.querySelector("#playerScore");
const cpuScoreEl = document.querySelector("#cpuScore");
const opponentLabelEl = document.querySelector("#opponentLabel");
const statusText = document.querySelector("#statusText");
const shotButtons = [...document.querySelectorAll("[data-shot]")];
const restartBtn = document.querySelector("#restartBtn");
const moveStickEl = document.querySelector("#moveStick");
const aimStickEl = document.querySelector("#aimStick");
const chargeMeterEl = document.querySelector("#chargeMeter");
const chargeFillEl = document.querySelector("#chargeFill");
const roomInput = document.querySelector("#roomInput");
const hostBtn = document.querySelector("#hostBtn");
const joinBtn = document.querySelector("#joinBtn");
const networkStatusEl = document.querySelector("#networkStatus");
const DEFAULT_MULTIPLAYER_SERVER = "wss://handballgame.onrender.com";

const court = {
  left: 90,
  right: 870,
  wallY: 78,
  front: 592,
  shortLine: 278,
  serviceLine: 410,
};

const world = {
  width: 18,
  depth: 28,
  wallZ: -14,
  frontZ: 14,
};

// Real-ish ball physics. Height (vh) lives in world units with gravity;
// court x/y are independent horizontal coordinates and have no gravity.
const GRAVITY_Y = 24; // world units per second^2
const FLOOR_HEIGHT = 0.23; // ball radius in world units (also rest height)
const SWING_HEIGHT = 1.2; // approximate hand height when contacting the ball
const COURT_TO_WORLD_DEPTH = world.depth / 514; // (court.front - court.wallY) = 514
const FLOOR_BOUNCE_BOOST = 1.22;
const ACTIVE_SIDE_MARGIN = 88;
const ACTIVE_BACK_MARGIN = 70;

const keys = new Set();
const targetScore = 11;
const positions = {
  serverY: 350,
  receiverY: 548,
};
const shotProfiles = {
  normal: {
    label: "Normal",
    speed: 620,
    side: 300,
    spin: 1.8,
    wallBounce: 0.86,
    wallHeight: 0.48,
    floorBounce: 0.62,
  },
  kill: {
    label: "Kill",
    speed: 920,
    side: 430,
    spin: 2.6,
    wallBounce: 0.78,
    wallHeight: 0.18,
    floorBounce: 0.34,
  },
  lob: {
    label: "Lob",
    speed: 560,
    side: 240,
    spin: 1.0,
    wallBounce: 0.92,
    wallHeight: 0.88,
    floorBounce: 0.7,
  },
};

const player = {
  x: 490,
  y: 562,
  radius: 23,
  speed: 320,
  depthSpeed: 245,
  reach: 112,
  cooldown: 0,
  swingTimer: 0,
  swingStyle: "normal",
  color: 0xf1b44c,
};

const cpu = {
  x: 490,
  y: positions.receiverY,
  radius: 22,
  speed: 420,
  depthSpeed: 320,
  reach: 118,
  cooldown: 0,
  swingTimer: 0,
  swingStyle: "normal",
  color: 0x72c2e8,
  targetX: 490,
  targetY: positions.receiverY,
  decisionTimer: 0,
  plannedShot: "normal",
};

const ball = {
  x: 480,
  y: 455,
  height: SWING_HEIGHT,
  radius: 9,
  vx: 0,
  vy: 0,
  vh: 0,
  spin: 0,
  wallBounce: shotProfiles.normal.wallBounce,
  floorBounce: shotProfiles.normal.floorBounce,
  wallHeight: shotProfiles.normal.wallHeight,
  wallFlash: 0,
  live: false,
  lastHit: null,
  floorBounces: 0,
  returnWindowGrace: 0,
  wallTravelGrace: 0,
  servePending: false,
  serveFaultType: null,
  bouncedSinceWall: false,
};

let playerScore = 0;
let cpuScore = 0;
let serving = "player";
let faultCount = 0;
let gameOver = false;
let messageTimer = 0;
let lastTime = performance.now();
let aim = 0; // legacy normalized aim (kept for spin/CPU compat); derived from aimX
let aimX = 480; // target X on the wall in court coords; player can aim anywhere
let aimHeight = shotProfiles.normal.wallHeight;
let selectedShot = "normal";

const online = {
  socket: null,
  role: "offline",
  room: "",
  peerConnected: false,
  targetUrl: "",
  hasJoined: false,
  lastError: "",
  lastSend: 0,
  lastInputSend: 0,
  remoteState: null,
  remoteInput: {
    moveX: 0,
    moveY: 0,
    aimX: 480,
    aimHeight: shotProfiles.normal.wallHeight,
    shots: [],
  },
};

// Kill is a charge-up shot. Press-and-hold any kill input (right mouse, K key,
// Kill button) to charge; release to fire. Charge fills linearly over 1.0s.
// While charging, the player walks at ~42% speed — committing to a kill is a
// real trade-off vs. just regular shots.
const KILL_CHARGE_TIME = 1.0;
const KILL_CHARGE_MOVE_MULT = 0.42;
const killCharge = {
  charging: false,
  amount: 0,
  // Track which input started the charge so a different input releasing it
  // doesn't accidentally end the wrong charge session.
  source: null,
};

function startKillCharge(source) {
  if (killCharge.charging || gameOver) return;
  killCharge.charging = true;
  killCharge.amount = 0;
  killCharge.source = source;
}

function releaseKillCharge(source) {
  if (!killCharge.charging || killCharge.source !== source) return;
  // Snapshot the charge for hitBall/serveFromPlayer to read, then fire.
  swingPlayer("kill");
  resetKillCharge();
}

function cancelKillCharge() {
  resetKillCharge();
}

function resetKillCharge() {
  killCharge.charging = false;
  killCharge.source = null;
  killCharge.amount = 0;
  shotButtons.forEach((button) => button.classList.remove("charging"));
  updateChargeUI();
}

function killChargeMultipliers() {
  // 0% charge → kill is *weaker* than Regular (so a panic-tap is bad).
  // 100% charge → kill is the strongest shot in the game.
  const c = clamp(killCharge.amount, 0, 1);
  return {
    speed: 0.55 + c * 0.7, // 0.55 → 1.25 of base
    side: 0.7 + c * 0.5,
    spin: 0.5 + c * 1.0,
  };
}

function applyKillCharge(profile) {
  const m = killChargeMultipliers();
  return {
    ...profile,
    speed: profile.speed * m.speed,
    side: profile.side * m.side,
    spin: profile.spin * m.spin,
  };
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10170f);
scene.fog = new THREE.Fog(0x10170f, 18, 50);

const camera = new THREE.PerspectiveCamera(57, canvas.clientWidth / canvas.clientHeight, 0.1, 100);
camera.position.set(0, 7.6, 23.5);
const pointerNdc = new THREE.Vector2();
const raycaster = new THREE.Raycaster();

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const hemiLight = new THREE.HemisphereLight(0xf6efd6, 0x16210f, 1.75);
scene.add(hemiLight);

const keyLight = new THREE.DirectionalLight(0xfff0ba, 2.2);
keyLight.position.set(-5, 12, 8);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
scene.add(keyLight);

const fillLight = new THREE.PointLight(0x8fcdf4, 18, 34);
fillLight.position.set(6, 7, -8);
scene.add(fillLight);

const courtGroup = new THREE.Group();
scene.add(courtGroup);

const materials = {
  floor: new THREE.MeshStandardMaterial({ color: 0x4f6347, roughness: 0.85 }),
  wall: new THREE.MeshStandardMaterial({ color: 0x647a5c, roughness: 0.78 }),
  darkWall: new THREE.MeshStandardMaterial({ color: 0x3d5138, roughness: 0.9 }),
  line: new THREE.MeshBasicMaterial({ color: 0xe9e1bd }),
  player: new THREE.MeshStandardMaterial({ color: player.color, roughness: 0.62 }),
  cpu: new THREE.MeshStandardMaterial({ color: cpu.color, roughness: 0.62 }),
  skin: new THREE.MeshStandardMaterial({ color: 0xfff0bd, roughness: 0.45 }),
  ball: new THREE.MeshStandardMaterial({ color: 0x2f86ff, roughness: 0.36 }),
  aim: new THREE.LineDashedMaterial({ color: 0xf2ca72, dashSize: 0.24, gapSize: 0.18 }),
  flash: new THREE.MeshBasicMaterial({ color: 0xf2ca72, transparent: true, opacity: 0 }),
};

const floor = new THREE.Mesh(new THREE.PlaneGeometry(world.width, world.depth), materials.floor);
floor.rotation.x = -Math.PI / 2;
floor.position.z = 0;
floor.receiveShadow = true;
courtGroup.add(floor);

const wall = new THREE.Mesh(new THREE.BoxGeometry(world.width, 8.5, 0.45), materials.wall);
wall.position.set(0, 4.2, world.wallZ - 0.25);
wall.receiveShadow = true;
wall.castShadow = true;
courtGroup.add(wall);

const backBand = new THREE.Mesh(new THREE.BoxGeometry(world.width, 0.35, 0.5), materials.darkWall);
backBand.position.set(0, 3.4, world.wallZ + 0.02);
courtGroup.add(backBand);

const wallTiles = new THREE.Group();
for (let i = -4; i <= 4; i += 1) {
  const seam = new THREE.Mesh(new THREE.BoxGeometry(0.03, 8.4, 0.03), materials.darkWall);
  seam.position.set(i * (world.width / 9), 4.25, world.wallZ + 0.03);
  wallTiles.add(seam);
}
courtGroup.add(wallTiles);

function addCourtLine(x, z, width, depth) {
  const line = new THREE.Mesh(new THREE.BoxGeometry(width, 0.035, depth), materials.line);
  line.position.set(x, 0.025, z);
  courtGroup.add(line);
}

addCourtLine(0, world.wallZ, world.width, 0.08);
addCourtLine(0, world.frontZ, world.width, 0.08);
addCourtLine(-world.width / 2, 0, 0.08, world.depth);
addCourtLine(world.width / 2, 0, 0.08, world.depth);
addCourtLine(0, mapY(court.shortLine), world.width, 0.06);

const wallFlashMesh = new THREE.Mesh(new THREE.CircleGeometry(0.58, 40), materials.flash);
wallFlashMesh.position.set(0, 2.8, world.wallZ + 0.05);
scene.add(wallFlashMesh);

const aimCurveGeometry = new THREE.BufferGeometry();
const aimLine = new THREE.Line(aimCurveGeometry, materials.aim);
scene.add(aimLine);

const aimTarget = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.28, 32), new THREE.MeshBasicMaterial({ color: 0xf2ca72 }));
aimTarget.rotation.y = 0;
scene.add(aimTarget);

const playerRig = createCharacter(materials.player);
const cpuRig = createCharacter(materials.cpu);
const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(0.23, 32, 20), materials.ball);
ballMesh.castShadow = true;
scene.add(playerRig.group, cpuRig.group, ballMesh);

const ballTrail = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xf2ca72, transparent: true, opacity: 0.36 }),
);
scene.add(ballTrail);
const trailPoints = [];

function createCharacter(bodyMaterial) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.48, 32, 18), bodyMaterial);
  body.scale.set(0.85, 1.05, 0.68);
  body.position.y = 0.82;
  body.castShadow = true;

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 24, 16), bodyMaterial);
  head.position.y = 1.38;
  head.castShadow = true;

  const eyes = new THREE.Group();
  for (const x of [-0.09, 0.09]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 8), new THREE.MeshBasicMaterial({ color: 0x122018 }));
    eye.position.set(x, 1.42, 0.23);
    eyes.add(eye);
  }

  const leftArm = createArm();
  leftArm.group.position.set(-0.34, 1.0, 0.03);
  const rightArm = createArm();
  rightArm.group.position.set(0.34, 1.0, 0.03);

  const reach = new THREE.Mesh(
    new THREE.TorusGeometry(0.95, 0.018, 8, 60, Math.PI),
    new THREE.MeshBasicMaterial({ color: 0xfff7d7, transparent: true, opacity: 0.38 }),
  );
  reach.rotation.x = Math.PI / 2;
  reach.position.y = 0.05;

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.78, 32),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.012;

  group.add(shadow, body, head, eyes, leftArm.group, rightArm.group, reach);
  return { group, body, head, leftArm, rightArm, reach };
}

function createArm() {
  const group = new THREE.Group();
  const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.075, 0.55, 12), materials.skin);
  upper.rotation.z = Math.PI / 2.8;
  upper.position.x = 0.18;
  upper.castShadow = true;
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.105, 16, 12), materials.skin);
  hand.position.x = 0.48;
  hand.castShadow = true;
  group.add(upper, hand);
  return { group, upper, hand };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mapX(x) {
  const t = (x - court.left) / (court.right - court.left);
  return (t - 0.5) * world.width;
}

function mapY(y) {
  const t = (y - court.wallY) / (court.front - court.wallY);
  return world.wallZ + t * world.depth;
}

function wallTargetHeight(profile) {
  return 1.3 + profile.wallHeight * 4.6;
}

function shotSettings(profile, targetHeight) {
  const height = clamp(targetHeight, 0.05, 1);
  // Carry maps wall-hit height to retained depth velocity. A low hit barely
  // carries (ball dies near the wall); a high hit holds most of its speed
  // and flies deep into the court.
  const carry = profile.label === "Lob" ? 0.48 + height * 0.42 : 0.55 + height * 0.55;
  const floorLife = profile.label === "Lob" ? 0.78 + height * 0.42 : 0.7 + height * 0.3;
  return {
    ...profile,
    wallHeight: height,
    wallBounce: profile.wallBounce * carry,
    floorBounce: profile.floorBounce * floorLife,
  };
}

// Solve for the initial vertical velocity (world units/sec) so that the ball,
// starting at startHeight and traveling distYCourt court-pixels in the depth
// axis at speed |vy| court-pixels/sec, arrives at the wall with height
// targetWallHeight under constant gravity GRAVITY_Y.
function initialVhForWallTarget(distYCourt, vyCourtSpeed, startHeight, targetWallHeight) {
  const dist = Math.max(40, distYCourt);
  const speed = Math.max(120, vyCourtSpeed);
  const t = dist / speed;
  return (targetWallHeight - startHeight + 0.5 * GRAVITY_Y * t * t) / t;
}

function setStatus(text, duration = 0) {
  statusText.textContent = text;
  messageTimer = duration;
}

function opponentName() {
  return online.role === "offline" ? "CPU" : "Player 2";
}

function playerName(name) {
  return name === "player" ? "Player" : opponentName();
}

function updateOnlineUI() {
  if (opponentLabelEl) opponentLabelEl.textContent = opponentName();
  if (!networkStatusEl) return;
  if (online.role === "offline") {
    networkStatusEl.textContent = online.lastError || "Offline";
  } else if (online.role === "host") {
    networkStatusEl.textContent = online.peerConnected
      ? `Hosting ${online.room}: connected`
      : `Hosting ${online.room}: waiting`;
  } else {
    networkStatusEl.textContent = online.peerConnected
      ? `Joined ${online.room}`
      : `Joining ${online.room}`;
  }
}

function resetPoint(nextServer = serving) {
  serving = nextServer;
  faultCount = 0;
  ball.live = false;
  ball.vx = 0;
  ball.vy = 0;
  ball.vh = 0;
  ball.height = SWING_HEIGHT;
  ball.spin = 0;
  ball.wallBounce = shotProfiles.normal.wallBounce;
  ball.floorBounce = shotProfiles.normal.floorBounce;
  ball.wallHeight = shotProfiles.normal.wallHeight;
  ball.wallFlash = 0;
  ball.lastHit = null;
  ball.floorBounces = 0;
  ball.returnWindowGrace = 0;
  ball.wallTravelGrace = 0;
  ball.servePending = false;
  ball.serveFaultType = null;
  ball.bouncedSinceWall = false;
  trailPoints.length = 0;
  player.x = 490;
  cpu.x = 490;
  player.y = serving === "player" ? positions.serverY : positions.receiverY;
  cpu.y = serving === "cpu" ? positions.serverY : positions.receiverY;
  cpu.targetX = cpu.x;
  cpu.targetY = cpu.y;
  cpu.decisionTimer = 0;
  if (serving === "player") {
    ball.x = player.x;
    ball.y = player.y - 48;
    setStatus("Aim, then left/right click to serve");
  } else {
    ball.x = cpu.x;
    ball.y = cpu.y - 48;
    if (online.role === "host" && online.peerConnected) {
      setStatus("Player 2 serving");
    } else {
      setStatus("CPU serving");
      window.setTimeout(() => {
        if (!gameOver && !ball.live && serving === "cpu" && online.role !== "host") {
          cpuServe();
        }
      }, 700);
    }
  }
}

function restartGame() {
  playerScore = 0;
  cpuScore = 0;
  gameOver = false;
  updateScore();
  resetPoint("player");
}

function updateScore() {
  playerScoreEl.textContent = playerScore;
  cpuScoreEl.textContent = cpuScore;
}

function finishRally(winner, reason) {
  if (gameOver) return;
  ball.live = false;

  if (winner === serving) {
    if (winner === "player") {
      playerScore += 1;
    } else {
      cpuScore += 1;
    }
  } else {
    serving = winner;
    reason = `${reason} - side out`;
  }

  faultCount = 0;
  updateScore();

  if (playerScore >= targetScore || cpuScore >= targetScore) {
    gameOver = true;
    setStatus(`${playerName(winner)} wins ${playerScore}-${cpuScore}. Press R`);
    return;
  }

  setStatus(reason, 900);
  window.setTimeout(() => {
    if (!gameOver) resetPoint(serving);
  }, 850);
}

function serviceFault(type) {
  ball.live = false;
  faultCount += 1;

  if (faultCount >= 2) {
    const oldServer = serving;
    serving = serving === "player" ? "cpu" : "player";
    faultCount = 0;
    setStatus(`${type}. ${playerName(oldServer)} side out`, 900);
    window.setTimeout(() => {
      if (!gameOver) resetPoint(serving);
    }, 850);
    return;
  }

  setStatus(`${type}. Second serve`, 900);
  window.setTimeout(() => {
    if (!gameOver) resetServe();
  }, 850);
}

function makeServeLegal() {
  ball.servePending = false;
  ball.serveFaultType = null;
  ball.floorBounces = 0;
  setStatus("Legal serve", 420);
}

function resetServe() {
  ball.live = false;
  ball.vx = 0;
  ball.vy = 0;
  ball.vh = 0;
  ball.height = SWING_HEIGHT;
  ball.spin = 0;
  ball.floorBounces = 0;
  ball.returnWindowGrace = 0;
  ball.wallTravelGrace = 0;
  ball.servePending = false;
  ball.serveFaultType = null;
  ball.bouncedSinceWall = false;
  trailPoints.length = 0;
  if (serving === "player") {
    ball.x = player.x;
    ball.y = player.y - 48;
    setStatus("Second serve: aim, then left/right click");
  } else {
    ball.x = cpu.x;
    ball.y = cpu.y - 48;
    if (online.role === "host" && online.peerConnected) {
      setStatus("Player 2 second serve");
    } else {
      setStatus("CPU second serve");
      window.setTimeout(() => {
        if (!gameOver && !ball.live && serving === "cpu" && online.role !== "host") {
          cpuServe();
        }
      }, 700);
    }
  }
}

function serveFromActor(actor, name, shotType = selectedShot, targetAimX = aimX, targetAimHeight = aimHeight) {
  // Per-shot minimum heights so each shot type *feels* right even if the
  // reticle is left low. Normal needs to clear the short-line; lob is by
  // definition a high arc; kill is unconstrained (you want to drive it low).
  let serveHeight = targetAimHeight;
  if (shotType === "normal") serveHeight = Math.max(targetAimHeight, 0.34);
  else if (shotType === "lob") serveHeight = Math.max(targetAimHeight, 0.62);
  let baseProfile = shotProfiles[shotType];
  if (shotType === "kill" && name === "player") baseProfile = applyKillCharge(baseProfile);
  const profile = shotSettings(baseProfile, serveHeight);
  ball.live = true;
  ball.x = actor.x;
  ball.y = actor.y - 46;
  ball.height = SWING_HEIGHT;
  // Compute vx so the ball actually arrives at aimX on the wall.
  const tToWall = Math.max(0.12, (ball.y - court.wallY) / profile.speed);
  ball.vy = -profile.speed;
  ball.vx = clamp((targetAimX - ball.x) / tToWall, -2200, 2200);
  ball.vh = initialVhForWallTarget(ball.y - court.wallY, profile.speed, ball.height, wallTargetHeight(profile));
  ball.spin = clamp((targetAimX - ball.x) / 400, -2, 2) * profile.spin;
  ball.wallBounce = profile.wallBounce;
  ball.floorBounce = profile.floorBounce;
  ball.wallHeight = profile.wallHeight;
  ball.lastHit = name;
  ball.floorBounces = 0;
  ball.returnWindowGrace = 0;
  ball.wallTravelGrace = 0;
  ball.servePending = true;
  ball.serveFaultType = profile.wallHeight <= 0.3 ? "Short serve" : null;
  ball.bouncedSinceWall = false;
  trailPoints.length = 0;
  startSwing(actor, shotType);
  setStatus("Rally");
}

function serveFromPlayer() {
  serveFromActor(player, "player", selectedShot, aimX, aimHeight);
}

function cpuServe() {
  ball.live = true;
  ball.x = cpu.x;
  ball.y = cpu.y - 46; // serve away from CPU toward the wall
  ball.height = SWING_HEIGHT;
  const profile = shotSettings(shotProfiles.normal, 0.55);
  // Aim the serve toward the side opposite from where the player stands.
  const targetX = player.x > 490 ? court.left + 130 : court.right - 130;
  ball.vx = clamp((targetX - cpu.x) * 0.55 + (Math.random() - 0.5) * 60, -260, 260);
  ball.vy = -profile.speed;
  ball.vh = initialVhForWallTarget(ball.y - court.wallY, profile.speed, ball.height, wallTargetHeight(profile));
  ball.spin = ball.vx > 0 ? 0.35 : -0.35;
  ball.wallBounce = profile.wallBounce;
  ball.floorBounce = profile.floorBounce;
  ball.wallHeight = profile.wallHeight;
  ball.lastHit = "cpu";
  ball.floorBounces = 0;
  ball.wallTravelGrace = 0;
  ball.servePending = true;
  ball.serveFaultType = null;
  ball.bouncedSinceWall = false;
  trailPoints.length = 0;
  startSwing(cpu, "normal");
  setStatus("Rally");
}

function setSelectedShot(type) {
  selectedShot = shotProfiles[type] ? type : "normal";
  shotButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.shot === selectedShot);
  });
}

function startSwing(actor, style) {
  actor.swingTimer = 0.28;
  actor.swingStyle = style;
}

function swingPlayer(type = selectedShot) {
  if (gameOver) return;
  if (online.role === "guest") {
    sendOnline({ type: "shot", shot: type });
    setSelectedShot(type);
    return;
  }
  setSelectedShot(type);
  if (!ball.live && serving === "player") {
    serveFromPlayer();
    return;
  }
  hitBall(player, "player", selectedShot);
}

function hitBall(actor, name, shotType = "normal", targetAimX = aimX, targetAimHeight = aimHeight) {
  if (actor.cooldown > 0 || !ball.live || ball.lastHit === name || !ball.bouncedSinceWall) {
    return false;
  }

  const dx = ball.x - actor.x;
  const dy = ball.y - actor.y;
  const distance = Math.hypot(dx, dy);
  if (distance > actor.reach) return false;
  // Must be in a hittable height range for either player.
  if (ball.height < FLOOR_HEIGHT - 0.05 || ball.height > 2.6) return false;

  let baseProfile = shotProfiles[shotType] || shotProfiles.normal;
  // Apply the kill-shot charge multiplier on the player's kill before the
  // height-based shotSettings adjustments cascade.
  if (shotType === "kill" && name === "player") baseProfile = applyKillCharge(baseProfile);
  // Player aims with mouse height; CPU picks a target height via plannedShot logic.
  // For lob, force the wall target high enough to actually arc — otherwise a
  // low aim turns the lob into a slow flat shot, which defeats the button.
  const isHumanShot = name === "player" || (online.role === "host" && online.peerConnected && name === "cpu");
  const humanAimHeight = shotType === "lob" ? Math.max(targetAimHeight, 0.6) : targetAimHeight;
  const targetHeight = isHumanShot ? humanAimHeight : clamp(cpu.targetWallHeight ?? baseProfile.wallHeight, 0.05, 1);
  const profile = shotSettings(baseProfile, targetHeight);
  const depthSpeed = profile.speed;
  ball.vy = -depthSpeed;

  if (isHumanShot) {
    // Player can aim anywhere on the wall. Compute vx so the ball lands at aimX.
    const tToWall = Math.max(0.12, (ball.y - court.wallY) / depthSpeed);
    ball.vx = clamp((targetAimX - ball.x) / tToWall, -2200, 2200);
    ball.spin = clamp((targetAimX - ball.x) / 400, -2, 2) * profile.spin;
  } else {
    const opponentX = player.x;
    const angle = clamp((ball.x - actor.x) / actor.reach, -1, 1);
    const targetBias = clamp((opponentX - ball.x) / 420, -1, 1);
    const shotAim = clamp((cpu.targetAimX ?? 0) - angle * 0.05 - targetBias * 0.05, -0.85, 0.85);
    const sideVelocity = shotAim * profile.side + angle * 110 + targetBias * 90;
    ball.vx = clamp(sideVelocity, -380, 380);
    ball.spin = shotAim * profile.spin;
  }
  // Snap height to the contact height so the swing reads cleanly.
  ball.height = clamp(ball.height, FLOOR_HEIGHT, 2.4);
  ball.vh = initialVhForWallTarget(ball.y - court.wallY, depthSpeed, ball.height, wallTargetHeight(profile));
  ball.wallBounce = profile.wallBounce;
  ball.floorBounce = profile.floorBounce;
  ball.wallHeight = profile.wallHeight;
  ball.lastHit = name;
  ball.floorBounces = 0;
  ball.returnWindowGrace = 0;
  ball.wallTravelGrace = 0.14;
  ball.servePending = false;
  ball.serveFaultType = null;
  ball.bouncedSinceWall = false;
  actor.cooldown = shotType === "kill" ? 0.34 : shotType === "lob" ? 0.26 : 0.22;
  trailPoints.length = 0;
  startSwing(actor, shotType);
  setStatus(name === "player" ? `${profile.label} shot` : `${opponentName()} ${profile.label.toLowerCase()}`, 360);
  return true;
}

// Floating analog stick: pointerdown anywhere in the joystick element starts a
// drag, pointermove updates the knob, release recenters. Output state.x/state.y
// are normalized into [-1, 1] (clipped at the rim). Multiple sticks coexist
// because each captures its own pointerId.
function createJoystick(rootEl) {
  if (!rootEl) {
    return { x: 0, y: 0, active: false };
  }
  const base = rootEl.querySelector(".joystick__base");
  const knob = rootEl.querySelector(".joystick__knob");
  const state = { x: 0, y: 0, active: false, pointerId: null };

  function setKnob(dx, dy) {
    const rect = base.getBoundingClientRect();
    const r = Math.max(20, rect.width / 2);
    const dist = Math.hypot(dx, dy);
    let nx = dx;
    let ny = dy;
    if (dist > r) {
      nx = (dx / dist) * r;
      ny = (dy / dist) * r;
    }
    knob.style.transform = `translate(calc(-50% + ${nx}px), calc(-50% + ${ny}px))`;
    state.x = nx / r;
    state.y = ny / r;
  }

  function reset() {
    knob.style.transform = "translate(-50%, -50%)";
    state.x = 0;
    state.y = 0;
    state.active = false;
    state.pointerId = null;
    rootEl.classList.remove("active");
  }

  rootEl.addEventListener("pointerdown", (event) => {
    if (state.active) return;
    event.preventDefault();
    state.active = true;
    state.pointerId = event.pointerId;
    rootEl.classList.add("active");
    try {
      rootEl.setPointerCapture(event.pointerId);
    } catch (_) {
      // ignore — some browsers refuse capture on certain elements
    }
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    setKnob(event.clientX - cx, event.clientY - cy);
  });

  rootEl.addEventListener("pointermove", (event) => {
    if (!state.active || event.pointerId !== state.pointerId) return;
    event.preventDefault();
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    setKnob(event.clientX - cx, event.clientY - cy);
  });

  const release = (event) => {
    if (event.pointerId !== state.pointerId) return;
    event.preventDefault();
    reset();
  };
  rootEl.addEventListener("pointerup", release);
  rootEl.addEventListener("pointercancel", release);
  rootEl.addEventListener("lostpointercapture", release);

  return state;
}

const moveStick = createJoystick(moveStickEl);
const aimStick = createJoystick(aimStickEl);

// Joystick deadzone — under this threshold the stick is treated as centered so
// the player doesn't drift from a fingertip resting near center.
const STICK_DEADZONE = 0.14;

function applyDeadzone(value) {
  if (Math.abs(value) < STICK_DEADZONE) return 0;
  // Rescale so the usable range stays smooth past the deadzone.
  const sign = Math.sign(value);
  return sign * ((Math.abs(value) - STICK_DEADZONE) / (1 - STICK_DEADZONE));
}

function updateAimFromStick(dt) {
  const sx = applyDeadzone(aimStick.x);
  const sy = applyDeadzone(aimStick.y);
  if (sx === 0 && sy === 0) return;
  // Full deflection X traverses the court width in ~0.85s; full deflection Y
  // traverses the wall-height range in ~0.7s. Tuned to feel responsive without
  // overshooting on small phone screens.
  const courtWidth = court.right - court.left;
  aimX = clamp(aimX + sx * courtWidth * 1.18 * dt, court.left + 6, court.right - 6);
  // Pushing the stick UP (negative dy in screen coords) should raise the aim.
  aimHeight = clamp(aimHeight + -sy * 1.45 * dt, 0.05, 1);
  aim = (aimX - player.x) / 280;
  window.aim = aim;
}

function updatePlayer(dt) {
  const left = keys.has("a");
  const right = keys.has("d");
  const forward = keys.has("w");
  const back = keys.has("s");
  const stickX = applyDeadzone(moveStick.x);
  const stickY = applyDeadzone(moveStick.y);
  const xDirection = clamp((Number(right) - Number(left)) + stickX, -1, 1);
  const yDirection = clamp((Number(back) - Number(forward)) + stickY, -1, 1);
  const isWaitingToServe = !ball.live && serving === "player";
  const isWaitingToReceive = !ball.live && serving === "cpu";
  const minY = isWaitingToReceive ? court.serviceLine + 20 : court.shortLine + 24;
  const maxY = isWaitingToServe ? court.serviceLine - 26 : ball.live ? court.front + ACTIVE_BACK_MARGIN : court.front - 30;
  // During a live rally, let players chase airborne balls well past the court edge.
  const minX = isWaitingToServe || isWaitingToReceive ? court.left + 36 : court.left - ACTIVE_SIDE_MARGIN;
  const maxX = isWaitingToServe || isWaitingToReceive ? court.right - 36 : court.right + ACTIVE_SIDE_MARGIN;
  // Charging the kill bleeds movement so the shot is a real commitment.
  const moveMul = killCharge.charging ? KILL_CHARGE_MOVE_MULT : 1;
  player.x = clamp(player.x + xDirection * player.speed * moveMul * dt, minX, maxX);
  player.y = clamp(player.y + yDirection * player.depthSpeed * moveMul * dt, minY, maxY);
  player.cooldown = Math.max(0, player.cooldown - dt);
  player.swingTimer = Math.max(0, player.swingTimer - dt);

  window.aim = aim;

  if (!ball.live && serving === "player") {
    ball.x = player.x;
    ball.y = player.y - 48;
  }
}

// Step the ball physics forward in a sandbox copy to find the earliest moment
// the ball lands in a good hittable spot for the CPU after the wall hit.
// Returns { letGo: true } if the ball will land out of bounds — the CPU
// should not try to return it, since the player would just fault.
function predictCpuIntercept() {
  if (!ball.live || ball.lastHit === "cpu") return null;

  let px = ball.x;
  let py = ball.y;
  let ph = ball.height;
  let pvx = ball.vx;
  let pvy = ball.vy;
  let pvh = ball.vh;
  let bounced = ball.bouncedSinceWall;
  let floorBouncesPred = ball.floorBounces;
  const stepDt = 0.02;
  const maxSteps = 220;
  let landing = null;
  let intercept = null;

  for (let i = 0; i < maxSteps; i += 1) {
    pvh -= GRAVITY_Y * stepDt;
    px += pvx * stepDt;
    py += pvy * stepDt;
    ph += pvh * stepDt;

    if (py - ball.radius <= court.wallY && pvy < 0) {
      py = court.wallY + ball.radius;
      pvy = Math.abs(pvy) * ball.wallBounce;
      pvx *= 0.94;
      bounced = true;
    }

    if (ph <= FLOOR_HEIGHT && pvh < 0) {
      if (!bounced) return null;
      if (!landing) {
        landing = { x: px, y: py };
        // First floor bounce out of bounds laterally → player faults; let it go.
        if (px - ball.radius < court.left || px + ball.radius > court.right) {
          return { letGo: true };
        }
      }
      ph = FLOOR_HEIGHT;
      pvh = -pvh * ball.floorBounce * FLOOR_BOUNCE_BOOST;
      pvy *= 0.88;
      pvx *= 0.9;
      floorBouncesPred += 1;
      if (floorBouncesPred >= 2) break;
    }

    if (
      bounced &&
      !intercept &&
      py >= court.shortLine + 12 &&
      ph >= 0.35 &&
      ph <= 1.8 &&
      pvh < 0 // catch on the way down for cleanest swing
    ) {
      intercept = { x: px, y: py, h: ph, t: i * stepDt };
    }

    if (py > court.front + 60) break;
  }

  return intercept || (landing && { x: landing.x, y: landing.y + 30, h: 0.6, t: 0.8 });
}

function decideCpuShot() {
  const cpuDeep = cpu.y < court.serviceLine + 30;
  const playerDeep = player.y > court.serviceLine + 80;
  const playerLeft = player.x < 490;

  let shot = "normal";
  let wallH = 0.45;
  const roll = Math.random();

  if (cpuDeep && roll > 0.55) {
    shot = "kill";
    wallH = 0.16 + Math.random() * 0.12;
  } else if (playerDeep && roll > 0.55) {
    shot = "lob";
    wallH = 0.8 + Math.random() * 0.15;
  } else {
    shot = "normal";
    wallH = 0.38 + Math.random() * 0.25;
  }

  const aimSide = playerLeft ? 0.45 : -0.45;
  cpu.plannedShot = shot;
  cpu.targetWallHeight = wallH;
  cpu.targetAimX = aimSide + (Math.random() - 0.5) * 0.2;
}

function updateCpu(dt) {
  if (online.role === "host" && online.peerConnected) {
    updateRemoteOpponent(dt);
    return;
  }

  cpu.cooldown = Math.max(0, cpu.cooldown - dt);
  cpu.swingTimer = Math.max(0, cpu.swingTimer - dt);
  cpu.decisionTimer = Math.max(0, cpu.decisionTimer - dt);
  cpu.letItGo = false;

  let targetX = cpu.x;
  let targetY = cpu.y;

  if (!ball.live) {
    if (serving === "cpu") {
      targetX = 490;
      targetY = positions.serverY;
      ball.x = cpu.x;
    } else {
      targetX = 490;
      targetY = positions.receiverY - 18;
    }
  } else if (ball.lastHit === "cpu") {
    // Just hit — recover toward a neutral receiving stance, but bias away from player.
    targetX = clamp(490 + (player.x < 490 ? 60 : -60), court.left + 60, court.right - 60);
    targetY = positions.receiverY - 12;
  } else {
    const pred = predictCpuIntercept();
    if (pred && pred.letGo) {
      // Ball is heading out — don't chase, don't swing. Stand at neutral.
      cpu.letItGo = true;
      targetX = 490;
      targetY = positions.receiverY - 12;
    } else if (pred) {
      targetX = clamp(pred.x, court.left - ACTIVE_SIDE_MARGIN, court.right + ACTIVE_SIDE_MARGIN);
      targetY = clamp(pred.y, court.shortLine + 24, court.front + ACTIVE_BACK_MARGIN);
    } else {
      targetX = clamp(ball.x + ball.vx * 0.18, court.left - ACTIVE_SIDE_MARGIN, court.right + ACTIVE_SIDE_MARGIN);
      targetY = clamp(ball.y > 0 ? ball.y + 40 : positions.receiverY, court.shortLine + 24, court.front + ACTIVE_BACK_MARGIN);
    }
  }

  cpu.targetX = targetX;
  cpu.targetY = targetY;

  const dx = targetX - cpu.x;
  const dy = targetY - cpu.y;
  cpu.x += clamp(dx, -cpu.speed * dt, cpu.speed * dt);
  cpu.y += clamp(dy, -cpu.depthSpeed * dt, cpu.depthSpeed * dt);

  // CPU can step off court during live rallies to chase airborne balls.
  cpu.x = clamp(cpu.x, court.left - ACTIVE_SIDE_MARGIN, court.right + ACTIVE_SIDE_MARGIN);
  cpu.y = clamp(cpu.y, court.shortLine + 12, court.front + ACTIVE_BACK_MARGIN);

  if (!ball.live && serving === "cpu") {
    ball.x = cpu.x;
  }

  // Try to hit the ball if it's reachable and worth returning.
  if (
    ball.live &&
    ball.bouncedSinceWall &&
    ball.lastHit !== "cpu" &&
    cpu.cooldown <= 0 &&
    !cpu.letItGo
  ) {
    if (cpu.decisionTimer <= 0) {
      decideCpuShot();
      cpu.decisionTimer = 0.18;
    }

    const dxBall = ball.x - cpu.x;
    const dyBall = ball.y - cpu.y;
    const distance = Math.hypot(dxBall, dyBall);
    if (distance <= cpu.reach + 18 && ball.height >= 0.3 && ball.height <= 2.3) {
      hitBall(cpu, "cpu", cpu.plannedShot);
    }
  }
}

function updateRemoteOpponent(dt) {
  cpu.cooldown = Math.max(0, cpu.cooldown - dt);
  cpu.swingTimer = Math.max(0, cpu.swingTimer - dt);
  cpu.letItGo = false;

  const isWaitingToServe = !ball.live && serving === "cpu";
  const isWaitingToReceive = !ball.live && serving === "player";
  const minY = isWaitingToReceive ? court.serviceLine + 20 : court.shortLine + 24;
  const maxY = isWaitingToServe ? court.serviceLine - 26 : ball.live ? court.front + ACTIVE_BACK_MARGIN : court.front - 30;
  const minX = isWaitingToServe || isWaitingToReceive ? court.left + 36 : court.left - ACTIVE_SIDE_MARGIN;
  const maxX = isWaitingToServe || isWaitingToReceive ? court.right - 36 : court.right + ACTIVE_SIDE_MARGIN;

  cpu.x = clamp(cpu.x + online.remoteInput.moveX * cpu.speed * dt, minX, maxX);
  cpu.y = clamp(cpu.y + online.remoteInput.moveY * cpu.depthSpeed * dt, minY, maxY);

  if (!ball.live && serving === "cpu") {
    ball.x = cpu.x;
    ball.y = cpu.y - 48;
  }

  while (online.remoteInput.shots.length > 0) {
    const shot = online.remoteInput.shots.shift();
    if (!ball.live && serving === "cpu") {
      serveFromActor(cpu, "cpu", shot, online.remoteInput.aimX, online.remoteInput.aimHeight);
    } else {
      hitBall(cpu, "cpu", shot, online.remoteInput.aimX, online.remoteInput.aimHeight);
    }
  }
}

function updateBall(dt) {
  if (!ball.live) return;

  // Horizontal motion (court plane) + a tiny spin curve. No gravity here.
  ball.vx += ball.spin * 16 * dt;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  // Vertical motion (height) with real gravity.
  ball.vh -= GRAVITY_Y * dt;
  ball.height += ball.vh * dt;

  ball.wallTravelGrace = Math.max(0, ball.wallTravelGrace - dt);
  ball.returnWindowGrace = Math.max(0, ball.returnWindowGrace - dt);
  ball.wallFlash = Math.max(0, ball.wallFlash - dt);

  // No side walls — handball is open on the sides. Ball can fly off court;
  // players have to chase it before the second bounce ends the rally.

  // Front wall hit: ball reaches the back of the court. Reverse depth velocity.
  if (ball.y - ball.radius <= court.wallY && ball.vy < 0) {
    ball.y = court.wallY + ball.radius;
    ball.vy = Math.abs(ball.vy) * ball.wallBounce;
    ball.vx *= 0.94;
    ball.wallFlash = 0.22;
    ball.bouncedSinceWall = true;

    // Track where on the wall it hit (for the flash + scoring "below the line" rule).
    if (ball.height < FLOOR_HEIGHT + 0.05) {
      // Ball hit the floor before reaching the wall — treat as failure.
      // (Should already have been caught by the floor branch below; keep as safety.)
      if (ball.servePending) {
        serviceFault("Short serve");
      } else {
        finishRally(ball.lastHit === "player" ? "cpu" : "player", "Below the line");
      }
      return;
    }
  }

  // Floor bounce: real vh-based physics.
  if (ball.height <= FLOOR_HEIGHT && ball.vh < 0) {
    // Did the ball reach the wall first?
    if (!ball.bouncedSinceWall) {
      if (ball.wallTravelGrace > 0) {
        // Allow a brief grace if we were nearly there.
        ball.height = FLOOR_HEIGHT;
        ball.vh = 0;
        return;
      }

      if (ball.servePending) {
        serviceFault("Serve missed the wall");
        return;
      }

      finishRally(ball.lastHit === "player" ? "cpu" : "player", "Failed to reach the wall");
      return;
    }

    // Out of bounds on first bounce after wall hit -> rally over (no second serve).
    const isFirstFloorBounce = ball.floorBounces === 0;
    const firstBounceOut = ball.x - ball.radius < court.left || ball.x + ball.radius > court.right;
    if (isFirstFloorBounce && firstBounceOut) {
      // Serve-out is treated as an immediate side-out, not a fault that gives a second serve.
      const winner = ball.lastHit === "player" ? "cpu" : "player";
      const reason = ball.servePending ? "Serve out" : "Ball out";
      finishRally(winner, reason);
      return;
    }

    // Real bounce: reverse vertical velocity with restitution.
    ball.height = FLOOR_HEIGHT;
    ball.vh = -ball.vh * ball.floorBounce * FLOOR_BOUNCE_BOOST;
    ball.vy *= 0.88; // a touch of forward energy bleed each bounce
    ball.vx *= 0.9;
    ball.spin *= 0.7;
    ball.floorBounces += 1;

    if (ball.servePending) {
      if (ball.serveFaultType) {
        serviceFault(ball.serveFaultType);
        return;
      }
      makeServeLegal();
      return;
    }

    // Two floor bounces ends the rally immediately — no grace window, no late hits.
    if (ball.floorBounces >= 2) {
      const winner = ball.lastHit;
      finishRally(winner, `${winner === "player" ? "Player" : "CPU"} wins rally`);
      return;
    }
  }

  // Past the front line and not coming back -> out.
  if (ball.y > court.front + 220) {
    finishRally(ball.lastHit === "player" ? "cpu" : "player", "Ball out");
  }
}

function updateScene(dt) {
  resizeRenderer();

  const playerWorld = new THREE.Vector3(mapX(player.x), 0, mapY(player.y));
  const cpuWorld = new THREE.Vector3(mapX(cpu.x), 0, mapY(cpu.y));
  playerRig.group.position.copy(playerWorld);
  cpuRig.group.position.copy(cpuWorld);
  cpuRig.group.rotation.y = Math.PI;

  animateCharacter(playerRig, player, dt);
  animateCharacter(cpuRig, cpu, dt);

  const ballWorld = new THREE.Vector3(mapX(ball.x), ballHeight(), mapY(ball.y));
  ballMesh.position.copy(ballWorld);
  ballMesh.rotation.x += dt * (ball.vy / 65);
  ballMesh.rotation.z += dt * (ball.vx / 90);

  updateTrail(ballWorld);
  updateAimGuide();
  updateWallFlash();

  const cameraActor = online.role === "guest" ? cpu : player;
  const shoulderOffset = clamp((cameraActor.x - 490) / 230, -1.4, 1.4);
  const cameraZ = Math.max(mapY(cameraActor.y) + 8.4, world.frontZ + 4.5);
  camera.position.lerp(new THREE.Vector3(mapX(cameraActor.x) - 1.8 + shoulderOffset, 5.9, cameraZ), 0.08);
  camera.lookAt(mapX(cameraActor.x) * 0.12, 2.8, world.wallZ + 0.6);
  renderer.render(scene, camera);
}

function ballHeight() {
  if (!ball.live && serving === "player") return 1.35;
  if (!ball.live && serving === "cpu") return 1.25;
  return Math.max(FLOOR_HEIGHT, ball.height);
}

function animateCharacter(rig, actor) {
  const swingProgress = actor.swingTimer > 0 ? 1 - actor.swingTimer / 0.28 : 1;
  const pulse = Math.sin(performance.now() / 120) * 0.025;
  rig.body.position.y = 0.82 + pulse;
  rig.head.position.y = 1.38 + pulse;

  const hitSnap = Math.sin(swingProgress * Math.PI);
  const lift = actor.swingStyle === "lob" ? 0.72 : actor.swingStyle === "kill" ? -0.35 : 0.1;
  const reach = actor.swingStyle === "kill" ? 1.3 : actor.swingStyle === "lob" ? 0.9 : 1.05;
  rig.rightArm.group.rotation.z = -0.25 - hitSnap * 1.1 * reach;
  rig.rightArm.group.rotation.x = lift * hitSnap;
  rig.rightArm.group.rotation.y = -0.35 * hitSnap;
  rig.leftArm.group.rotation.z = 0.45 + hitSnap * 0.25;
  rig.leftArm.group.rotation.x = -0.15 * hitSnap;
  rig.reach.material.opacity = actor.cooldown > 0 ? 0.72 : 0.32;
}

function updateTrail(ballWorld) {
  if (ball.live) {
    trailPoints.push(ballWorld.clone());
    if (trailPoints.length > 22) trailPoints.shift();
  } else if (trailPoints.length > 0) {
    trailPoints.shift();
  }

  if (trailPoints.length < 2) {
    ballTrail.visible = false;
    return;
  }

  ballTrail.visible = true;
  ballTrail.geometry.dispose();
  ballTrail.geometry = new THREE.BufferGeometry().setFromPoints(trailPoints);
}

function updateAimGuide() {
  const guideActor = online.role === "guest" ? cpu : player;
  const start = new THREE.Vector3(mapX(guideActor.x), 1.45, mapY(guideActor.y) - 1.2);
  const targetX = clamp(aimX, court.left + 6, court.right - 6);
  const end = new THREE.Vector3(mapX(targetX), wallTargetHeight({ wallHeight: aimHeight }), world.wallZ + 0.05);
  const mid = new THREE.Vector3((start.x + end.x) / 2, 2.4 + aimHeight * 2.2, -2.5);
  const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
  const points = curve.getPoints(32);
  aimLine.geometry.dispose();
  aimLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
  aimLine.computeLineDistances();
  aimTarget.position.copy(end);
  aimTarget.lookAt(camera.position);
}

function updateWallFlash() {
  materials.flash.opacity = ball.wallFlash * 2.3;
  wallFlashMesh.visible = ball.wallFlash > 0;
  wallFlashMesh.position.x = mapX(ball.x);
  wallFlashMesh.position.y = wallTargetHeight({ wallHeight: ball.wallHeight });
  wallFlashMesh.position.z = world.wallZ + 0.06;
  wallFlashMesh.lookAt(camera.position);
}

function resizeRenderer() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width === width * renderer.getPixelRatio() && canvas.height === height * renderer.getPixelRatio()) {
    return;
  }

  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function tick(now) {
  const dt = Math.min(0.033, (now - lastTime) / 1000);
  lastTime = now;

  if (online.role === "guest") {
    updateKillCharge(dt);
    updateAimFromStick(dt);
    sendLocalInput(dt);
    smoothRemoteState(dt);
    updateScene(dt);
    updateChargeUI();
    requestAnimationFrame(tick);
    return;
  }

  if (messageTimer > 0) {
    messageTimer -= dt * 1000;
    if (messageTimer <= 0 && ball.live) setStatus("Rally");
  }

  updateKillCharge(dt);
  updateAimFromStick(dt);
  updatePlayer(dt);
  updateCpu(dt);
  updateBall(dt);
  updateScene(dt);
  updateChargeUI();
  if (online.role === "host") sendSnapshot();
  requestAnimationFrame(tick);
}

function updateKillCharge(dt) {
  if (killCharge.charging) {
    killCharge.amount = clamp(killCharge.amount + dt / KILL_CHARGE_TIME, 0, 1);
  } else if (killCharge.amount > 0) {
    // Decay quickly when not charging so a stale value never leaks into a
    // later kill press.
    killCharge.amount = Math.max(0, killCharge.amount - dt * 6);
  }
}

function updateChargeUI() {
  if (!chargeMeterEl || !chargeFillEl) return;
  const visible = killCharge.charging || killCharge.amount > 0.02;
  chargeMeterEl.classList.toggle("visible", visible);
  chargeMeterEl.classList.toggle("full", killCharge.amount >= 0.999);
  // Slight ease so the fill is not visibly twitchy at low charge.
  chargeFillEl.style.width = `${(killCharge.amount * 100).toFixed(1)}%`;
  // Tint the in-game aim guide so the player sees the threat level on the wall
  // target without looking down at the meter.
  const r = 0xf2 + (0xe8 - 0xf2) * killCharge.amount;
  const g = 0xca + (0x4f - 0xca) * killCharge.amount;
  const b = 0x72 + (0x45 - 0x72) * killCharge.amount;
  const tint = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  if (materials.aim && materials.aim.color) materials.aim.color.setHex(tint);
  if (aimTarget && aimTarget.material && aimTarget.material.color) {
    aimTarget.material.color.setHex(tint);
  }
}

function sendOnline(payload) {
  if (!online.socket || online.socket.readyState !== WebSocket.OPEN) return;
  online.socket.send(JSON.stringify(payload));
}

function multiplayerServerUrl() {
  const params = new URLSearchParams(location.search);
  const raw = (params.get("server") || "").trim();
  if (!raw) {
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      return `${protocol}//${location.host}`;
    }
    return DEFAULT_MULTIPLAYER_SERVER;
  }

  if (raw.startsWith("wss://") || raw.startsWith("ws://")) return raw;
  if (raw.startsWith("https://")) return `wss://${raw.slice("https://".length)}`;
  if (raw.startsWith("http://")) return `ws://${raw.slice("http://".length)}`;
  return `wss://${raw}`;
}

function connectOnline(role) {
  const room = (roomInput?.value || "handball").trim() || "handball";
  const targetUrl = multiplayerServerUrl();
  if (online.socket) online.socket.close();
  const socket = new WebSocket(targetUrl);
  online.socket = socket;
  online.role = role;
  online.room = room;
  online.peerConnected = false;
  online.targetUrl = targetUrl;
  online.hasJoined = false;
  online.lastError = "";
  setStatus(`Connecting to ${targetUrl}`, 1200);
  updateOnlineUI();

  socket.addEventListener("open", () => {
    setStatus(`Joining room ${room}`, 900);
    sendOnline({ type: "join", room, role });
  });

  socket.addEventListener("message", (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    handleOnlineMessage(data);
  });

  socket.addEventListener("error", () => {
    if (online.socket !== socket) return;
    online.lastError = `Connection failed: ${online.targetUrl}`;
    updateOnlineUI();
    setStatus("Could not connect to multiplayer server", 1500);
  });

  socket.addEventListener("close", () => {
    if (online.socket !== socket) return;
    const failedBeforeJoin = !online.hasJoined;
    online.role = "offline";
    online.peerConnected = false;
    online.socket = null;
    if (failedBeforeJoin && !online.lastError) {
      online.lastError = `Disconnected: ${online.targetUrl}`;
    }
    updateOnlineUI();
    setStatus(
      failedBeforeJoin ? "Online failed. Check server URL or wake Render." : "Online disconnected",
      1400,
    );
  });
}

function handleOnlineMessage(data) {
  if (data.type === "joined") {
    online.role = data.role;
    online.room = data.room;
    online.hasJoined = true;
    online.peerConnected = false;
    online.lastError = "";
    updateOnlineUI();
    if (online.role === "host") {
      restartGame();
      setStatus("Waiting for Player 2");
    } else {
      setStatus("Connected. Waiting for host state");
    }
    return;
  }

  if (data.type === "peer-joined") {
    online.peerConnected = true;
    updateOnlineUI();
    if (online.role === "host") {
      resetPoint(serving);
      setStatus("Player 2 connected", 900);
      sendSnapshot(true);
    }
    return;
  }

  if (data.type === "peer-left") {
    online.peerConnected = false;
    updateOnlineUI();
    setStatus("Player 2 disconnected", 1200);
    return;
  }

  if (online.role === "host" && data.type === "input") {
    online.remoteInput.moveX = clamp(data.moveX || 0, -1, 1);
    online.remoteInput.moveY = clamp(data.moveY || 0, -1, 1);
    online.remoteInput.aimX = clamp(data.aimX || 480, court.left + 6, court.right - 6);
    online.remoteInput.aimHeight = clamp(data.aimHeight || shotProfiles.normal.wallHeight, 0.05, 1);
    return;
  }

  if (online.role === "host" && data.type === "shot") {
    online.remoteInput.shots.push(shotProfiles[data.shot] ? data.shot : "normal");
    return;
  }

  if (online.role === "guest" && data.type === "snapshot") {
    online.peerConnected = true;
    updateOnlineUI();
    applySnapshot(data.state);
  }
}

function actorState(actor) {
  return {
    x: Math.round(actor.x * 10) / 10,
    y: Math.round(actor.y * 10) / 10,
    cooldown: Math.round(actor.cooldown * 1000) / 1000,
    swingTimer: Math.round(actor.swingTimer * 1000) / 1000,
    swingStyle: actor.swingStyle,
  };
}

function ballState() {
  return {
    x: Math.round(ball.x * 10) / 10,
    y: Math.round(ball.y * 10) / 10,
    height: Math.round(ball.height * 1000) / 1000,
    vx: Math.round(ball.vx * 10) / 10,
    vy: Math.round(ball.vy * 10) / 10,
    vh: Math.round(ball.vh * 1000) / 1000,
    spin: Math.round(ball.spin * 1000) / 1000,
    wallBounce: ball.wallBounce,
    floorBounce: ball.floorBounce,
    wallHeight: ball.wallHeight,
    wallFlash: ball.wallFlash,
    live: ball.live,
    lastHit: ball.lastHit,
    floorBounces: ball.floorBounces,
    returnWindowGrace: ball.returnWindowGrace,
    wallTravelGrace: ball.wallTravelGrace,
    servePending: ball.servePending,
    serveFaultType: ball.serveFaultType,
    bouncedSinceWall: ball.bouncedSinceWall,
  };
}

function applyActorState(actor, state, smoothing = 1) {
  if (!state) return;
  actor.x += (state.x - actor.x) * smoothing;
  actor.y += (state.y - actor.y) * smoothing;
  actor.cooldown = state.cooldown;
  actor.swingTimer = state.swingTimer;
  actor.swingStyle = state.swingStyle;
}

function applyBallState(state, smoothing = 1) {
  if (!state) return;
  ball.x += (state.x - ball.x) * smoothing;
  ball.y += (state.y - ball.y) * smoothing;
  ball.height += (state.height - ball.height) * smoothing;
  ball.vx = state.vx;
  ball.vy = state.vy;
  ball.vh = state.vh;
  ball.spin = state.spin;
  ball.wallBounce = state.wallBounce;
  ball.floorBounce = state.floorBounce;
  ball.wallHeight = state.wallHeight;
  ball.wallFlash = state.wallFlash;
  ball.live = state.live;
  ball.lastHit = state.lastHit;
  ball.floorBounces = state.floorBounces;
  ball.returnWindowGrace = state.returnWindowGrace;
  ball.wallTravelGrace = state.wallTravelGrace;
  ball.servePending = state.servePending;
  ball.serveFaultType = state.serveFaultType;
  ball.bouncedSinceWall = state.bouncedSinceWall;
}

function sendSnapshot(force = false) {
  const now = performance.now();
  if (!force && now - online.lastSend < 50) return;
  online.lastSend = now;
  sendOnline({
    type: "snapshot",
    state: {
      player: actorState(player),
      cpu: actorState(cpu),
      ball: ballState(),
      playerScore,
      cpuScore,
      serving,
      faultCount,
      gameOver,
      status: statusText.textContent,
      force,
    },
  });
}

function applySnapshot(state) {
  if (!state) return;
  online.remoteState = state;
  const snap = state.force ? 1 : 0.45;
  applyActorState(player, state.player, snap);
  applyActorState(cpu, state.cpu, snap);
  applyBallState(state.ball, snap);
  playerScore = state.playerScore;
  cpuScore = state.cpuScore;
  serving = state.serving;
  faultCount = state.faultCount;
  gameOver = state.gameOver;
  updateScore();
  if (state.status) setStatus(state.status);
}

function smoothRemoteState(dt) {
  const state = online.remoteState;
  if (!state) return;
  const smoothing = 1 - Math.pow(0.0015, dt);
  applyActorState(player, state.player, smoothing);
  applyActorState(cpu, state.cpu, smoothing);
  applyBallState(state.ball, smoothing);
}

function sendLocalInput(dt) {
  online.lastInputSend += dt * 1000;
  if (online.lastInputSend < 24) return;
  online.lastInputSend = 0;
  const left = keys.has("a");
  const right = keys.has("d");
  const forward = keys.has("w");
  const back = keys.has("s");
  const moveX = clamp((Number(right) - Number(left)) + applyDeadzone(moveStick.x), -1, 1);
  const moveY = clamp((Number(back) - Number(forward)) + applyDeadzone(moveStick.y), -1, 1);
  sendOnline({ type: "input", moveX, moveY, aimX, aimHeight });
}

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  // event.code is layout-independent (KeyL, KeyJ, …). Falling back to it for
  // the shot keys means the bindings still work on Dvorak/AZERTY, where the
  // physical "L" key may produce a different character.
  const code = event.code;
  const isLobKey = key === "l" || code === "KeyL";
  const isKillKey = key === "k" || code === "KeyK";
  const isNormalKey = key === " " || key === "j" || code === "KeyJ" || code === "Space";

  if (
    ["w", "a", "s", "d", " ", "j", "k", "l"].includes(key) ||
    ["KeyW", "KeyA", "KeyS", "KeyD", "Space", "KeyJ", "KeyK", "KeyL"].includes(code)
  ) {
    event.preventDefault();
  }
  keys.add(key);

  if (isNormalKey) swingPlayer("normal");
  if (isKillKey && !event.repeat) startKillCharge("key");
  if (isLobKey) swingPlayer("lob");
  if (key === "r" || code === "KeyR") restartGame();
});

window.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  const code = event.code;
  keys.delete(key);
  if (key === "k" || code === "KeyK") releaseKillCharge("key");
});

function updateAimFromPointer(event) {
  const rect = canvas.getBoundingClientRect();
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
  raycaster.setFromCamera(pointerNdc, camera);

  const [hit] = raycaster.intersectObject(wall);
  if (hit) {
    const worldX = clamp(hit.point.x, -world.width / 2, world.width / 2);
    aimX = clamp(((worldX / world.width) + 0.5) * (court.right - court.left) + court.left, court.left + 6, court.right - 6);
    aimHeight = clamp((hit.point.y - 1.3) / 4.6, 0.05, 1);
  } else {
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const y = (event.clientY - rect.top) / rect.height;
    aimX = clamp((x / canvas.width) * (court.right - court.left) + court.left, court.left + 6, court.right - 6);
    aimHeight = clamp(1 - (y - 0.2) / 0.5, 0.05, 1);
  }

  // Derive normalized aim for spin/CPU compatibility.
  aim = (aimX - player.x) / 280;
  window.aim = aim;
}

canvas.addEventListener("pointermove", (event) => {
  // On touch, the right-thumb joystick owns aim. Letting raw canvas touches
  // also drive aim would yank the reticle around as the player drags.
  if (event.pointerType === "touch") return;
  updateAimFromPointer(event);
});

canvas.addEventListener("pointerdown", (event) => {
  // Touches on the canvas should not fire shots — the on-screen Regular/Kill
  // buttons are the dedicated fire controls on mobile.
  if (event.pointerType === "touch") return;
  event.preventDefault();
  updateAimFromPointer(event);
  if (event.button === 0) {
    canvas.setPointerCapture(event.pointerId);
    swingPlayer("normal");
  } else if (event.button === 1) {
    swingPlayer("lob");
  } else if (event.button === 2) {
    startKillCharge("mouse");
  }
});

canvas.addEventListener("pointerup", (event) => {
  if (event.pointerType === "touch") return;
  if (event.button === 2) {
    event.preventDefault();
    releaseKillCharge("mouse");
  }
});

canvas.addEventListener("pointercancel", (event) => {
  if (event.pointerType === "touch") return;
  if (killCharge.source === "mouse") cancelKillCharge();
});

// Right and middle buttons go through mousedown/mouseup. Browsers handle
// non-primary pointer buttons inconsistently, but mouse events for button 1/2
// are reliable across Chrome, Firefox, and Safari. mousedown is also where we
// must call preventDefault to stop Windows' middle-button auto-scroll widget.
canvas.addEventListener("mousedown", (event) => {
  if (event.button === 1) {
    event.preventDefault();
    updateAimFromPointer(event);
    swingPlayer("lob");
  } else if (event.button === 2) {
    // Right click = start charging the kill shot. Don't fire here — fire on
    // mouseup.
    event.preventDefault();
    updateAimFromPointer(event);
    startKillCharge("mouse");
  }
});

canvas.addEventListener("mouseup", (event) => {
  if (event.button === 2) {
    event.preventDefault();
    releaseKillCharge("mouse");
  }
});

// If the cursor leaves the canvas while right-click is held, the canvas may
// not see the mouseup. Catch it on the window so the charge always resolves.
window.addEventListener("mouseup", (event) => {
  if (event.button === 2 && killCharge.source === "mouse") {
    releaseKillCharge("mouse");
  }
});

// If the user alt-tabs or the page hides mid-charge, cancel the charge so it
// doesn't fire on return as a stale full-power shot.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) cancelKillCharge();
});

// Middle click also tries to open links in new tabs on bubbled `auxclick`.
// Cancel that so the canvas is a clean shot input.
canvas.addEventListener("auxclick", (event) => {
  if (event.button === 1) event.preventDefault();
});

canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

shotButtons.forEach((button) => {
  const shot = button.dataset.shot;
  if (shot === "kill") {
    // Kill is press-and-hold to charge. Use pointer events so a single handler
    // works for mouse, touch, and pen.
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      try {
        button.setPointerCapture(event.pointerId);
      } catch (_) {
        // Some browsers refuse capture on disabled/hidden buttons; safe to ignore.
      }
      button.classList.add("charging");
      startKillCharge("button");
    });
    const release = (event) => {
      if (killCharge.source !== "button") return;
      event.preventDefault();
      button.classList.remove("charging");
      releaseKillCharge("button");
    };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", () => {
      button.classList.remove("charging");
      cancelKillCharge();
    });
    button.addEventListener("lostpointercapture", () => {
      button.classList.remove("charging");
      // If pointer capture is lost we shouldn't auto-fire — the player likely
      // dragged out of the button intentionally or the OS interrupted us.
      cancelKillCharge();
    });
    // The button's default click would still fire on quick taps; suppress it
    // because pointerup already handled the charge release.
    button.addEventListener("click", (event) => event.preventDefault());
  } else {
    button.addEventListener("click", () => swingPlayer(shot));
  }
});

if (restartBtn) {
  restartBtn.addEventListener("click", () => {
    if (online.role === "guest") {
      setStatus("Only the host can restart online", 900);
      return;
    }
    restartGame();
    // Move focus off the button so subsequent Space/Enter doesn't re-trigger
    // it instead of serving the next point.
    restartBtn.blur();
  });
}

if (hostBtn) {
  hostBtn.addEventListener("click", () => connectOnline("host"));
}

if (joinBtn) {
  joinBtn.addEventListener("click", () => connectOnline("guest"));
}

resizeRenderer();
setSelectedShot("normal");
updateOnlineUI();
restartGame();
requestAnimationFrame(tick);
