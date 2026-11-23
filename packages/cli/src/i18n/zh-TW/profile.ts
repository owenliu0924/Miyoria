import type { profile as en } from "../en/profile.js";

export const profile: typeof en = {
  noProfiles: (dir) => `${dir} 中沒有任何角色`,
  ownData: "自己的設定與資料",
  installData: "安裝資料夾的設定與資料",
  current: (line) => `目前的角色:${line}`,
  sourceEnv: (name) => `環境變數 ${name}`,
  sourceDefault: "預設",
  showSource: (value) => `  選擇    ${value}`,
  showConfig: (path) => `  設定    ${path}`,
  showData: (path) => `  資料    ${path}`,
  showPersona: (path) => `  人格    ${path}`,
  noInstall: (path) => `找不到 ${path}。請先執行 \`miyoria init\` 建立設定。`,
  notFolderName: (id) => `「${id}」不是有效的資料夾名稱`,
  notProfile: (dir) => `${dir} 不是角色資料夾(沒有 profile.toml)`,
  nextStart: (id, data) =>
    `Core 下次啟動時執行 ${id}(${data});執行中的 Core 需重新啟動才會切換:\`miyoria restart core\``,
  dataOwn: "使用它自己的設定與資料",
  dataOf: (path) => `使用 ${path} 的設定與資料`,
  envOverrides: (name, value) => `環境變數 ${name}=${value} 會覆蓋 core.profile`,
  badId: (id) => `「${id}」不能作為角色名稱:請使用小寫英文字母、數字、- 或 _`,
  exists: (dir) => `${dir} 已存在。不會覆寫任何現有的角色。`,
  created: (dir) => `已建立 ${dir}`,
  newPersona: (path) => `  人格    ${path}(identity.md、style.md:角色的身分與說話方式)`,
  newConfig: (path) => `  設定    ${path}([character]:角色的名稱與簡稱)`,
  newSecrets: (path) =>
    `  密碼    ${path}(此角色自己的 LLM 金鑰與 Discord token;不會使用其他角色的)`,
  newData: (path) => `  資料    ${path}`,
  newNext: (id) => `檔案準備好之後,執行 \`miyoria profile use ${id}\`,再重新啟動 Core`,
};
