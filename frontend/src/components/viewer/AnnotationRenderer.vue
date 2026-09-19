<template>
  <div class="annotation-layer">
    <button
      v-for="pin in pins"
      :key="pin.annotation.id"
      type="button"
      class="annotation-pin"
      :class="[pin.annotation.iconType, { active: pin.active, hidden: pin.hidden }]"
      :style="{ left: `${pin.x}px`, top: `${pin.y}px` }"
      :title="pin.annotation.title"
      @click="$emit('select', pin.annotation.id)"
    >
      <span>{{ iconMap[pin.annotation.iconType] }}</span>
      <strong>{{ pin.annotation.title }}</strong>
    </button>
  </div>
</template>

<script setup lang="ts">
import type { Annotation } from '@/types';
import type { AnnotationPinState } from '@/utils/annotation-anchor';

withDefaults(
  defineProps<{
    pins: AnnotationPinState[];
  }>(),
  {
    pins: () => []
  }
);

defineEmits<{
  select: [id: string];
}>();

const iconMap = {
  detail: '细',
  material: '材',
  history: '史',
  technique: '工'
};
</script>

<style scoped>
.annotation-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.annotation-pin {
  position: absolute;
  display: inline-flex;
  align-items: center;
  max-width: min(240px, 42vw);
  gap: 8px;
  padding: 6px 9px 6px 6px;
  color: #173f35;
  background: rgba(251, 245, 232, 0.92);
  border: 1px solid rgba(157, 123, 54, 0.42);
  border-radius: 999px;
  box-shadow: 0 14px 28px rgba(31, 46, 41, 0.14);
  cursor: pointer;
  pointer-events: auto;
  transform: translate(-50%, -50%);
  transition:
    opacity 180ms ease,
    scale 180ms ease;
}

.annotation-pin span {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  color: #fbf5e8;
  background: #bb4d3e;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 800;
}

.annotation-pin.material span {
  background: #9d7b36;
}

.annotation-pin.history span {
  background: #3f5f96;
}

.annotation-pin.technique span {
  background: #173f35;
}

.annotation-pin strong {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.annotation-pin.active {
  border-color: #bb4d3e;
  box-shadow: 0 0 0 2px rgba(187, 77, 62, 0.35), 0 14px 28px rgba(31, 46, 41, 0.18);
}

.annotation-pin.hidden {
  opacity: 0;
  scale: 0.6;
  pointer-events: none;
}
</style>
