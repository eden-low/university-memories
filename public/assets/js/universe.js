import * as THREE from "../../vendor/three.module.js";

const app = document.getElementById("universe-app");
const canvasHost = document.getElementById("universe-canvas");
const archiveLink = document.getElementById("archive-link");
const loadingState = document.getElementById("loading-state");
const loadingCopy = document.getElementById("loading-copy");
const targetLabel = document.getElementById("target-label");
const selectionContext = document.getElementById("selection-context");
const selectionNumber = document.getElementById("selection-number");
const selectionTitle = document.getElementById("selection-title");
const viewMemoryButton = document.getElementById("view-memory");
const releaseMemoryButton = document.getElementById("release-memory");
const help = document.getElementById("universe-help");
const fallback = document.getElementById("universe-fallback");
const liveRegion = document.getElementById("universe-live");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const query = new URLSearchParams(window.location.search);
const requestedPhoto = Number(query.get("photo"));
const restoreRequested = query.get("restore") === "1";
const HELP_STORAGE_KEY = "memory-universe-help-v1";
const SESSION_STATE_KEY = "memory-universe-state-v1";
const PLACEHOLDERS = new Set(["", "待整理", "日期待填写", "活动待填写", "这张照片的故事，等你来填写"]);
const TITLE_PLACEHOLDER = /^MEMORY\s+\d+$/i;
const CONFIG = {
  cameraFov: 44,
  cameraZ: 14.2,
  textureConcurrency: 6,
  pixelRatioCap: 1.5,
  dragSensitivityX: .0034,
  dragSensitivityY: .0028,
  maximumVelocity: 1.05,
  ambientSpeed: .018,
  selectionDuration: 560,
  releaseDuration: 520
};

const state = {
  mode: "IDLE",
  activeTargetId: null,
  selectedMemoryId: null,
  dragging: false,
  pointerTargeting: false,
  rotationX: 0,
  rotationY: 0,
  velocityX: 0,
  velocityY: 0,
  fieldDim: 1,
  revealStartedAt: 0,
  lastNearestCheck: 0,
  lastFrameAt: 0,
  frameWindowStartedAt: 0,
  frameWindowCount: 0,
  observedFps: 0,
  animationFrame: 0,
  running: false
};

let renderer;
let scene;
let camera;
let universeGroup;
let dust;
let controls;
let memories = [];
let cards = [];
let sharedPlaneGeometry;
const cardById = new Map();
const interactiveMeshes = [];
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const temporaryPosition = new THREE.Vector3();
const temporaryDirection = new THREE.Vector3();
const temporaryQuaternion = new THREE.Quaternion();
const universeWorldQuaternion = new THREE.Quaternion();
const localCameraQuaternion = new THREE.Quaternion();
const neutralTint = new THREE.Color(0xe5ddd5);
const highlightTint = new THREE.Color(0xffffff);

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function easeInOutCubic(value) {
  return value < .5 ? 4 * value ** 3 : 1 - ((-2 * value + 2) ** 3) / 2;
}

function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seedValue) {
  let seed = hashString(seedValue);
  return () => {
    seed += 0x6D2B79F5;
    let value = seed;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function isPlaceholderValue(field, value) {
  const normalized = String(value ?? "").trim();
  if (PLACEHOLDERS.has(normalized)) return true;
  return field === "title" && TITLE_PLACEHOLDER.test(normalized);
}

function memoryNumber(memory) {
  const index = memories.findIndex(item => item.id === memory.id || item.image === memory.image);
  return index >= 0 ? index + 1 : Number(memory.id) || 1;
}

function memoryLabel(memory) {
  return `MEMORY ${String(memoryNumber(memory)).padStart(2, "0")}`;
}

function displayTitle(memory) {
  return isPlaceholderValue("title", memory.title) ? "" : String(memory.title).trim();
}

function announce(message) {
  liveRegion.textContent = "";
  window.requestAnimationFrame(() => { liveRegion.textContent = message; });
}

function markUniverseReady() {
  window.clearTimeout(window.__universeFallbackTimer);
  document.body.dataset.universeReady = "true";
  document.body.classList.remove("is-loading");
  loadingState.classList.add("is-complete");
  state.revealStartedAt = performance.now();
  const helpDismissed = localStorage.getItem(HELP_STORAGE_KEY) === "dismissed";
  help.classList.toggle("is-visible", !helpDismissed);
  announce(`${memories.length} memories loaded. Drag to rotate the universe.`);
}

function showFallback(error) {
  console.error("Memory Universe is unavailable.", error);
  window.clearTimeout(window.__universeFallbackTimer);
  document.body.classList.remove("is-loading");
  loadingState.hidden = true;
  fallback.hidden = false;
  renderer?.domElement.remove();
}

function dismissHelp() {
  if (!help.classList.contains("is-visible")) return;
  help.classList.add("is-dismissed");
  try { localStorage.setItem(HELP_STORAGE_KEY, "dismissed"); } catch {}
}

function readSessionState() {
  if (!restoreRequested) return null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_STATE_KEY));
    if (!saved || !Number.isFinite(saved.rotationX) || !Number.isFinite(saved.rotationY)) return null;
    return saved;
  } catch {
    return null;
  }
}

function saveSessionState(photo) {
  try {
    sessionStorage.setItem(SESSION_STATE_KEY, JSON.stringify({
      rotationX: state.rotationX,
      rotationY: state.rotationY,
      photo
    }));
  } catch {}
}

function updateArchiveHref() {
  const activeCard = cardById.get(state.selectedMemoryId) || cardById.get(state.activeTargetId);
  const photo = activeCard ? memoryNumber(activeCard.memory) : Number.isInteger(requestedPhoto) ? requestedPhoto : 1;
  archiveLink.href = `./index.html?photo=${clamp(photo, 1, Math.max(memories.length, 1))}`;
  const fallbackLink = fallback.querySelector("a");
  if (fallbackLink) fallbackLink.href = archiveLink.href;
}

function universeTexturePath(memory) {
  const image = String(memory.image || "");
  return image.replace(/^\.\/images\//, "./images/universe/");
}

function configureTexture(texture) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

function loadTexture(source) {
  const loader = new THREE.TextureLoader();
  return new Promise((resolve, reject) => loader.load(source, resolve, undefined, reject));
}

function placeholderTexture(memory) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 320;
  const context = canvas.getContext("2d");
  context.fillStyle = "#f3f0e8";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#c8c0b6";
  context.fillRect(14, 14, canvas.width - 28, 238);
  context.fillStyle = "#312d31";
  context.font = "600 18px sans-serif";
  context.fillText(memoryLabel(memory), 22, 286);
  return configureTexture(new THREE.CanvasTexture(canvas));
}

async function loadMemoryTexture(memory) {
  try {
    return configureTexture(await loadTexture(universeTexturePath(memory)));
  } catch (thumbnailError) {
    console.warn(`Universe thumbnail failed for ${memory.image}; trying archive image.`, thumbnailError);
    try {
      return configureTexture(await loadTexture(memory.image));
    } catch (imageError) {
      console.warn(`Archive image failed for ${memory.image}; using placeholder.`, imageError);
      return placeholderTexture(memory);
    }
  }
}

async function loadTextures(items) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let loaded = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await loadMemoryTexture(items[index]);
      loaded += 1;
      loadingCopy.textContent = `Loading memories · ${loaded} / ${items.length}`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONFIG.textureConcurrency, items.length) }, worker));
  return results;
}

function createRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x09080a, 1);
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute("role", "application");
  renderer.domElement.setAttribute("aria-label", "Memory Universe. Drag to rotate, use arrow keys to move, Enter to select, and Escape to release.");
  renderer.domElement.addEventListener("webglcontextlost", event => {
    event.preventDefault();
    stopAnimation();
    showFallback(new Error("WebGL context lost"));
  }, { once: true });
  canvasHost.appendChild(renderer.domElement);
}

function createScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x09080a);
  scene.fog = new THREE.Fog(0x09080a, 8.5, 22);
  camera = new THREE.PerspectiveCamera(CONFIG.cameraFov, window.innerWidth / window.innerHeight, .1, 60);
  camera.position.set(0, 0, CONFIG.cameraZ);
  camera.lookAt(0, 0, 0);
  universeGroup = new THREE.Group();
  scene.add(universeGroup);
  sharedPlaneGeometry = new THREE.PlaneGeometry(1, 1, 1, 1);
  createDust();
}

function createDust() {
  const random = seededRandom("graduation-memory-dust");
  const count = window.innerWidth < 700 ? 80 : 150;
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const radius = 7 + random() * 11;
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[index * 3 + 1] = radius * Math.cos(phi);
    positions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: 0xb7aaa0, size: .026, transparent: true, opacity: .2, depthWrite: false, fog: true });
  dust = new THREE.Points(geometry, material);
  scene.add(dust);
}

function cardPlacement(memory, index, count) {
  const random = seededRandom(`${memory.id || index}-${memory.sourceFile || memory.image}`);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const normalizedY = 1 - ((index + .5) / count) * 2;
  const ringRadius = Math.sqrt(Math.max(0, 1 - normalizedY * normalizedY));
  const angle = index * goldenAngle + (random() - .5) * .22;
  const sphereRadius = 4.85 + Math.min(1.1, Math.sqrt(count) * .075);
  const radialOffset = (random() - .5) * .72;
  const position = new THREE.Vector3(
    Math.cos(angle) * ringRadius,
    normalizedY + (random() - .5) * .055,
    Math.sin(angle) * ringRadius
  ).normalize().multiplyScalar(sphereRadius + radialOffset);
  const layoutScale = clamp(Math.sqrt(42 / Math.max(count, 1)), .56, 1.08);
  const baseScale = layoutScale * (.88 + random() * .2);
  const aspect = Number(memory.width) && Number(memory.height) ? memory.width / memory.height : memory.aspectRatio === "landscape" ? 1.3 : .72;
  const width = 1.25;
  const height = clamp(width / aspect, .82, 1.88);
  return { random, position, baseScale, width, height, revealDelay: random() * 260 + (1 - position.z / sphereRadius) * 90 };
}

function createCard(memory, texture, index) {
  const placement = cardPlacement(memory, index, memories.length);
  const group = new THREE.Group();
  group.position.copy(placement.position);
  group.lookAt(placement.position.clone().multiplyScalar(2));
  group.rotateX((placement.random() - .5) * .12);
  group.rotateY((placement.random() - .5) * .1);
  group.rotateZ((placement.random() - .5) * .18);
  group.scale.setScalar(placement.baseScale);

  const backingMaterial = new THREE.MeshBasicMaterial({ color: 0xf3f0e8, transparent: true, opacity: 0, side: THREE.FrontSide, fog: true });
  const backing = new THREE.Mesh(sharedPlaneGeometry, backingMaterial);
  backing.position.z = -.014;
  backing.scale.set(placement.width + .065, placement.height + .065, 1);

  const material = new THREE.MeshBasicMaterial({ map: texture, color: neutralTint.clone(), transparent: true, opacity: 0, side: THREE.FrontSide, fog: true });
  const mesh = new THREE.Mesh(sharedPlaneGeometry, material);
  mesh.scale.set(placement.width, placement.height, 1);
  mesh.userData.memoryId = memory.id;
  group.add(backing, mesh);
  universeGroup.add(group);

  const card = {
    memory,
    group,
    mesh,
    material,
    backingMaterial,
    texture,
    basePosition: group.position.clone(),
    baseQuaternion: group.quaternion.clone(),
    baseScale: placement.baseScale,
    currentScale: placement.baseScale,
    revealDelay: placement.revealDelay,
    transition: null,
    detached: false,
    selectedTexture: null,
    fullTextureLoading: false
  };
  cards.push(card);
  cardById.set(memory.id, card);
  interactiveMeshes.push(mesh);
}

function createCards(textures) {
  memories.forEach((memory, index) => createCard(memory, textures[index], index));
}

function setPointerNdc(clientX, clientY) {
  const bounds = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((clientX - bounds.left) / bounds.width) * 2 - 1;
  pointerNdc.y = -((clientY - bounds.top) / bounds.height) * 2 + 1;
}

function raycastMemory(clientX, clientY) {
  if (!renderer || !camera) return null;
  setPointerNdc(clientX, clientY);
  raycaster.setFromCamera(pointerNdc, camera);
  const intersection = raycaster.intersectObjects(interactiveMeshes, false)[0];
  return intersection ? cardById.get(intersection.object.userData.memoryId) : null;
}

function setActiveTarget(memoryId, options = {}) {
  if (state.selectedMemoryId && !options.force) return false;
  const card = cardById.get(Number(memoryId)) || cardById.get(memoryId);
  const nextId = card?.memory.id ?? null;
  if (state.activeTargetId === nextId) return Boolean(card);
  state.activeTargetId = nextId;
  renderer?.domElement.classList.toggle("has-target", Boolean(card));
  if (!card) {
    targetLabel.textContent = "";
    targetLabel.classList.remove("is-visible");
    updateArchiveHref();
    return false;
  }
  const title = displayTitle(card.memory);
  targetLabel.textContent = [memoryLabel(card.memory), title].filter(Boolean).join(" · ");
  targetLabel.classList.toggle("is-visible", !state.selectedMemoryId);
  if (!state.selectedMemoryId) state.mode = "TARGETING";
  updateArchiveHref();
  return true;
}

function setActiveTargetFromScreenPosition(normalizedX, normalizedY) {
  if (!renderer) return false;
  const bounds = renderer.domElement.getBoundingClientRect();
  const card = raycastMemory(bounds.left + clamp(normalizedX, 0, 1) * bounds.width, bounds.top + clamp(normalizedY, 0, 1) * bounds.height);
  return setActiveTarget(card?.memory.id ?? null);
}

function findNearestToCenter(force = false) {
  if (!cards.length || state.pointerTargeting || state.selectedMemoryId) return;
  const now = performance.now();
  if (!force && now - state.lastNearestCheck < 180) return;
  state.lastNearestCheck = now;
  let bestCard = null;
  let bestScore = Infinity;
  for (const card of cards) {
    card.group.getWorldPosition(temporaryPosition);
    card.group.getWorldQuaternion(temporaryQuaternion);
    temporaryDirection.set(0, 0, 1).applyQuaternion(temporaryQuaternion).normalize();
    const towardCamera = camera.position.clone().sub(temporaryPosition).normalize();
    if (temporaryDirection.dot(towardCamera) < .18) continue;
    const projected = temporaryPosition.clone().project(camera);
    if (projected.z < -1 || projected.z > 1) continue;
    const score = projected.x * projected.x + projected.y * projected.y * 1.18;
    if (score < bestScore) {
      bestScore = score;
      bestCard = card;
    }
  }
  setActiveTarget(bestCard?.memory.id ?? null);
}

function selectedTargetPosition() {
  const mobile = window.innerWidth < 700;
  return new THREE.Vector3(0, mobile ? .72 : .45, CONFIG.cameraZ - (mobile ? 5.7 : 6.15));
}

function startCardTransition(card, target, duration, onComplete) {
  card.transition = {
    startedAt: performance.now(),
    duration: reducedMotion.matches ? 80 : duration,
    fromPosition: card.group.position.clone(),
    fromQuaternion: card.group.quaternion.clone(),
    fromScale: card.group.scale.x,
    toPosition: target.position.clone(),
    toQuaternion: target.quaternion.clone(),
    toScale: target.scale,
    onComplete
  };
}

async function upgradeSelectedTexture(card) {
  if (card.selectedTexture || card.fullTextureLoading) return;
  card.fullTextureLoading = true;
  try {
    const texture = configureTexture(await loadTexture(card.memory.image));
    if (state.selectedMemoryId !== card.memory.id) {
      texture.dispose();
      return;
    }
    card.selectedTexture = texture;
    card.material.map = texture;
    card.material.needsUpdate = true;
  } catch (error) {
    console.warn(`Selected archive image failed for ${card.memory.image}; retaining thumbnail.`, error);
  } finally {
    card.fullTextureLoading = false;
  }
}

function restoreFieldTexture(card) {
  if (!card.selectedTexture) return;
  card.material.map = card.texture;
  card.material.needsUpdate = true;
  card.selectedTexture.dispose();
  card.selectedTexture = null;
}

function selectMemory(memoryId) {
  if (state.selectedMemoryId) return state.selectedMemoryId === memoryId;
  const card = cardById.get(Number(memoryId)) || cardById.get(memoryId);
  if (!card) return false;
  state.selectedMemoryId = card.memory.id;
  state.activeTargetId = card.memory.id;
  state.mode = "SELECTED";
  state.velocityX *= .18;
  state.velocityY *= .18;
  scene.attach(card.group);
  card.detached = true;
  const targetScale = window.innerWidth < 700 ? 1.72 : 2.02;
  startCardTransition(card, {
    position: selectedTargetPosition(),
    quaternion: new THREE.Quaternion(),
    scale: targetScale
  }, CONFIG.selectionDuration);
  upgradeSelectedTexture(card);
  selectionNumber.textContent = `${memoryLabel(card.memory)} · ARCHIVE ${String(memoryNumber(card.memory)).padStart(2, "0")} / ${String(memories.length).padStart(2, "0")}`;
  selectionTitle.textContent = displayTitle(card.memory) || memoryLabel(card.memory);
  selectionContext.classList.add("is-visible");
  selectionContext.setAttribute("aria-hidden", "false");
  targetLabel.classList.remove("is-visible");
  updateArchiveHref();
  announce(`${memoryLabel(card.memory)} selected. Activate View memory or press Enter to open it.`);
  return true;
}

function selectActiveTarget() {
  return state.activeTargetId ? selectMemory(state.activeTargetId) : false;
}

function releaseSelection() {
  const card = cardById.get(state.selectedMemoryId);
  if (!card || card.transition?.releasing) return false;
  selectionContext.classList.remove("is-visible");
  selectionContext.setAttribute("aria-hidden", "true");
  universeGroup.attach(card.group);
  card.detached = false;
  startCardTransition(card, {
    position: card.basePosition,
    quaternion: card.baseQuaternion,
    scale: card.baseScale
  }, CONFIG.releaseDuration, () => {
    restoreFieldTexture(card);
    state.selectedMemoryId = null;
    state.mode = state.activeTargetId ? "TARGETING" : "IDLE";
    targetLabel.classList.toggle("is-visible", Boolean(state.activeTargetId));
    announce("Memory released. Continue exploring the universe.");
  });
  card.transition.releasing = true;
  return true;
}

function openSelectedMemory() {
  const card = cardById.get(state.selectedMemoryId);
  if (!card) return false;
  const photo = memoryNumber(card.memory);
  state.mode = "DETAIL";
  saveSessionState(photo);
  window.location.assign(`./index.html?photo=${photo}&detail=1&from=universe`);
  return true;
}

function rotateBy(horizontalRadians, verticalRadians = 0) {
  if (state.selectedMemoryId) return false;
  state.rotationY += Number(horizontalRadians) || 0;
  state.rotationX = clamp(state.rotationX + (Number(verticalRadians) || 0), -1.02, 1.02);
  return true;
}

function applyRotationImpulse(horizontal, vertical = 0) {
  if (state.selectedMemoryId) return false;
  state.velocityY = clamp(state.velocityY + clamp(Number(horizontal) || 0, -1, 1) * .5, -CONFIG.maximumVelocity, CONFIG.maximumVelocity);
  state.velocityX = clamp(state.velocityX + clamp(Number(vertical) || 0, -1, 1) * .42, -CONFIG.maximumVelocity, CONFIG.maximumVelocity);
  dismissHelp();
  return true;
}

function rotateFromDrag(deltaX, deltaY, elapsedMilliseconds) {
  if (state.selectedMemoryId) return;
  const elapsed = Math.max(elapsedMilliseconds / 1000, .008);
  const horizontal = deltaX * CONFIG.dragSensitivityX;
  const vertical = deltaY * CONFIG.dragSensitivityY;
  rotateBy(horizontal, vertical);
  state.velocityY = clamp(THREE.MathUtils.lerp(state.velocityY, horizontal / elapsed, .22), -CONFIG.maximumVelocity, CONFIG.maximumVelocity);
  state.velocityX = clamp(THREE.MathUtils.lerp(state.velocityX, vertical / elapsed, .22), -CONFIG.maximumVelocity, CONFIG.maximumVelocity);
}

class OrbitInputController {
  constructor(element, callbacks) {
    this.element = element;
    this.callbacks = callbacks;
    this.pointerId = null;
    this.lastX = 0;
    this.lastY = 0;
    this.lastAt = 0;
    this.distance = 0;
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    element.addEventListener("pointerdown", this.onPointerDown);
    element.addEventListener("pointermove", this.onPointerMove);
    element.addEventListener("pointerup", this.onPointerUp);
    element.addEventListener("pointercancel", this.onPointerUp);
    element.addEventListener("pointerleave", event => {
      if (this.pointerId == null) callbacks.leave(event);
    });
  }

  onPointerDown(event) {
    if (event.button !== 0 || this.pointerId != null) return;
    if (event.pointerType === "touch" && event.clientX < 24) return;
    this.pointerId = event.pointerId;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.lastAt = performance.now();
    this.distance = 0;
    state.dragging = false;
    this.element.setPointerCapture(event.pointerId);
    this.callbacks.interact();
  }

  onPointerMove(event) {
    if (event.pointerId !== this.pointerId) {
      this.callbacks.hover(event);
      return;
    }
    const now = performance.now();
    const deltaX = event.clientX - this.lastX;
    const deltaY = event.clientY - this.lastY;
    this.distance += Math.hypot(deltaX, deltaY);
    if (this.distance > 4) {
      state.dragging = true;
      this.element.classList.add("is-dragging");
      this.callbacks.rotate(deltaX, deltaY, now - this.lastAt);
    }
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.lastAt = now;
  }

  onPointerUp(event) {
    if (event.pointerId !== this.pointerId) return;
    const wasDragging = state.dragging;
    if (this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
    this.pointerId = null;
    state.dragging = false;
    this.element.classList.remove("is-dragging");
    if (!wasDragging) this.callbacks.tap(event);
  }

  dispose() {
    this.element.removeEventListener("pointerdown", this.onPointerDown);
    this.element.removeEventListener("pointermove", this.onPointerMove);
    this.element.removeEventListener("pointerup", this.onPointerUp);
    this.element.removeEventListener("pointercancel", this.onPointerUp);
  }
}

function handleHover(event) {
  if (state.dragging || state.selectedMemoryId || event.pointerType === "touch") return;
  const card = raycastMemory(event.clientX, event.clientY);
  state.pointerTargeting = Boolean(card);
  setActiveTarget(card?.memory.id ?? null);
}

function handlePointerLeave() {
  state.pointerTargeting = false;
  findNearestToCenter(true);
}

function handleTap(event) {
  dismissHelp();
  const card = raycastMemory(event.clientX, event.clientY);
  if (!card) return;
  if (state.selectedMemoryId === card.memory.id) {
    openSelectedMemory();
    return;
  }
  if (!state.selectedMemoryId) {
    setActiveTarget(card.memory.id);
    selectMemory(card.memory.id);
  }
}

function bindControls() {
  controls = new OrbitInputController(renderer.domElement, {
    rotate: rotateFromDrag,
    hover: handleHover,
    leave: handlePointerLeave,
    tap: handleTap,
    interact: dismissHelp
  });
  renderer.domElement.addEventListener("focus", () => findNearestToCenter(true));
  viewMemoryButton.addEventListener("click", openSelectedMemory);
  releaseMemoryButton.addEventListener("click", releaseSelection);
  window.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const impulse = event.repeat ? .18 : .38;
      if (event.key === "ArrowLeft") applyRotationImpulse(-impulse, 0);
      if (event.key === "ArrowRight") applyRotationImpulse(impulse, 0);
      if (event.key === "ArrowUp") applyRotationImpulse(0, -impulse);
      if (event.key === "ArrowDown") applyRotationImpulse(0, impulse);
      renderer.domElement.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Enter" && document.activeElement === renderer.domElement) {
      event.preventDefault();
      state.selectedMemoryId ? openSelectedMemory() : selectActiveTarget();
    }
    if (event.key === "Escape" && state.selectedMemoryId) {
      event.preventDefault();
      releaseSelection();
      renderer.domElement.focus({ preventScroll: true });
    }
  });
}

function updateCardTransition(card, now) {
  const transition = card.transition;
  if (!transition) return;
  const progress = clamp((now - transition.startedAt) / transition.duration, 0, 1);
  const eased = easeInOutCubic(progress);
  card.group.position.lerpVectors(transition.fromPosition, transition.toPosition, eased);
  card.group.quaternion.slerpQuaternions(transition.fromQuaternion, transition.toQuaternion, eased);
  card.group.scale.setScalar(THREE.MathUtils.lerp(transition.fromScale, transition.toScale, eased));
  if (progress === 1) {
    card.currentScale = transition.toScale;
    card.transition = null;
    transition.onComplete?.();
  }
}

function updateCards(now, deltaSeconds) {
  const revealAge = now - state.revealStartedAt;
  const selectedId = state.selectedMemoryId;
  const targetDim = selectedId ? .22 : 1;
  state.fieldDim = THREE.MathUtils.damp(state.fieldDim, targetDim, reducedMotion.matches ? 35 : 5.5, deltaSeconds);
  universeGroup.getWorldQuaternion(universeWorldQuaternion);
  localCameraQuaternion.copy(universeWorldQuaternion).invert().multiply(camera.quaternion);
  for (const card of cards) {
    updateCardTransition(card, now);
    const reveal = reducedMotion.matches ? 1 : clamp((revealAge - card.revealDelay) / 620, 0, 1);
    card.group.getWorldPosition(temporaryPosition);
    const depth = clamp((temporaryPosition.z + 6) / 12, 0, 1);
    const isSelected = card.memory.id === selectedId;
    const isTarget = card.memory.id === state.activeTargetId && !selectedId;
    const fieldOpacity = isSelected ? 1 : state.fieldDim;
    const depthOpacity = .24 + depth * .76;
    const targetOpacity = reveal * fieldOpacity * (isSelected ? 1 : depthOpacity);
    card.material.opacity = THREE.MathUtils.damp(card.material.opacity, targetOpacity, 8, deltaSeconds);
    card.backingMaterial.opacity = card.material.opacity * .34;
    card.material.color.lerpColors(neutralTint, highlightTint, isSelected ? 1 : isTarget ? .72 : .08);
    if (!card.transition && !isSelected) {
      card.group.quaternion.slerpQuaternions(card.baseQuaternion, localCameraQuaternion, .18);
      const scaleTarget = card.baseScale * (isTarget ? 1.09 : 1);
      card.currentScale = THREE.MathUtils.damp(card.currentScale, scaleTarget, 9, deltaSeconds);
      card.group.scale.setScalar(card.currentScale);
    }
  }
}

function updateMotion(deltaSeconds) {
  if (!state.dragging) {
    const damping = reducedMotion.matches ? .28 : state.selectedMemoryId ? .72 : .94;
    const dampingFactor = Math.pow(damping, deltaSeconds * 60);
    state.velocityX *= dampingFactor;
    state.velocityY *= dampingFactor;
    state.rotationX = clamp(state.rotationX + state.velocityX * deltaSeconds, -1.02, 1.02);
    state.rotationY += state.velocityY * deltaSeconds;
  }
  if (!reducedMotion.matches && !state.dragging && !state.selectedMemoryId && Math.abs(state.velocityY) < .035) {
    state.rotationY += CONFIG.ambientSpeed * deltaSeconds;
  }
  universeGroup.rotation.x = state.rotationX;
  universeGroup.rotation.y = state.rotationY;
  if (dust && !reducedMotion.matches) dust.rotation.y -= deltaSeconds * .0035;
}

function updatePerformance(now) {
  if (!state.frameWindowStartedAt) state.frameWindowStartedAt = now;
  state.frameWindowCount += 1;
  const elapsed = now - state.frameWindowStartedAt;
  if (elapsed >= 1500) {
    state.observedFps = state.frameWindowCount / (elapsed / 1000);
    state.frameWindowStartedAt = now;
    state.frameWindowCount = 0;
  }
}

function animate(now) {
  if (!state.running) return;
  const deltaSeconds = clamp((now - (state.lastFrameAt || now)) / 1000, 0, .05);
  state.lastFrameAt = now;
  updateMotion(deltaSeconds);
  updateCards(now, deltaSeconds);
  findNearestToCenter();
  updatePerformance(now);
  renderer.render(scene, camera);
  state.animationFrame = window.requestAnimationFrame(animate);
}

function startAnimation() {
  if (state.running || !renderer) return;
  state.running = true;
  state.lastFrameAt = performance.now();
  state.animationFrame = window.requestAnimationFrame(animate);
}

function stopAnimation() {
  state.running = false;
  window.cancelAnimationFrame(state.animationFrame);
}

function handleResize() {
  if (!renderer || !camera) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  const selected = cardById.get(state.selectedMemoryId);
  if (selected && !selected.transition) selected.group.position.copy(selectedTargetPosition());
}

function restoreInitialState() {
  const saved = readSessionState();
  if (saved) {
    state.rotationX = clamp(saved.rotationX, -1.02, 1.02);
    state.rotationY = saved.rotationY;
  }
  const photo = Number.isInteger(requestedPhoto) && requestedPhoto >= 1 && requestedPhoto <= memories.length
    ? requestedPhoto
    : saved?.photo;
  if (Number.isInteger(photo) && photo >= 1 && photo <= memories.length) {
    window.setTimeout(() => selectMemory(memories[photo - 1].id), reducedMotion.matches ? 0 : 360);
  } else {
    window.setTimeout(() => findNearestToCenter(true), 120);
  }
  updateArchiveHref();
}

function exposeIntegrationHooks() {
  window.MemoryUniverse = Object.freeze({
    rotateBy,
    applyRotationImpulse,
    setActiveTarget,
    setActiveTargetFromScreenPosition,
    selectActiveTarget,
    selectMemory,
    releaseSelection,
    openSelectedMemory,
    getState: () => ({
      mode: state.mode,
      activeTargetId: state.activeTargetId,
      selectedMemoryId: state.selectedMemoryId,
      rotation: { x: state.rotationX, y: state.rotationY },
      angularVelocity: { x: state.velocityX, y: state.velocityY },
      textureCount: cards.length,
      rendererPixelRatio: renderer?.getPixelRatio() || 0,
      observedFps: Number(state.observedFps.toFixed(1)),
      reducedMotion: reducedMotion.matches,
      rendering: state.running,
      dragging: state.dragging,
      pointerTargeting: state.pointerTargeting
    })
  });
}

function dispose() {
  stopAnimation();
  controls?.dispose();
  cards.forEach(card => {
    card.selectedTexture?.dispose();
    card.texture.dispose();
    card.material.dispose();
    card.backingMaterial.dispose();
  });
  sharedPlaneGeometry?.dispose();
  dust?.geometry.dispose();
  dust?.material.dispose();
  renderer?.dispose();
}

async function initialise() {
  try {
    const response = await fetch("./data.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Memory data returned ${response.status}`);
    const data = await response.json();
    memories = Array.isArray(data) ? data.filter(memory => memory && memory.image) : [];
    if (!memories.length) throw new Error("No memories are available");
    loadingCopy.textContent = `Loading memories · 0 / ${memories.length}`;
    createRenderer();
    createScene();
    const textures = await loadTextures(memories);
    createCards(textures);
    bindControls();
    exposeIntegrationHooks();
    restoreInitialState();
    markUniverseReady();
    startAnimation();
    window.addEventListener("resize", handleResize, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopAnimation();
      else startAnimation();
    });
    window.addEventListener("beforeunload", dispose, { once: true });
    reducedMotion.addEventListener("change", () => {
      state.velocityX = 0;
      state.velocityY = 0;
    });
  } catch (error) {
    showFallback(error);
  }
}

initialise();
