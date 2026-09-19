<template>
  <SceneCanvas class="model-viewer" @ready="containerRef = $event">
    <div class="viewer-title">
      <span>360° 模型查看</span>
      <strong>{{ artifact.name }}</strong>
    </div>
    <div v-if="picking" class="picking-hint">
      <strong>取点模式</strong>
      <span>点击模型表面确定标注位置，拖拽仍可旋转视角，再次点击按钮退出</span>
    </div>
    <AnnotationRenderer :pins="picking ? [] : pinStates" @select="$emit('annotation-select', $event)" />
    <CameraControls @view="setView" />
  </SceneCanvas>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import * as THREE from 'three';
import SceneCanvas from '@/components/common/SceneCanvas.vue';
import AnnotationRenderer from '@/components/viewer/AnnotationRenderer.vue';
import CameraControls from '@/components/viewer/CameraControls.vue';
import { useThreeScene } from '@/hooks/useThreeScene';
import type { Annotation, Artifact } from '@/types';
import {
  getFocusCameraPosition,
  isAnchorOccluded,
  pickSurfacePoint,
  projectAnchor,
  resolveLegacyAnchor,
  type AnnotationPinState,
  type SurfaceHit
} from '@/utils/annotation-anchor';
import { loadArtifactObject } from '@/utils/model-loader';
import { disposeObject3D } from '@/utils/renderer';

export interface AnchorUpgrade {
  id: string;
  position: SurfaceHit['position'];
  normal: SurfaceHit['normal'];
}

const props = withDefaults(
  defineProps<{
    artifact: Artifact;
    annotations?: Annotation[];
    autoRotate?: boolean;
    /** 传入 { id, nonce } 时把相机视角带到该标注所在表面，nonce 变化可重复触发 */
    focusRequest?: { id: string; nonce: number };
    /** 取点模式：点击模型表面回传本地坐标与法线 */
    picking?: boolean;
  }>(),
  {
    annotations: () => [],
    autoRotate: true,
    focusRequest: undefined,
    picking: false
  }
);

const emit = defineEmits<{
  'annotation-select': [id: string];
  'surface-pick': [hit: SurfaceHit];
  /** 旧版悬浮标注完成表面投射升级，交由外层持久化 */
  'anchors-upgraded': [upgrades: AnchorUpgrade[]];
}>();

/** 相机距离超过该值时隐藏标注（缩放远离） */
const ANNOTATION_HIDE_DISTANCE = 8;

const containerRef = ref<HTMLElement | null>(null);
const three = useThreeScene(containerRef, { cameraPosition: [3.8, 2.6, 5.2] });
const pinStates = shallowRef<AnnotationPinState[]>([]);

let currentObject: THREE.Object3D | null = null;
let loadToken = 0;
let loadEpoch = 0;
let stopFrame: (() => void) | undefined;
let stopControlStart: (() => void) | undefined;

/** 旧版标注投射到当前模型表面后的本地坐标 */
const resolvedAnchors = new Map<string, SurfaceHit>();
let spinEnabled = props.autoRotate;

// 相机聚焦补间
let tween:
  | {
      startTime: number;
      duration: number;
      fromPosition: THREE.Vector3;
      toPosition: THREE.Vector3;
      fromTarget: THREE.Vector3;
      toTarget: THREE.Vector3;
    }
  | undefined;

// 表面取点的临时标记
let previewMarker: THREE.Mesh | null = null;
const previewLift = 0.02;

watch(
  () => [three.ready.value, props.artifact.id] as const,
  async ([ready]) => {
    if (!ready || !three.scene.value) return;
    const token = ++loadToken;
    if (currentObject) {
      three.scene.value.remove(currentObject);
      disposeObject3D(currentObject);
      currentObject = null;
      resolvedAnchors.clear();
      previewMarker = null;
      pendingFocusId = undefined;
      tween = undefined;
    }

    const object = await loadArtifactObject(props.artifact);
    if (token !== loadToken || !three.scene.value) {
      disposeObject3D(object);
      return;
    }

    object.position.y = 0;
    currentObject = object;
    three.scene.value.add(object);
    three.setCameraView([3.8, 2.6, 5.2], [0, 0, 0]);
    spinEnabled = props.autoRotate;
    loadEpoch += 1;
    attachPreviewMarker();
    void resolveAnchors();
  },
  { immediate: true }
);

watch(
  () => three.ready.value,
  (ready) => {
    if (!ready || stopFrame) return;
    stopFrame = three.addFrameCallback((delta) => {
      const object = currentObject;
      const camera = three.camera.value;
      const controls = three.controls.value;
      const domElement = three.renderer.value?.domElement;
      if (!object || !camera || !controls || !domElement) return;

      if (spinEnabled && !tween && !props.picking) {
        object.rotation.y += delta * 0.00022;
      }

      updateTween();
      updatePinStates(object, camera, domElement);
    });
  },
  { immediate: true }
);

watch(
  () => props.autoRotate,
  (enabled) => {
    spinEnabled = enabled;
  }
);

// 标注数据变化（首次加载、升级后回写）时补做旧标注投射
watch(
  () => props.annotations.map((annotation) => `${annotation.id}:${annotation.anchorMode ?? 'legacy'}`).join('|'),
  () => {
    if (loadEpoch > 0) void resolveAnchors();
  }
);

/** 标注尚未完成表面投射时，先记下待聚焦目标，升级完成后再飞行 */
let pendingFocusId: string | undefined;

watch(
  () => props.focusRequest?.nonce,
  () => {
    const request = props.focusRequest;
    if (!request) return;
    const target = props.annotations.find((annotation) => annotation.id === request.id);
    const needsResolve = target && target.anchorMode !== 'surface' && !resolvedAnchors.has(target.id);
    if (needsResolve) {
      pendingFocusId = request.id;
    } else {
      focusAnnotation(request.id);
    }
  }
);

watch(
  () => props.picking,
  (picking) => {
    const domElement = three.renderer.value?.domElement;
    if (!domElement) return;
    domElement.style.cursor = picking ? 'crosshair' : '';
    spinEnabled = picking ? false : props.autoRotate;
  }
);

watch(
  () => three.renderer.value?.domElement,
  (domElement, _old, onCleanup) => {
    if (!domElement) return;
    domElement.addEventListener('pointerdown', handlePointerDown);
    // OrbitControls 会在 canvas 上捕获指针，pointerup 必须挂到 window 才能收到
    window.addEventListener('pointerup', handlePointerUp);
    const controls = three.controls.value;
    if (controls && !stopControlStart) {
      controls.addEventListener('start', handleControlStart);
      stopControlStart = () => controls.removeEventListener('start', handleControlStart);
    }
    onCleanup(() => {
      domElement.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointerup', handlePointerUp);
    });
  },
  { immediate: true }
);

function effectiveAnnotation(annotation: Annotation): Annotation {
  if (annotation.anchorMode === 'surface') return annotation;
  const resolved = resolvedAnchors.get(annotation.id);
  return resolved
    ? { ...annotation, position: resolved.position, normal: resolved.normal, anchorMode: 'surface' }
    : annotation;
}

async function resolveAnchors() {
  const object = currentObject;
  if (!object) return;

  const upgrades: AnchorUpgrade[] = [];
  for (const annotation of props.annotations) {
    if (annotation.anchorMode === 'surface' || resolvedAnchors.has(annotation.id)) continue;
    const hit = resolveLegacyAnchor(annotation, object);
    if (hit) {
      resolvedAnchors.set(annotation.id, hit);
      upgrades.push({ id: annotation.id, position: hit.position, normal: hit.normal });
    } else {
      // 投射失败时退回到沿旧坐标方向、半径 0.9 的本地点，保证旧标注仍可见
      const direction = new THREE.Vector3(annotation.position.x, annotation.position.y, annotation.position.z);
      if (direction.lengthSq() < 1e-6) direction.set(0, 0, 1);
      direction.normalize().multiplyScalar(0.9);
      const fallback: SurfaceHit = {
        position: { x: direction.x, y: direction.y, z: direction.z },
        normal: { x: direction.x, y: direction.y, z: direction.z }
      };
      resolvedAnchors.set(annotation.id, fallback);
      upgrades.push({ id: annotation.id, position: fallback.position, normal: fallback.normal });
    }
  }

  if (upgrades.length > 0) {
    emit('anchors-upgraded', upgrades);
  }
  if (pendingFocusId) {
    const id = pendingFocusId;
    pendingFocusId = undefined;
    focusAnnotation(id);
  }
}

function updatePinStates(object: THREE.Object3D, camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
  const width = domElement.clientWidth;
  const height = domElement.clientHeight;
  const next: AnnotationPinState[] = props.annotations.map((annotation) => {
    const effective = effectiveAnnotation(annotation);
    const projected = projectAnchor(effective, object, camera, width, height, ANNOTATION_HIDE_DISTANCE);
    const hidden =
      !projected.visible ||
      isAnchorOccluded(projected.worldPosition, object, camera);
    return {
      annotation,
      x: projected.x,
      y: projected.y,
      hidden,
      active: annotation.id === props.focusRequest?.id
    };
  });

  const previous = pinStates.value;
  const changed =
    next.length !== previous.length ||
    next.some((pin, index) => {
      const old = previous[index];
      return (
        !old ||
        old.annotation.id !== pin.annotation.id ||
        old.hidden !== pin.hidden ||
        old.active !== pin.active ||
        Math.abs(old.x - pin.x) > 0.5 ||
        Math.abs(old.y - pin.y) > 0.5
      );
    });

  if (changed) {
    pinStates.value = next;
  }
}

function focusAnnotation(id: string) {
  const object = currentObject;
  const camera = three.camera.value;
  if (!object || !camera) return;
  const target = props.annotations.find((annotation) => annotation.id === id);
  if (!target) return;

  const focus = getFocusCameraPosition(effectiveAnnotation(target), object, 2.6);
  if (!focus || !three.controls.value) return;

  spinEnabled = false;
  tween = {
    startTime: performance.now(),
    duration: 650,
    fromPosition: camera.position.clone(),
    toPosition: focus.position,
    fromTarget: three.controls.value.target.clone(),
    toTarget: focus.target
  };
}

function updateTween() {
  if (!tween || !three.camera.value || !three.controls.value) return;

  const elapsed = performance.now() - tween.startTime;
  const raw = Math.min(1, elapsed / tween.duration);
  const eased = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;

  three.camera.value.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
  three.controls.value.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);

  if (raw >= 1) {
    tween = undefined;
  }
}

function setView(mode: 'front' | 'side' | 'top' | 'reset') {
  const views = {
    front: [0, 1.6, 5.6] as THREE.Vector3Tuple,
    side: [5.4, 1.7, 0] as THREE.Vector3Tuple,
    top: [0.1, 6.2, 0.1] as THREE.Vector3Tuple,
    reset: [3.8, 2.6, 5.2] as THREE.Vector3Tuple
  };
  tween = undefined;
  three.setCameraView(views[mode], [0, 0, 0]);
  if (mode === 'reset') {
    spinEnabled = props.autoRotate;
  } else {
    spinEnabled = false;
  }
}

// ---- 表面取点 ----

const pointerStart = { x: 0, y: 0 };
let pointerDownOnCanvas = false;

function handlePointerDown(event: PointerEvent) {
  pointerStart.x = event.clientX;
  pointerStart.y = event.clientY;
  pointerDownOnCanvas = true;
}

function handlePointerUp(event: PointerEvent) {
  if (!pointerDownOnCanvas) return;
  pointerDownOnCanvas = false;
  if (!props.picking || !currentObject || !three.camera.value || !three.renderer.value) return;
  const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
  if (moved > 6) return; // 视为拖拽旋转，不取点

  const hit = pickSurfacePoint(
    event,
    three.renderer.value.domElement,
    three.camera.value,
    currentObject
  );
  if (hit) {
    emit('surface-pick', hit);
    showPreviewMarker(hit);
  }
}

function handleControlStart() {
  // 用户手动操作相机时取消聚焦补间并暂停自动旋转
  tween = undefined;
  spinEnabled = false;
}

function showPreviewMarker(hit: SurfaceHit) {
  if (!currentObject) return;
  if (!previewMarker) {
    previewMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 20, 20),
      new THREE.MeshStandardMaterial({
        color: '#bb4d3e',
        emissive: new THREE.Color('#bb4d3e'),
        emissiveIntensity: 0.55,
        roughness: 0.4
      })
    );
    previewMarker.name = 'annotation-preview-marker';
  }
  previewMarker.position
    .set(hit.position.x, hit.position.y, hit.position.z)
    .addScaledVector(new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z), previewLift);
  attachPreviewMarker();
}

function attachPreviewMarker() {
  if (!previewMarker || !currentObject) return;
  if (previewMarker.parent !== currentObject) {
    previewMarker.removeFromParent();
    currentObject.add(previewMarker);
  }
}

onBeforeUnmount(() => {
  stopFrame?.();
  stopControlStart?.();
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

.picking-hint {
  position: absolute;
  top: 16px;
  right: 16px;
  display: grid;
  gap: 2px;
  max-width: min(320px, calc(100% - 32px));
  padding: 10px 12px;
  color: var(--museum-ink);
  background: rgba(251, 245, 232, 0.92);
  border: 1px solid rgba(187, 77, 62, 0.45);
  border-radius: 8px;
}

.picking-hint strong {
  color: #bb4d3e;
  font-size: 13px;
}

.picking-hint span {
  color: rgba(31, 46, 41, 0.68);
  font-size: 12px;
  line-height: 1.45;
}
</style>
