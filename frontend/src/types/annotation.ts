export interface Vector3Tuple {
  x: number;
  y: number;
  z: number;
}

export type AnnotationIcon = 'detail' | 'material' | 'history' | 'technique';

export interface Annotation {
  id: string;
  artifactId: string;
  position: Vector3Tuple;
  /** 模型局部空间下的表面外法线，用于判断正面/遮挡与飞行视角；旧标注可能没有该字段 */
  normal?: Vector3Tuple;
  title: string;
  content: string;
  iconType: AnnotationIcon;
  createdAt: string;
  updatedAt: string;
}

export type AnnotationDraft = Omit<Annotation, 'id' | 'createdAt' | 'updatedAt'>;
