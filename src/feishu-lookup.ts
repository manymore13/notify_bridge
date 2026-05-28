#!/usr/bin/env node

import axios from "axios";

const APP_ID = process.env.FEISHU_APP_ID || "";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "";

async function getToken(): Promise<string> {
  const res = await axios.post(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    { app_id: APP_ID, app_secret: APP_SECRET }
  );
  if (res.data.code !== 0) {
    throw new Error(`获取token失败: ${res.data.msg}`);
  }
  return res.data.tenant_access_token;
}

async function lookupByEmail(token: string, email: string) {
  const res = await axios.post(
    "https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id",
    { emails: [email] },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data;
}

async function lookupByMobile(token: string, mobile: string) {
  const res = await axios.post(
    "https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id",
    { mobiles: [mobile] },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data;
}

async function main() {
  const args = process.argv.slice(2);
  const method = args[0];
  const value = args[1];

  if (!method || !value) {
    console.log("用法:");
    console.log("  npx tsx src/feishu-lookup.ts email user@example.com");
    console.log("  npx tsx src/feishu-lookup.ts mobile 13800138000");
    console.log("");
    console.log("环境变量: FEISHU_APP_ID, FEISHU_APP_SECRET");
    process.exit(1);
  }

  console.log("正在获取 access token...");
  const token = await getToken();

  console.log(`正在查找 ${method}: ${value}...`);
  const result = method === "email"
    ? await lookupByEmail(token, value)
    : await lookupByMobile(token, value);

  console.log(JSON.stringify(result, null, 2));

  if (result.data?.user_list?.length > 0) {
    const user = result.data.user_list[0];
    console.log(`\n✅ 找到用户:`);
    console.log(`   open_id: ${user.user_id}`);
    console.log(`   请将 receiveId 更新为: ${user.user_id}`);
    console.log(`   receiveIdType 设为: open_id`);
  } else {
    console.log("\n❌ 未找到用户，请检查邮箱/手机号是否正确");
  }
}

main().catch((err) => {
  console.error("错误:", err.message);
  process.exit(1);
});
