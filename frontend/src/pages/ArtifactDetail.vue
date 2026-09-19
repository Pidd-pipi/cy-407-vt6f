<template>
  <section v-if="artifact" class="detail-page">
    <div class="page-head">
      <div>
        <h1>{{ artifact.name }}</h1>
        <p>独立模型查看器支持 360° 旋转、缩放和标注定位，适合讲解工艺细节。</p>
      </div>
      <RouterLink class="back-link" to="/">返回展厅</RouterLink>
    </div>

    <div class="detail-grid">
      <ModelViewer
        :artifact="artifact"
        :annotations="annotations"
        :focus-request="focusRequest"
        :picking="picking"
        @annotation-select="focusFromViewer"
        @surface-pick="handleSurfacePick"
        @anchors-upgraded="handleAnchorsUpgraded"
      />
      <div class="detail-side">
        <InfoPanel :artifact="artifact" :annotations="annotations" @annotation-click="focusFromList" />
        <section class="panel-surface annotation-editor">
          <header>
            <h3>添加 3D 标注</h3>
            <small>坐标吸附在模型本地表面</small>
          </header>
          <n-button :type="picking ? 'error' : 'primary'" secondary @click="togglePicking">
            {{ picking ? '退出取点' : '在模型表面取点' }}
          </n-button>
          <p v-if="picking" class="picking-tip">在左侧模型上点击要标注的位置，坐标会自动填入；展板类展品同样支持。</p>
          <p v-else-if="lastPick" class="picking-tip done">已取点：({{ formatAxis(lastPick.position.x) }}, {{ formatAxis(lastPick.position.y) }}, {{ formatAxis(lastPick.position.z) }})</p>
          <div class="axis-grid">
            <n-input-number v-model:value="draft.position.x" size="small" :step="0.1" placeholder="X" />
            <n-input-number v-model:value="draft.position.y" size="small" :step="0.1" placeholder="Y" />
            <n-input-number v-model:value="draft.position.z" size="small" :step="0.1" placeholder="Z" />
          </div>
          <n-input v-model:value="draft.title" placeholder="标注标题" />
          <n-input v-model:value="draft.content" type="textarea" placeholder="讲解内容" :autosize="{ minRows: 3, maxRows: 5 }" />
          <n-select v-model:value="draft.iconType" :options="iconOptions" />
          <n-button type="primary" @click="addAnnotation">保存标注</n-button>
          <n-alert v-if="selectedAnnotation" type="info" :bordered="false">
            当前选中：{{ selectedAnnotation.title }}
            <template #action>
              <n-button quaternary type="error" size="small" @click="annotationStore.deleteAnnotation(selectedAnnotation.id)">
                删除
              </n-button>
            </template>
          </n-alert>
        </section>
      </div>
    </div>
  </section>
  <n-result v-else status="404" title="展品不存在" description="请在展品库中选择已有展品。" />
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useMessage } from 'naive-ui';
import InfoPanel from '@/components/common/InfoPanel.vue';
import ModelViewer, { type AnchorUpgrade } from '@/components/viewer/ModelViewer.vue';
import { useAnnotationStore } from '@/stores/annotation';
import { useArtifactStore } from '@/stores/artifact';
import type { AnnotationDraft, AnnotationIcon } from '@/types';
import type { SurfaceHit } from '@/utils/annotation-anchor';

const route = useRoute();
const message = useMessage();
const artifactStore = useArtifactStore();
const annotationStore = useAnnotationStore();
const selectedAnnotationId = ref('');
const focusRequest = ref<{ id: string; nonce: number } | undefined>(undefined);
const focusNonce = ref(0);
const picking = ref(false);
const lastPick = ref<SurfaceHit | null>(null);

const artifact = computed(() => artifactStore.getById(String(route.params.id ?? '')));
const annotations = computed(() => (artifact.value ? annotationStore.byArtifactId(artifact.value.id) : []));
const selectedAnnotation = computed(() => annotations.value.find((annotation) => annotation.id === selectedAnnotationId.value));

const draft = reactive<AnnotationDraft>({
  artifactId: '',
  position: { x: 0.1, y: 0.2, z: 0.35 },
  normal: undefined,
  anchorMode: 'surface',
  title: '',
  content: '',
  iconType: 'detail'
});

const iconOptions: { label: string; value: AnnotationIcon }[] = [
  { label: '细节', value: 'detail' },
  { label: '材质', value: 'material' },
  { label: '历史', value: 'history' },
  { label: '工艺', value: 'technique' }
];

function togglePicking() {
  picking.value = !picking.value;
}

function handleSurfacePick(hit: SurfaceHit) {
  lastPick.value = hit;
  draft.position = { ...hit.position };
  draft.normal = { ...hit.normal };
  draft.anchorMode = 'surface';
  picking.value = false;
  message.success('已记录表面位置，可补充标题后保存');
}

/** 从标注列表选中：高亮并把相机带到对应表面 */
function requestFocus(id: string) {
  selectedAnnotationId.value = id;
  focusNonce.value += 1;
  focusRequest.value = { id, nonce: focusNonce.value };
}

function focusFromList(id: string) {
  requestFocus(id);
}

function focusFromViewer(id: string) {
  requestFocus(id);
}

function handleAnchorsUpgraded(upgrades: AnchorUpgrade[]) {
  void annotationStore.upgradeAnchors(upgrades);
}

function formatAxis(value: number) {
  return value.toFixed(2);
}

async function addAnnotation() {
  if (!artifact.value || !draft.title.trim()) {
    message.warning('请填写标注标题');
    return;
  }
  await annotationStore.addAnnotation({
    artifactId: artifact.value.id,
    position: { ...draft.position },
    normal: draft.normal ? { ...draft.normal } : undefined,
    anchorMode: 'surface',
    title: draft.title,
    content: draft.content,
    iconType: draft.iconType
  });
  draft.title = '';
  draft.content = '';
  draft.normal = undefined;
  draft.position = { x: 0, y: 0, z: 0 };
  lastPick.value = null;
  message.success('标注已保存到 IndexedDB');
}
</script>

<style scoped>
.detail-page {
  display: grid;
  gap: 20px;
}

.back-link {
  padding: 10px 14px;
  color: #fbf5e8;
  text-decoration: none;
  background: var(--museum-green);
  border-radius: 6px;
}

.detail-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(340px, 0.55fr);
  gap: 18px;
  align-items: start;
}

.detail-side {
  display: grid;
  gap: 14px;
}

.annotation-editor {
  display: grid;
  gap: 12px;
  padding: 16px;
}

.annotation-editor header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.annotation-editor h3,
.annotation-editor small {
  margin: 0;
}

.annotation-editor small {
  color: rgba(31, 46, 41, 0.6);
}

.picking-tip {
  margin: 0;
  padding: 8px 10px;
  color: #8a3a30;
  font-size: 12px;
  line-height: 1.5;
  background: rgba(187, 77, 62, 0.08);
  border: 1px solid rgba(187, 77, 62, 0.28);
  border-radius: 6px;
}

.picking-tip.done {
  color: var(--museum-green);
  background: rgba(23, 63, 53, 0.08);
  border-color: rgba(23, 63, 53, 0.25);
}

.axis-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

@media (max-width: 1080px) {
  .detail-grid {
    grid-template-columns: 1fr;
  }
}
</style>
