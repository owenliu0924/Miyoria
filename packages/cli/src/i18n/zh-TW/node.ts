import type { node as en } from "../en/node.js";

export const node: typeof en = {
  noConfig: (file) => `找不到 ${file}。請先執行 \`miyoria init\` 建立設定。`,
  chatting: (name) => `正在與 ${name} 對話(按 Ctrl+C 結束)。`,
  hereOrCollection: "--here 與 --collection 只能擇一使用。",
  noProfileConflict: "--no-profile 不能與 --profile、--profile-settings 同時使用。",
  obsStep: (description, dryRun) => `  ${dryRun ? "將會:" : ""}${description}`,
  obsWhere: (collection, profile) => `場景集合「${collection}」、設定檔「${profile}」`,
  layoutUnknown: (collection) =>
    `  (場景集合「${collection}」已存在,需切換過去才能讀取其內容;實際執行時只會補上缺少的部分)`,
  obsPreview: (steps, where) =>
    `預覽完成:${steps === null ? "OBS 已是此版面" : `${steps} 個步驟`},位於${where}(未變更 OBS)`,
  obsUnchanged: (where) => `OBS 已是此版面(${where}),僅更新遮罩`,
  obsBuilt: (where, steps) => `OBS 版面已建立於${where}(${steps} 個步驟)`,
  newProfileEmpty: (profile) =>
    `新的設定檔「${profile}」是空白的。若要從 OBS 推流,請在此設定檔中重新設定串流金鑰(設定 → 串流)與編碼器(設定 → 輸出)。`,
  vtubeTransparent: (source) =>
    `VTube Studio 須使用透明背景:背景選擇純色並勾選「透明」,OBS 的「${source}」來源才會只顯示角色。`,
  addToStageObs:
    "請在 miyoria.toml 的 [stage.obs] 加入以下幾行,Stage 才會確認 OBS 使用角色的場景集合(若不是,Stage 不會建立任何內容,並在管理面板中提示):",
  collectionMismatch: (configured, used) =>
    `[stage.obs] collection 為「${configured}」,但本次建立於「${used}」:OBS 停留在該場景集合時,Stage 不會建立任何內容。`,
  profileSummary: (title, id, sections, examples, voice, avatar) =>
    `${title}(${id}):${sections} 個人格段落、${examples} 個範例對話,聲音設定${voice ? "有" : "無"},模型設定${avatar ? "有" : "無"}`,
  created: (path) => `已建立 ${path}`,
  installed: (id, dir) => `已安裝 ${id} 至 ${dir}`,
  errors: (n) => `${n} 個錯誤`,
  manifestValid: "manifest 有效",
};
