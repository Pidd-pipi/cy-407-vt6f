import * as THREE from 'three';
import type { Annotation, Vector3Tuple } from '@/types';

export interface SurfaceHit {
  position: Vector3Tuple;
  normal: Vector3Tuple;
}

export interface AnnotationPinState {
  annotation: Annotation;
  x: number;
  y: number;
  /** 转到背面、被遮挡、超出屏幕或距离过远时隐藏 */
  hidden: boolean;
  active: boolean;
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const localRay = new THREE.Ray();
const tmpVector = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpMatrix = new THREE.Matrix4();
const tmpQuaternion = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();

/**
 * 旧版标注只有一组近似屏幕比例的坐标。以该坐标作为从模型中心出发的方向，
 * 在当前模型本地空间投射到表面，使升级后的标注仍停留在展品上。
 */
export function resolveLegacyAnchor(annotation: Annotation, root: THREE.Object3D): SurfaceHit | undefined {
  root.updateWorldMatrix(true, false);

  const direction = new THREE.Vector3(annotation.position.x, annotation.position.y, annotation.position.z);
  if (direction.lengthSq() < 1e-6) {
    direction.set(0, 0, 1);
  }
  direction.normalize();

  // 从模型包围盒中心沿方向投射。起点落在封闭几何体内部时 three.js 默认会
  // 因背面剔除漏掉交点，因此按 DoubleSide 求交后取沿方向、位于中心前方的
  // 第一个表面点，即朝该方向的外表面
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const startOffset = Math.max(size.x, size.y, size.z, 1) * 0.6;
  localRay.origin.copy(center).addScaledVector(direction, -startOffset);
  localRay.direction.copy(direction);

  const worldRay = localRay.clone().applyMatrix4(root.matrixWorld);
  const hits = raycastDoubleSided(root, worldRay).filter((entry) => {
    const localPoint = entry.point.clone().applyMatrix4(tmpMatrix.copy(root.matrixWorld).invert());
    return localPoint.clone().sub(center).dot(direction) > 1e-4;
  });
  const hit = hits[0];
  if (hit) {
    return worldHitToLocal(hit, root);
  }

  // 几何体未命中（极端退化情况）时退回到包围盒表面
  const localHit = new THREE.Vector3();
  if (localRay.intersectBox(box, localHit)) {
    return {
      position: vectorToTuple(localHit),
      normal: vectorToTuple(direction)
    };
  }

  return undefined;
}

/**
 * 临时把模型材质切换为 DoubleSide 进行求交：
 * 射线起点在封闭网格内部时，默认背面剔除会让交点全部丢失。
 */
function raycastDoubleSided(root: THREE.Object3D, worldRay: THREE.Ray): THREE.Intersection[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
  });

  const originalSides = new Map<THREE.Material, THREE.Side>();
  const touchedMaterials = new Set<THREE.Material>();
  for (const mesh of meshes) {
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      if (!touchedMaterials.has(material)) {
        originalSides.set(material, material.side);
        material.side = THREE.DoubleSide;
        touchedMaterials.add(material);
      }
    }
  }

  raycaster.set(worldRay.origin, worldRay.direction);
  raycaster.far = Infinity;
  const hits = meshes.length > 0 ? raycaster.intersectObjects(meshes, false) : [];

  for (const material of touchedMaterials) {
    material.side = originalSides.get(material) ?? THREE.FrontSide;
  }

  return hits;
}

/** 由屏幕点击在模型表面取点，返回模型本地坐标与本地法线（标注随模型一起旋转） */
export function pickSurfacePoint(
  event: PointerEvent | MouseEvent,
  domElement: HTMLElement,
  camera: THREE.Camera,
  root: THREE.Object3D
): SurfaceHit | undefined {
  const rect = domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  raycaster.far = Infinity;
  const hit = raycaster.intersectObject(root, true)[0];
  if (!hit) return undefined;
  return worldHitToLocal(hit, root);
}

function worldHitToLocal(hit: THREE.Intersection, root: THREE.Object3D): SurfaceHit {
  root.updateWorldMatrix(true, false);
  tmpMatrix.copy(root.matrixWorld).invert();
  const localPoint = hit.point.clone().applyMatrix4(tmpMatrix);

  let localNormal: THREE.Vector3;
  if (hit.face) {
    localNormal = hit.face.normal.clone();
    const object = hit.object;
    if (object instanceof THREE.Mesh) {
      localNormal.transformDirection(object.matrixWorld);
    }
    // 世界法线 → 根节点本地法线（模型只有旋转与统一缩放，方向矩阵即可）
    localNormal.transformDirection(tmpMatrix);
  } else {
    localNormal = approximateLocalNormal(hit, root);
  }
  if (localNormal.lengthSq() < 1e-6) {
    localNormal = approximateLocalNormal(hit, root);
  }

  return {
    position: vectorToTuple(localPoint),
    normal: vectorToTuple(localNormal.normalize())
  };
}

function approximateLocalNormal(hit: THREE.Intersection, root: THREE.Object3D): THREE.Vector3 {
  tmpMatrix.copy(root.matrixWorld).invert();
  const localPoint = hit.point.clone().applyMatrix4(tmpMatrix);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(tmpVector);
  const normal = localPoint.clone().sub(center);
  if (normal.lengthSq() < 1e-6) normal.set(0, 0, 1);
  return normal.normalize();
}

/** 标注锚点在模型本地空间中的位置，沿法线外移 lift 防止图标嵌入表面 */
export function getAnchorLocalPosition(annotation: Annotation, lift = 0.06): THREE.Vector3 {
  const point = tupleToVector(annotation.position);
  if (annotation.normal) {
    tmpNormal.copy(tupleToVector(annotation.normal));
    if (tmpNormal.lengthSq() > 1e-6) {
      point.addScaledVector(tmpNormal.normalize(), lift);
    }
  }
  return point;
}

/** 本地锚点 → 世界坐标 */
export function localAnchorToWorld(localPosition: THREE.Vector3, root: THREE.Object3D): THREE.Vector3 {
  root.updateWorldMatrix(true, false);
  return root.localToWorld(localPosition.clone());
}

/** 本地法线 → 世界法线 */
export function localNormalToWorld(localNormal: Vector3Tuple, root: THREE.Object3D): THREE.Vector3 {
  root.updateWorldMatrix(true, false);
  root.matrixWorld.decompose(tmpVector, tmpQuaternion, tmpScale);
  return tupleToVector(localNormal).applyQuaternion(tmpQuaternion).normalize();
}

export interface ProjectedAnchor {
  x: number;
  y: number;
  /** 在相机前方、未转到背面、未超出屏幕 */
  visible: boolean;
  /** 锚点表面是否朝向相机（背面时为 false） */
  facing: boolean;
  distance: number;
  worldPosition: THREE.Vector3;
}

/** 计算标注的屏幕位置，以及基于朝向 / 距离的可见性 */
export function projectAnchor(
  annotation: Annotation,
  root: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
  hideDistance: number
): ProjectedAnchor {
  const local = getAnchorLocalPosition(annotation);
  const world = localAnchorToWorld(local, root);

  const cameraForward = new THREE.Vector3();
  camera.getWorldDirection(cameraForward);
  const fromCamera = new THREE.Vector3().subVectors(world, camera.position);
  const distance = fromCamera.length();
  // 点在相机视锥前方：相机朝向 · (锚点 - 相机) > 0
  const inView = distance < 1e-6 || cameraForward.dot(fromCamera.normalize()) > 0;

  // 表面朝向相机：法线 · (相机 - 锚点) > 0（转到背面时为 false）
  let facing = true;
  if (annotation.normal) {
    const worldNormal = localNormalToWorld(annotation.normal, root);
    const toCamera = new THREE.Vector3().subVectors(camera.position, world);
    facing = toCamera.lengthSq() < 1e-6 || worldNormal.dot(toCamera.normalize()) > 0.02;
  }
  const closeEnough = distance <= hideDistance;

  const projected = world.clone().project(camera);
  const inFront = projected.z < 1;
  const onScreen = projected.x > -1.15 && projected.x < 1.15 && projected.y > -1.15 && projected.y < 1.15;

  return {
    x: (projected.x * 0.5 + 0.5) * width,
    y: (-projected.y * 0.5 + 0.5) * height,
    visible: inFront && inView && facing && closeEnough && onScreen,
    facing,
    distance,
    worldPosition: world
  };
}

/** 锚点是否被模型自身遮挡（用于背面之外的精确遮挡判断） */
export function isAnchorOccluded(worldPosition: THREE.Vector3, root: THREE.Object3D, camera: THREE.Camera): boolean {
  const direction = new THREE.Vector3().subVectors(camera.position, worldPosition);
  const distance = direction.length();
  if (distance < 0.2) return false;
  raycaster.set(worldPosition, direction.normalize());
  raycaster.far = Math.max(0, distance - 0.08);
  return raycaster.intersectObject(root, true).length > 0;
}

/** 计算聚焦标注时的相机落点：沿表面法线退到模型外侧 */
export function getFocusCameraPosition(
  annotation: Annotation,
  root: THREE.Object3D,
  distance = 3
): { position: THREE.Vector3; target: THREE.Vector3 } | undefined {
  const local = getAnchorLocalPosition(annotation, 0.02);
  const target = localAnchorToWorld(local, root);
  const worldNormal = annotation.normal
    ? localNormalToWorld(annotation.normal, root)
    : new THREE.Vector3().subVectors(cameraHintPosition(), target).normalize();

  const position = target.clone().addScaledVector(worldNormal, distance);
  clampPolarAngle(position, target, Math.PI * 0.48);
  return { position, target };
}

function cameraHintPosition(): THREE.Vector3 {
  return new THREE.Vector3(0, 1.6, 5.6);
}

function clampPolarAngle(position: THREE.Vector3, target: THREE.Vector3, maxPolar: number): void {
  const offset = new THREE.Vector3().subVectors(position, target);
  const length = offset.length();
  const horizontal = Math.hypot(offset.x, offset.z);
  const polar = Math.atan2(horizontal, offset.y);
  if (polar <= maxPolar) return;

  const clampedHorizontal = length * Math.sin(maxPolar);
  const scale = horizontal > 1e-6 ? clampedHorizontal / horizontal : 0;
  offset.x *= scale;
  offset.z *= scale;
  offset.y = length * Math.cos(maxPolar);
  position.copy(target).add(offset);
}

function vectorToTuple(vector: THREE.Vector3): Vector3Tuple {
  return { x: vector.x, y: vector.y, z: vector.z };
}

function tupleToVector(tuple: Vector3Tuple): THREE.Vector3 {
  return new THREE.Vector3(tuple.x, tuple.y, tuple.z);
}
