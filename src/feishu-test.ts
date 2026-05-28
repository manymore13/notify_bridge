import axios from "axios";

const APP_ID = "cli_aa9fe0750a7c9bc4";
const APP_SECRET = "BXc1QoE1YGEvNQ2TfYMDGh55yVXtEX4Y";

async function main() {
  console.log("=== 飞书 API 连通性测试 ===\n");

  // Test 1: Get tenant access token
  console.log("[1/4] 获取 tenant_access_token...");
  const tokenRes = await axios.post(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    { app_id: APP_ID, app_secret: APP_SECRET }
  );
  if (tokenRes.data.code !== 0) {
    console.log(`  FAIL: code=${tokenRes.data.code} msg=${tokenRes.data.msg}`);
    process.exit(1);
  }
  const token = tokenRes.data.tenant_access_token;
  console.log(`  PASS (token: ${token.slice(0, 16)}...)\n`);

  // Test 2: Check app scopes
  console.log("[2/4] 查询应用权限范围...");
  try {
    const scopeRes = await axios.get(
      "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`  code: ${scopeRes.data.code}, msg: ${scopeRes.data.msg || "ok"}`);
  } catch (e: any) {
    console.log(`  无法查询权限 (${e.response?.status}), 继续...`);
  }

  // Test 3: Try to list users
  console.log("[3/4] 尝试查询用户列表...");
  try {
    const res = await axios.get(
      "https://open.feishu.cn/open-apis/contact/v3/users",
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { page_size: 5, user_id_type: "open_id" },
      }
    );
    if (res.data.code === 0) {
      const users = res.data.data?.items || [];
      console.log(`  PASS: 找到 ${users.length} 个用户`);
      for (const u of users.slice(0, 3)) {
        console.log(`    - ${u.name} | open_id: ${u.open_id} | email: ${u.email || "N/A"}`);
      }
      if (users.length > 0) {
        console.log(`\n  >>> 请将 config.json 的 receiveId 设为: ${users[0].open_id}`);
        console.log(`  >>> receiveIdType 设为: open_id`);
      }
    } else {
      console.log(`  code: ${res.data.code}, msg: ${res.data.msg}`);
      console.log("  提示: 需要在飞书开放平台开启 contact 权限");
    }
  } catch (e: any) {
    console.log(`  HTTP ${e.response?.status}: ${e.response?.data?.msg || e.message}`);
    console.log("  提示: 需在飞书开放平台为该应用开启通讯录权限");
  }

  // Test 4: Try to send a test message (this will fail if receiveId is wrong, which is expected)
  console.log("[4/4] 尝试发送测试消息 (需要先配置 receiveId)...");
  console.log("  跳过（需要在 config.json 配置正确的 receiveId 后才能测试）");
  console.log("");

  console.log("=== 飞书 Token 获取正常，接下来 ===");
  console.log("");
  console.log("获取 receiveId 的方法：");
  console.log("1. 飞书管理后台 → 成员与部门 → 点击你的头像 → 查看 open_id");
  console.log("2. 或者用你的飞书邮箱，设 receiveIdType 为 email");
  console.log("3. 运行: npx tsx src/feishu-lookup.ts email YOUR_EMAIL@example.com");
  console.log("");
  console.log("然后将 receiveId 和 receiveIdType 填入 config.json");
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
