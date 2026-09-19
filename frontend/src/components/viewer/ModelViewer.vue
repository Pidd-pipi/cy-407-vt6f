<template>
  <SceneCanvas class="model-viewer" @ready="containerRef = $event">
    <div class="viewer-title">
      <span>360° 模型查看</span>
      <strong>{{ artifact.name }}</strong>
    </div>
    <div v-if="picking" class="pick-hint">点选模式：直接点击模型表面拾取标注位置（拖拽仍可旋转视角）</div>
    <AnnotationRenderer
      :annotations="annotations"
      :pin-states="pinStates"
      :active-id="activeAnnotationId"
      :picking="picking"
      @select="$emit('annotation-select', $event)"
    />
    <CameraControls @view="setView" />
  </SceneCanvas>
</template>

<script setup lang="ts">
import { onBeforeUnmount, reactive, ref, watch } from 'vue';
import * as THREE from 'three';
import SceneCanvas from '@/components/common/SceneCanvas.vue';
import AnnotationRenderer, { type PinState } from '@/components/viewer/AnnotationRenderer.vue';
import CameraControls from '@/components/viewer/CameraControls.vue';
import { useThreeScene } from '@/hooks/useThreeScene';
import type { Annotation, Artifact, Vector3Tuple } from '@/types';
import { loadArtifactObject } from '@/utils/model-loader';
import { disposeObject3D } from '@/utils/renderer';

/** 相机离标注点超过该距离时隐藏标注（缩放远离） */
const HIDE_DISTANCE = 8.5;
/** 遮挡判定容差，允许旧标注略微嵌入模型表面而不被误藏 */
const OCCLUSION_TOLERANCE = 0.12;
/** 飞行定位时相机到标注点的距离 */
const FOCUS_DISTANCE = 2.4;
const FOCUS_DURATION = 560;
const OCCLUSION_INTERVAL = 120;
const HOVER_INTERVAL = 60;
const CLICK_DRAG_THRESHOLD = 6;

const props = withDefaults(
  defineProps<{
    artifact: Artifact;
    annotations?: Annotation[];
    autoRotate?: boolean;
    /** 为 true 时点击模型表面会触发 surface-pick，并暂停自动旋转 */
    picking?: boolean;
  }>(),
  {
    annotations: () => [],
    autoRotate: true,
    picking: false
  }
);

const emit = defineEmits<{
  'annotation-select': [id: string];
  'surface-pick': [payload: { position: Vector3Tuple; normal: Vector3Tuple }];
}>();

const containerRef = ref<HTMLElement | null>(null);
const three = useThreeScene(containerRef, { cameraPosition: [3.8, 2.6, 5.2] });

const pinStates = reactive<Record<string, PinState>>({});
const activeAnnotationId = ref('');

let currentObject: THREE.Object3D | null = null;
let loadToken = 0;
let stopFrame: (() => void) | undefined;
let stopListeners: (() => void) | undefined;

/* ---------------- 3D 辅助标记（悬停环 + 已拾取点） ---------------- */

let hoverRing: THREE.Mesh | null = null;
let pickedMarker: THREE.Mesh | null = null;
let helperMaterial: THREE.MeshBasicMaterial | null = null;
const upAxis = new THREE.Vector3(0, 0, 1);

function detachHelpers() {
  if (!currentObject) return;
  for (const helper of [hoverRing, pickedMarker]) {
    if (helper) {
      currentObject.remove(helper);
      helper.geometry.dispose();
    }
  }
  hoverRing = null;
  pickedMarker = null;
}

function createHelpers() {
  helperMaterial ??= new THREE.MeshBasicMaterial({ color: '#d3a93f', side: THREE.DoubleSide });

  hoverRing = new THREE.Mesh(new THREE.RingGeometry(0.085, 0.115, 40), helperMaterial);
  hoverRing.visible = false;
  hoverRing.userData.isAnnotationHelper = true;
  hoverRing.renderOrder = 5;
  currentObject?.add(hoverRing);

  pickedMarker = new THREE.Mesh(new THREE.SphereGeometry(0.05, 24, 16), helperMaterial);
  pickedMarker.visible = false;
  pickedMarker.userData.isAnnotationHelper = true;
  currentObject?.add(pickedMarker);
}

/* ---------------- 模型加载 ---------------- */

watch(
  () => [three.ready.value, props.artifact.id] as const,
  async ([ready]) => {
    if (!ready || !three.scene.value) return;
    const token = ++loadToken;
    if (currentObject) {
      detachHelpers();
      three.scene.value.remove(currentObject);
      disposeObject3D(currentObject);
      currentObject = null;
      meshCache = [];
    }
    cancelFocus();

    const object = await loadArtifactObject(props.artifact);
    if (token !== loadToken || !three.scene.value) {
      disposeObject3D(object);
      return;
    }

    object.position.y = 0;
    currentObject = object;
    createHelpers();
    three.scene.value.add(object);
    three.setCameraView([3.8, 2.6, 5.2], [0, 0, 0]);

    if (pendingFocusId) {
      const annotation = props.annotations.find((entry) => entry.id === pendingFocusId);
      if (annotation) focusOn(annotation);
      pendingFocusId = '';
    }
  },
  { immediate: true }
);

/* ---------------- 标注集合与投影状态同步 ---------------- */

watch(
  () => props.annotations,
  (list) => {
    const ids = new Set(list.map((annotation) => annotation.id));
    for (const annotation of list) {
      if (!pinStates[annotation.id]) {
        pinStates[annotation.id] = { x: 0, y: 0, visible: false };
      }
    }
    for (const id of Object.keys(pinStates)) {
      if (!ids.has(id)) delete pinStates[id];
    }
  },
  { immediate: true, deep: true }
);

/* ---------------- 每帧：旋转 / 飞行 / 投影 / 隐藏判定 ---------------- */

const raycaster = new THREE.Raycaster();
const occludedMap = new Map<string, boolean>();
/** 本帧的廉价可见性结果，供遮挡射线检测复用，避免重复坐标变换 */
const frameInfo = new Map<string, { raycast: boolean; ndcX: number; ndcY: number; distance: number }>();
const tmpWorld = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpToCamera = new THREE.Vector3();
const tmpNdc = new THREE.Vector3();
const tmpView = new THREE.Vector3();
let lastOcclusionAt = 0;
let meshCache: THREE.Mesh[] = [];

function collectMeshes(): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  currentObject?.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && !mesh.userData.isAnnotationHelper) meshes.push(mesh);
  });
  // 展板图片平面是纹理加载后异步加入的，数量变化时刷新缓存
  if (meshes.length !== meshCache.length) meshCache = meshes;
  return meshCache;
}

/** 旧标注没有法线时，用“中心→标注点”方向近似外法线（适合罐等近似凸面模型） */
function annotationWorldVectors(annotation: Annotation, point: THREE.Vector3, normal: THREE.Vector3) {
  point.set(annotation.position.x, annotation.position.y, annotation.position.z);
  if (annotation.normal) {
    normal.set(annotation.normal.x, annotation.normal.y, annotation.normal.z).normalize();
  } else {
    normal.copy(point).normalize();
  }
  point.applyMatrix4(currentObject!.matrixWorld);
  normal.transformDirection(currentObject!.matrixWorld);
}

function updatePins(now: number) {
  const camera = three.camera.value;
  const renderer = three.renderer.value;
  if (!camera || !renderer || !currentObject) return;

  currentObject.updateMatrixWorld(true);
  const container = renderer.domElement.parentElement;
  const rect = container?.getBoundingClientRect();
  const width = rect?.width ?? 1;
  const height = rect?.height ?? 1;
  const cameraWorld = camera.position;

  frameInfo.clear();
  for (const annotation of props.annotations) {
    annotationWorldVectors(annotation, tmpWorld, tmpNormal);

    // 背面朝向：表面法线背向相机时隐藏（转到模型背面）
    tmpToCamera.copy(cameraWorld).sub(tmpWorld);
    const facingFront = tmpNormal.dot(tmpToCamera) >= 0;

    // 视锥外 / 相机后方
    tmpView.copy(tmpWorld).applyMatrix4(camera.matrixWorldInverse);
    const inFront = tmpView.z < 0;
    tmpNdc.copy(tmpWorld).project(camera);
    const inView = inFront && tmpNdc.x >= -1 && tmpNdc.x <= 1 && tmpNdc.y >= -1 && tmpNdc.y <= 1;

    // 缩放远离时隐藏
    const distance = cameraWorld.distanceTo(tmpWorld);
    const cheapVisible = facingFront && inView && distance <= HIDE_DISTANCE;

    // 只有带真实表面法线的新标注做遮挡检测；旧标注仅靠法线朝向判断，保证升级后继续可见
    const canRaycast = Boolean(annotation.normal);
    frameInfo.set(annotation.id, { raycast: cheapVisible && canRaycast, ndcX: tmpNdc.x, ndcY: tmpNdc.y, distance });

    const x = (tmpNdc.x * 0.5 + 0.5) * width;
    const y = (-tmpNdc.y * 0.5 + 0.5) * height;
    const visible = cheapVisible && !occludedMap.get(annotation.id);
    const state = pinStates[annotation.id];
    if (state) {
      // 数值未变化时避免触发 Vue 响应式更新
      if (Math.abs(state.x - x) > 0.5 || Math.abs(state.y - y) > 0.5) {
        state.x = x;
        state.y = y;
      }
      if (state.visible !== visible) state.visible = visible;
    }
  }

  // 遮挡检测：射线从相机穿过标注点，若路径上先碰到模型表面则隐藏（每 120ms 一轮）
  if (now - lastOcclusionAt > OCCLUSION_INTERVAL) {
    lastOcclusionAt = now;
    const meshes = collectMeshes();
    for (const annotation of props.annotations) {
      const info = frameInfo.get(annotation.id);
      if (!info?.raycast) {
        occludedMap.set(annotation.id, false);
        continue;
      }
      annotationWorldVectors(annotation, tmpWorld, tmpNormal);
      raycaster.setFromCamera({ x: info.ndcX, y: info.ndcY } as THREE.Vector2, camera);
      raycaster.far = Math.max(0, info.distance - OCCLUSION_TOLERANCE);
      const hits = raycaster.intersectObjects(meshes, false);
      occludedMap.set(annotation.id, hits.length > 0);
    }
  }
}

watch(
  () => three.ready.value,
  (ready) => {
    if (!ready || stopFrame) return;
    stopFrame = three.addFrameCallback((delta) => {
      const now = performance.now();
      if (currentObject && props.autoRotate && !props.picking && !focusTween) {
        currentObject.rotation.y += delta * 0.00022;
      }
      stepFocus(now);
      updatePins(now);
    });
  },
  { immediate: true }
);

/* ---------------- 相机飞行定位（标注列表选中） ---------------- */

interface FocusTween {
  start: number;
  fromPosition: THREE.Vector3;
  toPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
}

let focusTween: FocusTween | null = null;

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function focusOn(annotation: Annotation) {
  const camera = three.camera.value;
  const controls = three.controls.value;
  if (!camera || !controls || !currentObject) return;

  const localPoint = new THREE.Vector3(annotation.position.x, annotation.position.y, annotation.position.z);
  const worldPoint = localPoint.clone().applyMatrix4(currentObject.matrixWorld);

  const localNormal = annotation.normal
    ? new THREE.Vector3(annotation.normal.x, annotation.normal.y, annotation.normal.z).normalize()
    : localPoint.clone().normalize();
  const worldNormal = localNormal.transformDirection(currentObject.matrixWorld);

  // 沿表面外法线方向布置相机，确保标注点以正面朝向观察者
  const offset = worldNormal.multiplyScalar(FOCUS_DISTANCE);
  const goalPosition = worldPoint.clone().add(offset);

  // 收敛到 OrbitControls 的极角与距离限制内
  const relative = new THREE.Spherical().setFromVector3(goalPosition.clone().sub(worldPoint));
  relative.phi = THREE.MathUtils.clamp(relative.phi, 0.05, controls.maxPolarAngle);
  relative.radius = THREE.MathUtils.clamp(relative.radius, controls.minDistance, controls.maxDistance);
  goalPosition.copy(worldPoint).add(new THREE.Vector3().setFromSpherical(relative));

  focusTween = {
    start: performance.now(),
    fromPosition: camera.position.clone(),
    toPosition: goalPosition,
    fromTarget: controls.target.clone(),
    toTarget: worldPoint.clone()
  };
  controls.enabled = false;
}

function stepFocus(now: number) {
  const camera = three.camera.value;
  const controls = three.controls.value;
  if (!focusTween || !camera || !controls) return;
  const t = THREE.MathUtils.clamp((now - focusTween.start) / FOCUS_DURATION, 0, 1);
  const eased = easeInOutCubic(t);
  camera.position.lerpVectors(focusTween.fromPosition, focusTween.toPosition, eased);
  controls.target.lerpVectors(focusTween.fromTarget, focusTween.toTarget, eased);
  if (t >= 1) {
    focusTween = null;
    controls.enabled = true;
  }
}

function cancelFocus() {
  focusTween = null;
  if (three.controls.value) three.controls.value.enabled = true;
}

/** 从标注列表选中：飞行到对应表面位置并高亮图钉 */
let pendingFocusId = '';
function focusAnnotation(id: string) {
  const annotation = props.annotations.find((entry) => entry.id === id);
  if (!annotation) return;
  activeAnnotationId.value = id;
  // 模型尚未加载完成时等加载结束后再飞行
  if (currentObject) focusOn(annotation);
  else pendingFocusId = id;
}

defineExpose({ focusAnnotation });

/* ---------------- 视角预设 ---------------- */

function setView(mode: 'front' | 'side' | 'top' | 'reset') {
  cancelFocus();
  activeAnnotationId.value = '';
  pendingFocusId = '';
  const views = {
    front: [0, 1.6, 5.6] as THREE.Vector3Tuple,
    side: [5.4, 1.7, 0] as THREE.Vector3Tuple,
    top: [0.1, 6.2, 0.1] as THREE.Vector3Tuple,
    reset: [3.8, 2.6, 5.2] as THREE.Vector3Tuple
  };
  three.setCameraView(views[mode], [0, 0, 0]);
}

/* ---------------- 表面拾取（添加标注时取点） ---------------- */

let pointerDownX = 0;
let pointerDownY = 0;
let lastHoverAt = 0;

function ndcFromEvent(event: PointerEvent) {
  const rect = three.renderer.value!.domElement.getBoundingClientRect();
  return new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
}

function raycastPointer(event: PointerEvent): THREE.Intersection | null {
  if (!three.camera.value) return null;
  const meshes = collectMeshes();
  if (meshes.length === 0) return null;
  raycaster.setFromCamera(ndcFromEvent(event), three.camera.value);
  raycaster.far = Infinity;
  return raycaster.intersectObjects(meshes, false)[0] ?? null;
}

/** 将命中点与面法线转换为展品模型局部空间（标注坐标以模型中心为原点） */
function hitToLocal(hit: THREE.Intersection) {
  if (!currentObject || !hit.face) return null;
  const localPoint = hit.point.clone();
  currentObject.worldToLocal(localPoint);

  const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
  const inverseModel = new THREE.Matrix4().copy(currentObject.matrixWorld).invert();
  const localNormal = worldNormal.transformDirection(inverseModel).normalize();

  return { localPoint, localNormal };
}

function placeHelper(helper: THREE.Mesh, point: THREE.Vector3, normal: THREE.Vector3) {
  helper.position.copy(point).addScaledVector(normal, 0.012);
  helper.quaternion.setFromUnitVectors(upAxis, normal);
  helper.visible = true;
}

function onPointerMove(event: PointerEvent) {
  if (!props.picking || !currentObject || !hoverRing) return;
  const now = performance.now();
  if (now - lastHoverAt < HOVER_INTERVAL) return;
  lastHoverAt = now;
  const hit = raycastPointer(event);
  const local = hit ? hitToLocal(hit) : null;
  if (local) placeHelper(hoverRing, local.localPoint, local.localNormal);
  else hoverRing.visible = false;
}

function onPointerDown(event: PointerEvent) {
  pointerDownX = event.clientX;
  pointerDownY = event.clientY;
}

function onPointerUp(event: PointerEvent) {
  if (!props.picking || !currentObject) return;
  const moved = Math.hypot(event.clientX - pointerDownX, event.clientY - pointerDownY);
  if (moved > CLICK_DRAG_THRESHOLD) return; // 拖拽旋转，不视为拾取
  const hit = raycastPointer(event);
  const local = hit ? hitToLocal(hit) : null;
  if (!local) return;

  if (pickedMarker) placeHelper(pickedMarker, local.localPoint, local.localNormal);
  if (hoverRing) hoverRing.visible = false;

  const round = (value: number) => Math.round(value * 1000) / 1000;
  emit('surface-pick', {
    position: { x: round(local.localPoint.x), y: round(local.localPoint.y), z: round(local.localPoint.z) },
    normal: { x: round(local.localNormal.x), y: round(local.localNormal.y), z: round(local.localNormal.z) }
  });
}

watch(
  () => [three.ready.value, three.renderer.value] as const,
  ([ready, renderer]) => {
    stopListeners?.();
    if (!ready || !renderer) return;
    const canvas = renderer.domElement;
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    stopListeners = () => {
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
    };
  },
  { immediate: true }
);

watch(
  () => props.picking,
  (picking) => {
    const canvas = three.renderer.value?.domElement;
    if (canvas) canvas.style.cursor = picking ? 'crosshair' : '';
    if (!picking && hoverRing) hoverRing.visible = false;
  }
);

onBeforeUnmount(() => {
  stopFrame?.();
  stopListeners?.();
  cancelFocus();
  detachHelpers();
  helperMaterial?.dispose();
  helperMaterial = null;
});
</script>

<style scoped>
.model-viewer {
  min-height: 620px;
}

.viewer-title {
  position: absolute;
  top: 16px;
  left: 16px;
  display: grid;
  gap: 3px;
  padding: 10px 12px;
  color: var(--museum-ink);
  background: rgba(251, 245, 232, 0.88);
  border: 1px solid rgba(23, 63, 53, 0.14);
  border-radius: 8px;
}

.viewer-title span {
  color: var(--museum-brass);
  font-size: 12px;
  font-weight: 800;
}

.viewer-title strong {
  font-family: var(--font-display);
  font-size: 18px;
}

.pick-hint {
  position: absolute;
  top: 16px;
  left: 50%;
  padding: 8px 14px;
  color: #fbf5e8;
  font-size: 13px;
  background: rgba(23, 63, 53, 0.88);
  border-radius: 999px;
  pointer-events: none;
  transform: translateX(-50%);
}
</style>
