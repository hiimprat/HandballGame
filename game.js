import * as THREE from "three";

const canvas = document.querySelector("#gameCanvas");
const playerScoreEl = document.querySelector("#playerScore");
const cpuScoreEl = document.querySelector("#cpuScore");
const statusText = document.querySelector("#statusText");
const shotButtons = [...document.querySelectorAll("[data-shot]")];

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
  ball: new THREE.MeshStandardMaterial({ color: 0xe84f45, roughness: 0.36 }),
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
  const carry = 0.55 + height * 0.55;
  const floorLife = 0.7 + height * 0.3;
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
    ball.y = cpu.y + 52;
    setStatus("CPU serving");
    window.setTimeout(() => {
      if (!gameOver && !ball.live && serving === "cpu") {
        cpuServe();
      }
    }, 700);
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
    setStatus(`${winner === "player" ? "Player" : "CPU"} wins ${playerScore}-${cpuScore}. Press R`);
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
    setStatus(`${type}. ${oldServer === "player" ? "Player" : "CPU"} side out`, 900);
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
    ball.y = cpu.y + 52;
    setStatus("CPU second serve");
    window.setTimeout(() => {
      if (!gameOver && !ball.live && serving === "cpu") {
        cpuServe();
      }
    }, 700);
  }
}

function serveFromPlayer() {
  const profile = shotSettings(shotProfiles[selectedShot], selectedShot === "normal" ? Math.max(aimHeight, 0.34) : aimHeight);
  ball.live = true;
  ball.x = player.x;
  ball.y = player.y - 46;
  ball.height = SWING_HEIGHT;
  // Compute vx so the ball actually arrives at aimX on the wall.
  const tToWall = Math.max(0.12, (ball.y - court.wallY) / profile.speed);
  ball.vy = -profile.speed;
  ball.vx = clamp((aimX - ball.x) / tToWall, -2200, 2200);
  ball.vh = initialVhForWallTarget(ball.y - court.wallY, profile.speed, ball.height, wallTargetHeight(profile));
  ball.spin = clamp((aimX - ball.x) / 400, -2, 2) * profile.spin;
  ball.wallBounce = profile.wallBounce;
  ball.floorBounce = profile.floorBounce;
  ball.wallHeight = profile.wallHeight;
  ball.lastHit = "player";
  ball.floorBounces = 0;
  ball.returnWindowGrace = 0;
  ball.wallTravelGrace = 0;
  ball.servePending = true;
  ball.serveFaultType = profile.wallHeight <= 0.3 ? "Short serve" : null;
  ball.bouncedSinceWall = false;
  trailPoints.length = 0;
  startSwing(player, selectedShot);
  setStatus("Rally");
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
  setSelectedShot(type);
  if (!ball.live && serving === "player") {
    serveFromPlayer();
    return;
  }
  hitBall(player, "player", selectedShot);
}

function hitBall(actor, name, shotType = "normal") {
  if (actor.cooldown > 0 || !ball.live || ball.lastHit === name || !ball.bouncedSinceWall) {
    return false;
  }

  const dx = ball.x - actor.x;
  const dy = ball.y - actor.y;
  const distance = Math.hypot(dx, dy);
  if (distance > actor.reach) return false;
  // Must be in a hittable height range for either player.
  if (ball.height < FLOOR_HEIGHT - 0.05 || ball.height > 2.6) return false;

  const baseProfile = shotProfiles[shotType] || shotProfiles.normal;
  // Player aims with mouse height; CPU picks a target height via plannedShot logic.
  const targetHeight = name === "player" ? aimHeight : clamp(cpu.targetWallHeight ?? baseProfile.wallHeight, 0.05, 1);
  const profile = shotSettings(baseProfile, targetHeight);
  const depthSpeed = profile.speed;
  ball.vy = -depthSpeed;

  if (name === "player") {
    // Player can aim anywhere on the wall. Compute vx so the ball lands at aimX.
    const tToWall = Math.max(0.12, (ball.y - court.wallY) / depthSpeed);
    ball.vx = clamp((aimX - ball.x) / tToWall, -2200, 2200);
    ball.spin = clamp((aimX - ball.x) / 400, -2, 2) * profile.spin;
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
  actor.cooldown = shotType === "kill" ? 0.34 : 0.22;
  trailPoints.length = 0;
  startSwing(actor, shotType);
  setStatus(name === "player" ? `${profile.label} shot` : `CPU ${profile.label.toLowerCase()}`, 360);
  return true;
}

function updatePlayer(dt) {
  const left = keys.has("a");
  const right = keys.has("d");
  const forward = keys.has("w");
  const back = keys.has("s");
  const xDirection = Number(right) - Number(left);
  const yDirection = Number(back) - Number(forward);
  const isWaitingToServe = !ball.live && serving === "player";
  const isWaitingToReceive = !ball.live && serving === "cpu";
  const minY = isWaitingToReceive ? court.serviceLine + 20 : court.shortLine + 24;
  const maxY = isWaitingToServe ? court.serviceLine - 26 : court.front - 30;
  // Allow stepping ~30 court units past either side wall to chase off-court balls.
  const minX = isWaitingToServe || isWaitingToReceive ? court.left + 36 : court.left - 30;
  const maxX = isWaitingToServe || isWaitingToReceive ? court.right - 36 : court.right + 30;
  player.x = clamp(player.x + xDirection * player.speed * dt, minX, maxX);
  player.y = clamp(player.y + yDirection * player.depthSpeed * dt, minY, maxY);
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
      pvh = -pvh * ball.floorBounce;
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
      targetX = clamp(pred.x, court.left - 30, court.right + 30);
      targetY = clamp(pred.y, court.shortLine + 24, court.front - 30);
    } else {
      targetX = clamp(ball.x + ball.vx * 0.18, court.left - 30, court.right + 30);
      targetY = clamp(ball.y > 0 ? ball.y + 40 : positions.receiverY, court.shortLine + 24, court.front - 30);
    }
  }

  cpu.targetX = targetX;
  cpu.targetY = targetY;

  const dx = targetX - cpu.x;
  const dy = targetY - cpu.y;
  cpu.x += clamp(dx, -cpu.speed * dt, cpu.speed * dt);
  cpu.y += clamp(dy, -cpu.depthSpeed * dt, cpu.depthSpeed * dt);

  // CPU can step a bit past the side walls to chase off-court balls.
  cpu.x = clamp(cpu.x, court.left - 30, court.right + 30);
  cpu.y = clamp(cpu.y, court.shortLine + 12, court.front - 24);

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
    ball.vh = -ball.vh * ball.floorBounce;
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

  const shoulderOffset = clamp((player.x - 490) / 230, -1.4, 1.4);
  const cameraZ = Math.max(mapY(player.y) + 8.4, world.frontZ + 4.5);
  camera.position.lerp(new THREE.Vector3(mapX(player.x) - 1.8 + shoulderOffset, 5.9, cameraZ), 0.08);
  camera.lookAt(mapX(player.x) * 0.12, 2.8, world.wallZ + 0.6);
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
  const start = new THREE.Vector3(mapX(player.x), 1.45, mapY(player.y) - 1.2);
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

  if (messageTimer > 0) {
    messageTimer -= dt * 1000;
    if (messageTimer <= 0 && ball.live) setStatus("Rally");
  }

  updatePlayer(dt);
  updateCpu(dt);
  updateBall(dt);
  updateScene(dt);
  requestAnimationFrame(tick);
}

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (["w", "a", "s", "d", " ", "j", "k"].includes(key)) {
    event.preventDefault();
  }
  keys.add(key);

  if (key === " " || key === "j") swingPlayer("normal");
  if (key === "k") swingPlayer("kill");
  if (key === "r") restartGame();
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.key.toLowerCase());
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

canvas.addEventListener("pointermove", updateAimFromPointer);

canvas.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  updateAimFromPointer(event);
  if (event.button === 2) {
    swingPlayer("kill");
    return;
  }

  if (event.button === 0) {
    swingPlayer("normal");
  }
});

canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

shotButtons.forEach((button) => {
  button.addEventListener("click", () => swingPlayer(button.dataset.shot));
});

resizeRenderer();
setSelectedShot("normal");
restartGame();
requestAnimationFrame(tick);
