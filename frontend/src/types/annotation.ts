export interface Vector3Tuple {
  x: number;
  y: number;
  z: number;
}

export type AnnotationIcon = 'detail' | 'material' | 'history' | 'technique';

/** surface：吸附在模型表面的 3D 标注；legacy：旧版相对屏幕的悬浮标注 */
export type AnnotationAnchorMode = 'surface' | 'legacy';

export interface Annotation {
  id: string;
  artifactId: string;
  position: Vector3Tuple;
  /** surface 模式下记录命中点的表面法线，用于把图标抬升到表面外侧 */
  normal?: Vector3Tuple;
  anchorMode?: AnnotationAnchorMode;
  title: string;
  content: string;
  iconType: AnnotationIcon;
  createdAt: string;
  updatedAt: string;
}

export type AnnotationDraft = Omit<Annotation, 'id' | 'createdAt' | 'updatedAt'>;
