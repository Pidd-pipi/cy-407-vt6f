import { defineStore } from 'pinia';
import { annotationRepository } from '@/api/storage';
import type { Annotation, AnnotationDraft, Vector3Tuple } from '@/types';
import { createId } from '@/utils/storage';

export interface AnchorUpgradePayload {
  id: string;
  position: Vector3Tuple;
  normal: Vector3Tuple;
}

const seedAnnotations: Annotation[] = [
  {
    id: 'annotation-ceramic-foot',
    artifactId: 'artifact-ceramic-jar',
    position: { x: -0.35, y: -0.42, z: 0.28 },
    title: '圈足修坯',
    content: '圈足边缘经过二次修坯，保留手工刀痕，能判断成型工序。',
    iconType: 'technique',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'annotation-embroidered-thread',
    artifactId: 'artifact-embroidered-panel',
    position: { x: 0.22, y: 0.24, z: 0.34 },
    title: '盘金线',
    content: '金线并不穿透底布，而是由细线固定在表面，形成浮雕感。',
    iconType: 'material',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'annotation-lacquer-shell',
    artifactId: 'artifact-lacquer-box',
    position: { x: 0.18, y: 0.12, z: 0.46 },
    title: '螺钿折光',
    content: '贝片角度不同会产生冷暖变化，3D 视角可辅助说明折光效果。',
    iconType: 'detail',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

export const useAnnotationStore = defineStore('annotation', {
  state: () => ({
    annotations: [] as Annotation[],
    loaded: false
  }),
  getters: {
    byArtifactId: (state) => (artifactId: string) =>
      state.annotations.filter((annotation) => annotation.artifactId === artifactId)
  },
  actions: {
    async load() {
      const records = await annotationRepository.list();
      if (records.length === 0) {
        await annotationRepository.saveMany(seedAnnotations);
        this.annotations = seedAnnotations;
      } else {
        this.annotations = records;
      }
      this.loaded = true;
    },
    async addAnnotation(draft: AnnotationDraft) {
      const now = new Date().toISOString();
      const annotation: Annotation = {
        ...draft,
        id: createId('annotation'),
        createdAt: now,
        updatedAt: now
      };
      this.annotations.push(annotation);
      await annotationRepository.save(annotation);
      return annotation;
    },
    async updateAnnotation(id: string, patch: Partial<AnnotationDraft>) {
      const current = this.annotations.find((annotation) => annotation.id === id);
      if (!current) return;
      const updated: Annotation = { ...current, ...patch, updatedAt: new Date().toISOString() };
      this.annotations = this.annotations.map((annotation) => (annotation.id === id ? updated : annotation));
      await annotationRepository.save(updated);
    },
    /** 旧版悬浮标注升级为表面标注后批量回写 */
    async upgradeAnchors(upgrades: AnchorUpgradePayload[]) {
      if (upgrades.length === 0) return;
      const now = new Date().toISOString();
      const upgradedMap = new Map(upgrades.map((upgrade) => [upgrade.id, upgrade]));
      const updatedList = this.annotations.map((annotation) => {
        const upgrade = upgradedMap.get(annotation.id);
        if (!upgrade || annotation.anchorMode === 'surface') return annotation;
        return {
          ...annotation,
          position: { ...upgrade.position },
          normal: { ...upgrade.normal },
          anchorMode: 'surface' as const,
          updatedAt: now
        };
      });
      const changed = updatedList.filter((annotation, index) => annotation !== this.annotations[index]);
      if (changed.length === 0) return;
      this.annotations = updatedList;
      await Promise.all(changed.map((annotation) => annotationRepository.save(annotation)));
    },
    async deleteAnnotation(id: string) {
      this.annotations = this.annotations.filter((annotation) => annotation.id !== id);
      await annotationRepository.remove(id);
    }
  }
});
